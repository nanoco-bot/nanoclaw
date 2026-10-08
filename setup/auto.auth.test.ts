import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runAuth: vi.fn(),
  runInstallCheck: vi.fn(),
  fail: vi.fn(),
  upsertEnvVar: vi.fn(),
  brightSelect: vi.fn(),
  applyProviderSkill: vi.fn(),
  loadHostContractModules: vi.fn(),
  order: [] as string[],
  opencodeInstalled: true,
  /** The real claude entry (setup/providers/claude.ts) has no runAuth; most tests here keep one as a tripwire. */
  claudeHasRunAuth: true,
  runGatewayAuth: vi.fn(),
  quietSteps: [] as string[],
  /** Ordered record of the steps the order tests care about. */
  sequence: [] as string[],
  /** undefined = the real getPlatform(). */
  platform: undefined as string | undefined,
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => {
  const entry = {
    value: 'opencode',
    label: 'OpenCode',
    hint: '',
    runAuth: fixture.runAuth,
    runInstallCheck: fixture.runInstallCheck,
  };
  const claude = { ...entry, value: 'claude', label: 'Claude' };
  const realClaude = { value: 'claude', label: 'Claude', hint: '' };
  const entries = () => {
    const c = fixture.claudeHasRunAuth ? claude : realClaude;
    return fixture.opencodeInstalled ? [c, entry] : [c];
  };
  return {
    getSetupProvider: (name: string) => entries().find((provider) => provider.value === name),
    listSetupProviders: entries,
  };
});
vi.mock('./providers/install.js', () => ({
  applyProviderSkill: fixture.applyProviderSkill,
  loadHostContractModules: fixture.loadHostContractModules,
}));
vi.mock('./lib/container-build.js', () => ({
  buildContainerImage: () => {
    fixture.order.push('build');
    return { ok: true };
  },
}));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  readImageSource: () => 'local',
}));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({
  readEnvKey: () => undefined,
  // First thing after the service step (the cli-agent check): the order tests end the run here.
  detectRegisteredGroups: async () => {
    fixture.sequence.push('end');
    throw new Error('post-service boundary');
  },
}));
vi.mock('./platform.js', async (original) => {
  const real = await original<typeof import('./platform.js')>();
  return {
    ...real,
    getPlatform: () => fixture.platform ?? real.getPlatform(),
    // A mocked Mac is an Apple silicon one: OpenShell refuses Intel Macs.
    getArch: () => (fixture.platform === 'macos' ? 'arm64' : real.getArch()),
  };
});
vi.mock('./logs.js', () => ({ userInput: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  // Only the OpenShell tests below reach a quiet step; everything else here skips them.
  runQuietStep: async (step: string) => {
    fixture.quietSteps.push(step);
    fixture.sequence.push(`step:${step}`);
    return {
      ok: true,
      exitCode: 0,
      blocks: [],
      transcript: '',
      terminal: { type: 'X', fields: { STATUS: 'success' } },
    };
  },
}));
// Hermetic: never this checkout's own .env (NANOCLAW_SKIP=openshell reads it).
vi.mock('./openshell.js', async (original) => ({
  ...(await original<typeof import('./openshell.js')>()),
  readOpenShellEnv: () => ({}),
}));
// The OpenShell install step (windowed: it downloads); recorded like the quiet steps.
vi.mock('./lib/windowed-runner.js', () => ({
  runWindowedStep: async (step: string) => {
    fixture.quietSteps.push(step);
    fixture.sequence.push(`step:${step}`);
    return {
      ok: true,
      exitCode: 0,
      blocks: [],
      transcript: '',
      terminal: { type: 'X', fields: { STATUS: 'success' } },
    };
  },
}));
vi.mock('./gateways/install.js', async (original) => ({
  ...(await original<typeof import('./gateways/install.js')>()),
  runGatewayAuth: fixture.runGatewayAuth,
}));
vi.mock('./set-env.js', () => ({ upsertEnvVar: fixture.upsertEnvVar }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), step: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'opencode');
  vi.stubEnv('DEFAULT_AGENT_PROVIDER', 'claude');
  vi.stubEnv(
    'NANOCLAW_SKIP',
    'environment,openshell,container,gateway,mounts,service,cli-agent,timezone,channel,verify,first-chat',
  );
  fixture.runAuth.mockResolvedValue(undefined);
  fixture.runInstallCheck.mockResolvedValue(undefined);
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.opencodeInstalled = true;
  fixture.brightSelect.mockResolvedValue('opencode');
  fixture.applyProviderSkill.mockRejectedValue(new Error('installation boundary'));
  fixture.loadHostContractModules.mockImplementation(async () => {
    fixture.order.push('load-contracts');
  });
  fixture.order = [];
  fixture.claudeHasRunAuth = true;
  fixture.quietSteps = [];
  fixture.sequence = [];
  fixture.platform = undefined;
  fixture.runGatewayAuth.mockImplementation(() => {
    throw new Error('gateway auth boundary');
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('setup wizard provider authentication failures', () => {
  it.each(['runAuth', 'runInstallCheck'] as const)(
    'routes a %s error through assistance before aborting, without saving a default',
    async (callback) => {
      fixture[callback].mockRejectedValue(new Error(`${callback} failed`));
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(process, 'exit').mockImplementation((() => {
        finish();
      }) as typeof process.exit);
      await import('./auto.js');
      await exited;
      expect(fixture.runAuth).toHaveBeenCalledOnce();
      expect(fixture.fail).toHaveBeenCalledWith(
        'auth',
        "Couldn't authenticate or verify opencode.",
        `${callback} failed`,
      );
      expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(fixture.brightSelect).not.toHaveBeenCalled();
    },
  );
});

async function runWizardUntilExit(): Promise<void> {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    finish();
  }) as typeof process.exit);
  await import('./auto.js');
  await exited;
}

describe('setup wizard interactive provider choice', () => {
  it.each(['claude', 'opencode'])(
    'offers a choice with %s highlighted when no provider is preset',
    async (currentDefault) => {
      vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
      vi.stubEnv('DEFAULT_AGENT_PROVIDER', currentDefault);
      fixture.runAuth.mockRejectedValue(new Error('authentication boundary'));

      await runWizardUntilExit();

      expect(fixture.brightSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Which agent runtime should power your assistant?',
          initialValue: currentDefault,
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'claude' }),
            expect.objectContaining({ value: 'opencode' }),
          ]),
        }),
      );
      expect(fixture.fail).toHaveBeenCalledWith(
        'auth',
        "Couldn't authenticate or verify opencode.",
        'authentication boundary',
      );
      expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
    },
  );

  it('offers an uninstalled OpenCode skill on a fresh install and applies the selected skill', async () => {
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
    fixture.opencodeInstalled = false;
    fixture.runAuth.mockRejectedValue(new Error('unexpected Claude authentication'));

    await runWizardUntilExit();

    expect(fixture.brightSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: 'claude',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'opencode',
            label: 'OpenCode',
            hint: expect.stringContaining('installs now'),
          }),
        ]),
      }),
    );
    expect(fixture.applyProviderSkill).toHaveBeenCalledWith('.claude/skills/add-opencode', process.cwd());
    expect(fixture.fail).toHaveBeenCalledWith('add-opencode', "Couldn't install opencode.", 'installation boundary');
    expect(fixture.runAuth).not.toHaveBeenCalled();
    expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
  });

  // After a fresh in-wizard install the contract barrel is already in
  // this process's ESM cache, so the wizard hands the appended contract module
  // to the loader right after the rebuild, before the payload's setup module
  // and its auth step load. The loader throws here to end the run at that
  // point: the payload's setup module does not exist in a clean checkout.
  it('registers the installed host contract after the rebuild and before provider auth', async () => {
    fixture.opencodeInstalled = false;
    fixture.applyProviderSkill.mockResolvedValue({
      blockers: [],
      changed: true,
      hostContractModules: ['/install/src/provider-contracts/opencode.ts'],
    });
    fixture.loadHostContractModules.mockImplementation(async () => {
      fixture.order.push('load-contracts');
      throw new Error('contract boundary');
    });

    await runWizardUntilExit();

    expect(fixture.loadHostContractModules).toHaveBeenCalledWith(['/install/src/provider-contracts/opencode.ts']);
    expect(fixture.order).toEqual(['build', 'load-contracts']);
    expect(fixture.runAuth).not.toHaveBeenCalled();
    expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});

describe('setup wizard provider choice with OpenShell sandboxing', () => {
  // The real wizard path: OpenShell enabled by its flag, its quiet step stubbed,
  // the gateway step skipped (gatewayKind is still forced to openshell).
  function enableOpenShell(): void {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
    vi.stubEnv(
      'NANOCLAW_SKIP',
      'environment,container,gateway,mounts,service,cli-agent,timezone,channel,verify,first-chat',
    );
    fixture.claudeHasRunAuth = false; // as setup/providers/claude.ts registers it
  }

  it('resolves to claude without the picker, and Claude auth goes to the OpenShell gateway’s sign-in', async () => {
    enableOpenShell();
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');

    await runWizardUntilExit();

    expect(fixture.quietSteps).toEqual(['openshell', 'openshell-install']);
    expect(fixture.brightSelect).not.toHaveBeenCalled();
    expect(fixture.runGatewayAuth).toHaveBeenCalledWith('openshell', 'claude');
    expect(fixture.runAuth).not.toHaveBeenCalled();
    expect(fixture.applyProviderSkill).not.toHaveBeenCalled();
  });

  it('a claude preset is fine; still no picker', async () => {
    enableOpenShell();
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');

    await runWizardUntilExit();

    expect(fixture.brightSelect).not.toHaveBeenCalled();
    expect(fixture.runGatewayAuth).toHaveBeenCalledWith('openshell', 'claude');
  });

  it('a non-claude preset is refused with a clear error, not silently overridden', async () => {
    enableOpenShell();
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'opencode');

    await runWizardUntilExit();

    expect(fixture.fail).toHaveBeenCalledWith(
      'auth',
      "NANOCLAW_AGENT_PROVIDER=opencode can't be used with OpenShell sandboxing.",
      expect.stringMatching(/relays Claude credentials only/),
    );
    expect(fixture.brightSelect).not.toHaveBeenCalled();
    expect(fixture.runGatewayAuth).not.toHaveBeenCalled();
    expect(fixture.runAuth).not.toHaveBeenCalled();
    expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
  });

  it('without OpenShell the full picker is unchanged (claude and opencode offered)', async () => {
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
    fixture.claudeHasRunAuth = false;
    fixture.runAuth.mockRejectedValue(new Error('authentication boundary'));

    await runWizardUntilExit();

    expect(fixture.quietSteps).toEqual([]);
    expect(fixture.brightSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Which agent runtime should power your assistant?',
        options: expect.arrayContaining([
          expect.objectContaining({ value: 'claude' }),
          expect.objectContaining({ value: 'opencode' }),
        ]),
      }),
    );
  });
});

describe('setup wizard step order: agent auth vs the service step', () => {
  // mounts + service run (mocked); cli-agent is not skipped so the run ends at its check, right after service.
  const SKIP_BASE = 'environment,container,gateway,echo-reminder,timezone,channel,verify,first-chat';

  function recordAuth(): void {
    fixture.runGatewayAuth.mockImplementation((gateway: string, provider: string) => {
      fixture.sequence.push(`gateway-auth:${gateway}:${provider}`);
    });
    fixture.runAuth.mockImplementation(async () => {
      fixture.sequence.push('provider-auth');
    });
  }

  function openShell(platform: string): void {
    fixture.platform = platform;
    fixture.claudeHasRunAuth = false; // as setup/providers/claude.ts registers it
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
    vi.stubEnv('NANOCLAW_SKIP', SKIP_BASE);
    recordAuth();
  }

  function otherGateway(platform: string, gateway: string, provider: string): void {
    fixture.platform = platform;
    fixture.claudeHasRunAuth = false;
    vi.stubEnv('NANOCLAW_OPENSHELL', '');
    vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', gateway);
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', provider);
    vi.stubEnv('NANOCLAW_SKIP', `openshell,${SKIP_BASE}`);
    recordAuth();
  }

  it.each(['macos', 'linux'])('%s + OpenShell: auth before mounts and service, like every gateway', async (platform) => {
    openShell(platform);
    await runWizardUntilExit();
    expect(fixture.sequence).toEqual([
      'step:openshell',
      'step:openshell-install',
      'gateway-auth:openshell:claude',
      'step:mounts',
      'step:service',
      'end',
    ]);
    expect(fixture.upsertEnvVar).toHaveBeenCalledWith('DEFAULT_AGENT_PROVIDER', 'claude');
  });

  it.each([
    ['macos', 'onecli'],
    ['linux', 'onecli'],
    ['macos', 'iron-proxy'],
    ['linux', 'iron-proxy'],
  ])('%s + %s gateway (Claude via gateway auth): unchanged — auth, then mounts, then service', async (platform, gateway) => {
    otherGateway(platform, gateway, 'claude');
    await runWizardUntilExit();
    expect(fixture.sequence).toEqual([`gateway-auth:${gateway}:claude`, 'step:mounts', 'step:service', 'end']);
  });

  it.each(['macos', 'linux'])(
    '%s + a provider with its own auth (OpenCode): unchanged — auth before the service build',
    async (platform) => {
      otherGateway(platform, 'onecli', 'opencode');
      await runWizardUntilExit();
      expect(fixture.sequence).toEqual(['provider-auth', 'step:mounts', 'step:service', 'end']);
    },
  );
});

