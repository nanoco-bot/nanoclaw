/**
 * OpenShell through the real wizard (setup/auto.ts), with every step runner
 * stubbed and recorded in order:
 *   - the question (flag/env or an earlier `.env` answer) runs `--step openshell`
 *     without installing anything (`--no-gateway --no-install`);
 *   - after the container step, `openshell-install` installs OpenShell itself;
 *   - the gateway step then installs NanoClaw's `openshell` gateway skill;
 *   - at the very end, after verify, the setup UI starts without asking.
 * Unanswered without a TTY means no: none of it runs and the default gateway is
 * installed exactly as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StepResult = { ok: boolean; fields: Record<string, string> };
const fixture = vi.hoisted(() => ({
  select: vi.fn(),
  runSkill: vi.fn(async (_skill: string) => ({ deferred: [], agentTasks: [] })),
  /** Every step runner call (quiet or windowed) and skill run, in order. */
  sequence: [] as string[],
  args: {} as Record<string, string[]>,
  windowed: [] as string[],
  stepResult: {} as Record<string, StepResult>,
  info: [] as string[],
  warn: [] as string[],
  notes: [] as string[],
  outro: [] as string[],
  support: { ok: true } as { ok: true } | { ok: false; reason: string },
  fail: vi.fn(async (step: string, _msg?: string, _hint?: string) => {
    throw new Error(`fail:${step}`);
  }),
}));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.select }));
vi.mock('./lib/skill-driver.js', () => ({
  runSkill: async (skill: string) => {
    fixture.sequence.push(`skill:${path.basename(skill)}`);
    return fixture.runSkill(skill);
  },
}));
vi.mock('./gateways/selection.js', async (original) => ({
  ...(await original<typeof import('./gateways/selection.js')>()),
  detectInstalledGateway: () => undefined,
  isGatewayInstalled: () => false,
}));
vi.mock('./gateways/catalog.js', () => ({
  loadGatewayCatalog: () => ({
    default: 'onecli',
    gateways: ['onecli', 'iron-proxy', 'openshell'].map((kind) => ({
      kind,
      label: kind,
      skillPath: `/skills/${kind}`,
    })),
  }),
}));
vi.mock('./lib/setup-config-parse.js', async (original) => ({
  ...(await original<typeof import('./lib/setup-config-parse.js')>()),
  parseFlags: () => ({ help: false, errors: [], values: {} }),
}));
vi.mock('../src/community-portal/slack-job.js', () => ({
  withSetupLock: (run: () => Promise<void>) => run(),
  launchSlackJob: async () => {},
  readSlackJob: async () => null,
  slackJobStatus: () => undefined,
}));
vi.mock('./logs.js', () => ({ reset: vi.fn(), userInput: vi.fn(), complete: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/claude-handoff.js', () => ({ offerClaudeOnFailure: vi.fn(async () => false) }));
vi.mock('./openshell-install.js', async (original) => ({
  ...(await original<typeof import('./openshell-install.js')>()),
  hostSupport: () => fixture.support,
}));
function stub(step: string, args: string[]) {
  fixture.sequence.push(step);
  fixture.args[step] = args;
  const r = fixture.stepResult[step] ?? { ok: true, fields: { STATUS: 'success' } };
  return {
    ok: r.ok,
    exitCode: r.ok ? 0 : 1,
    blocks: [],
    transcript: '',
    terminal: { type: 'X', fields: r.fields },
    rawLog: `logs/setup-steps/${step}.log`,
    durationMs: 1,
  };
}
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: async (step: string, _labels: unknown, args: string[] = []) => stub(step, args),
}));
vi.mock('./lib/windowed-runner.js', () => ({
  runWindowedStep: async (step: string, _labels: unknown, args: string[] = []) => {
    fixture.windowed.push(step);
    return stub(step, args);
  },
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  // No confirm/text: any question the wizard asked would throw.
  note: (message: string, title?: string) => void fixture.notes.push(`${title ?? ''}: ${message}`),
  outro: (message: string) => {
    fixture.outro.push(message);
    throw new Error('end of setup');
  },
  log: {
    message: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
    warn: (m: string) => void fixture.warn.push(m),
    info: (m: string) => void fixture.info.push(m),
    // The gateway step's success line: runs that reach it end there.
    success: () => {
      fixture.sequence.push('gateway-ready');
      throw new Error('gateway boundary');
    },
  },
}));

/** Everything skipped except what OpenShell adds; the run ends at the gateway boundary. */
const SKIP_TO_GATEWAY = 'environment,container,auth,mounts,service,cli-agent,timezone,channel,verify,first-chat';
/** Everything but OpenShell and verify; the run goes to the end (outro). */
const SKIP_TO_END =
  'environment,container,gateway,auth,mounts,echo-reminder,service,cli-agent,timezone,channel,slack-reminder,first-chat';

let root: string;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.assign(fixture, {
    sequence: [],
    args: {},
    windowed: [],
    stepResult: {},
    info: [],
    warn: [],
    notes: [],
    outro: [],
    support: { ok: true },
  });
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-openshell-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '');
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
  vi.stubEnv('NANOCLAW_TEMPLATE_PATH', '');
  vi.stubEnv('NANOCLAW_OPENSHELL', '');
  vi.stubEnv('OPENSHELL_BIN', '');
  vi.stubEnv('OPENSHELL_GATEWAY', '');
  vi.stubEnv('NANOCLAW_OPENSHELL_UI_PORT', '');
  vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_GATEWAY);
  fixture.select.mockResolvedValueOnce('default');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function runWizard(): Promise<void> {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    finish();
  }) as typeof process.exit);
  // Every run ends in a rejection (gateway boundary, a fail(), or the outro),
  // which main()'s own catch turns into process.exit.
  await import('./auto.js');
  await exited;
}

const readEnv = () => (fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '');

describe('OpenShell sandboxing through the real wizard', () => {
  it('unanswered without a TTY: no OpenShell step at all, default gateway unchanged', async () => {
    await runWizard();
    expect(fixture.sequence).toEqual(['skill:onecli', 'gateway-ready']);
    expect(readEnv()).not.toMatch(/NANOCLAW_RUNTIME_DRIVER/);
  });

  it('NANOCLAW_OPENSHELL=true: enable (nothing installed yet), install OpenShell, then the openshell gateway skill', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('OPENSHELL_BIN', '/opt/openshell/bin/openshell');
    vi.stubEnv('OPENSHELL_GATEWAY', 'lab');
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'openshell-install', 'skill:openshell', 'gateway-ready']);
    expect(fixture.args.openshell).toEqual([
      '--enable',
      '--no-gateway',
      '--no-install',
      '--bin',
      '/opt/openshell/bin/openshell',
      '--gateway',
      'lab',
    ]);
    // A first install downloads a package and the gateway's images: the windowed runner.
    expect(fixture.windowed).toEqual(['openshell-install']);
    expect(fixture.runSkill).not.toHaveBeenCalledWith('/skills/onecli');
  });

  it('the install runs after the container step (OpenShell’s gateway needs Docker) and before the gateway step', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
    vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_GATEWAY.replace('container,', ''));
    // Image source already decided, so the container step asks nothing.
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_HARDENED_IMAGE=false\n');
    await runWizard();
    expect(fixture.sequence).toEqual([
      'openshell',
      'container',
      'openshell-install',
      'skill:openshell',
      'gateway-ready',
    ]);
  });

  it('a failed container step stops setup before OpenShell is installed', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
    vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_GATEWAY.replace('container,', ''));
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_HARDENED_IMAGE=false\n');
    fixture.stepResult.container = { ok: false, fields: { STATUS: 'failed', ERROR: 'runtime_not_available' } };
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'container']);
  });

  it('an earlier answer in .env is kept on re-run without asking, and installs', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\nOPENSHELL_BIN=/usr/bin/openshell\n');
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'openshell-install', 'skill:openshell', 'gateway-ready']);
    expect(fixture.args.openshell).toEqual(['--enable', '--no-gateway', '--no-install', '--bin', '/usr/bin/openshell']);
  });

  it('a failed install stops setup with its message and hint; the gateway is never installed', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    fixture.stepResult['openshell-install'] = {
      ok: false,
      fields: {
        STATUS: 'failed',
        ERROR: 'gateway_not_registered',
        MESSAGE: "OpenShell is installed, but its gateway isn't running or registered.",
        HINT: 'Run `systemctl --user enable --now openshell-gateway`, then `openshell gateway add …`.',
      },
    };
    await runWizard();
    expect(fixture.fail).toHaveBeenCalledWith(
      'openshell-install',
      "OpenShell is installed, but its gateway isn't running or registered.",
      expect.stringContaining('systemctl --user enable --now openshell-gateway'),
      'logs/setup-steps/openshell-install.log',
    );
    expect(fixture.sequence).not.toContain('skill:openshell');
  });

  it('a gateway missing NanoClaw’s mount settings: the hint is the full multi-line TOML to add', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    fixture.stepResult['openshell-install'] = {
      ok: false,
      fields: { STATUS: 'failed', ERROR: 'gateway_config', MESSAGE: 'refuses mounts', HINT: 'one line' },
    };
    await runWizard();
    const hint = fixture.fail.mock.calls[0][2] as string;
    expect(hint).toContain(
      '[openshell.drivers.docker]\nallow_driver_config = true\nenable_bind_mounts = true\n\n[openshell.drivers.docker.resource_admission]\nenabled = false',
    );
  });

  it('install warnings are surfaced, not fatal', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    fixture.stepResult['openshell-install'] = { ok: true, fields: { STATUS: 'success', WARNINGS: '1' } };
    await runWizard();
    expect(fixture.warn.join('\n')).toMatch(/openshell-install\.log/);
    expect(fixture.sequence).toContain('skill:openshell');
  });

  it('refuses OpenShell together with an explicitly chosen other gateway', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'iron-proxy');
    await runWizard();
    expect(fixture.fail).toHaveBeenCalledWith(
      'openshell',
      expect.stringMatching(/'iron-proxy' was selected/),
      expect.any(String),
    );
    expect(fixture.sequence).toEqual([]);
  });

  it('an Intel Mac that chooses OpenShell anyway stops with the reason; nothing runs or is written', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    fixture.support = {
      ok: false,
      reason: "OpenShell doesn't support Intel Macs: NVIDIA publishes it for Apple silicon Macs and Linux only.",
    };
    await runWizard();
    expect(fixture.fail).toHaveBeenCalledWith(
      'openshell',
      "OpenShell sandboxing isn't available on this machine.",
      expect.stringMatching(/Intel Macs.*NANOCLAW_OPENSHELL=false/s),
    );
    expect(fixture.sequence).toEqual([]);
    expect(readEnv()).toBe('');
  });

  it('an Intel Mac at a TTY is not asked (nothing to offer), is told why, and continues on Docker', async () => {
    fixture.support = { ok: false, reason: "OpenShell doesn't support Intel Macs." };
    const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      await runWizard(); // a confirm() would throw: there is none in the prompt mock
    } finally {
      if (tty) Object.defineProperty(process.stdin, 'isTTY', tty);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    expect(fixture.sequence).toEqual(['skill:onecli', 'gateway-ready']);
    expect(fixture.info).toEqual(["OpenShell doesn't support Intel Macs. This install uses Docker sandboxing."]);
  });

  it('NANOCLAW_OPENSHELL=false on an OpenShell copy switches back to Docker and runs nothing else of OpenShell', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'false');
    vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_END);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\n');
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'verify']);
    expect(fixture.args.openshell).toEqual(['--disable']);
  });

  it('NANOCLAW_SKIP=openshell on a copy without OpenShell: none of its steps run, even with the flag', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_SKIP', `openshell,${SKIP_TO_END}`);
    await runWizard();
    expect(fixture.sequence).toEqual(['verify']);
    expect(fixture.outro).toHaveLength(1);
  });

  it('NANOCLAW_SKIP=openshell on an OpenShell copy (fail()’s retry): no question, but the install follows .env', async () => {
    vi.stubEnv('NANOCLAW_SKIP', `openshell,${SKIP_TO_GATEWAY}`);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\n');
    await runWizard();
    // The gateway is still the openshell one, not the default.
    expect(fixture.sequence).toEqual(['openshell-install', 'skill:openshell', 'gateway-ready']);
  });

  it('NANOCLAW_SKIP=openshell-install: no install; a missing CLI is then a warning', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_SKIP', `openshell-install,${SKIP_TO_GATEWAY}`);
    fixture.stepResult.openshell = {
      ok: true,
      fields: { STATUS: 'success', CLI_FOUND: 'false', OPENSHELL_BIN: 'openshell' },
    };
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'skill:openshell', 'gateway-ready']);
    expect(fixture.warn.join('\n')).toMatch(/openshell CLI was not found/);
  });

  it('a CLI not found yet is expected when the install step follows: no warning', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    fixture.stepResult.openshell = {
      ok: true,
      fields: { STATUS: 'success', CLI_FOUND: 'false', OPENSHELL_BIN: 'openshell' },
    };
    await runWizard();
    expect(fixture.warn).toEqual([]);
  });
});

describe('the OpenShell setup UI at the end of setup', () => {
  function openShellToEnd(): void {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_END);
  }

  it('starts after verify without asking, and prints only its URL', async () => {
    openShellToEnd();
    fixture.stepResult['openshell-ui'] = { ok: true, fields: { STATUS: 'success', URL: 'http://bob-lab:8790/' } };
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'openshell-install', 'verify', 'openshell-ui']);
    expect(fixture.args['openshell-ui']).toEqual(['--enable']);
    expect(fixture.info).toEqual(['OpenShell setup UI: http://bob-lab:8790/']);
    // ...and setup finishes normally after it.
    expect(fixture.outro).toHaveLength(1);
    expect(fixture.fail).not.toHaveBeenCalled();
  });

  it('passes NANOCLAW_OPENSHELL_UI_PORT through as --port', async () => {
    openShellToEnd();
    vi.stubEnv('NANOCLAW_OPENSHELL_UI_PORT', '9001');
    await runWizard();
    expect(fixture.args['openshell-ui']).toEqual(['--enable', '--port', '9001']);
  });

  it('a UI that fails to start is a warning with the recovery command; setup still finishes', async () => {
    openShellToEnd();
    fixture.stepResult['openshell-ui'] = { ok: false, fields: { STATUS: 'failed' } };
    await runWizard();
    expect(fixture.warn.join('\n')).toMatch(
      /setup UI didn't start.*pnpm exec tsx setup\/index\.ts --step openshell-ui -- --enable/s,
    );
    expect(fixture.fail).not.toHaveBeenCalled();
    expect(fixture.outro).toHaveLength(1);
  });

  it('starts even when verify finds problems (it can replace the Claude credential), before "What\'s left"', async () => {
    openShellToEnd();
    fixture.stepResult.verify = {
      ok: false,
      fields: { STATUS: 'failed', CREDENTIALS: 'missing', CREDENTIAL_SOURCE: 'drop-in:none', CONFIGURED_CHANNELS: 'x' },
    };
    fixture.stepResult['openshell-ui'] = { ok: true, fields: { STATUS: 'success', URL: 'http://bob-lab:8790/' } };
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'openshell-install', 'verify', 'openshell-ui']);
    expect(fixture.info).toEqual(['OpenShell setup UI: http://bob-lab:8790/']);
    expect(fixture.notes.join('\n')).toMatch(/no Claude credential/);
  });

  it('verify’s OpenShell findings land in "What\'s left"', async () => {
    openShellToEnd();
    fixture.stepResult.verify = {
      ok: false,
      fields: {
        STATUS: 'failed',
        CREDENTIALS: 'configured',
        CONFIGURED_CHANNELS: 'x',
        OPENSHELL_GATEWAY: 'connected',
        OPENSHELL_SUPERVISOR_IMAGE: 'missing',
        OPENSHELL_SUPERVISOR_IMAGE_REF: 'ghcr.io/nvidia/openshell/supervisor:0.1.2',
      },
    };
    await runWizard();
    expect(fixture.notes.join('\n')).toMatch(
      /supervisor image is missing.*docker pull ghcr\.io\/nvidia\/openshell\/supervisor:0\.1\.2/s,
    );
  });

  it('respects NANOCLAW_SKIP=openshell-ui', async () => {
    openShellToEnd();
    vi.stubEnv('NANOCLAW_SKIP', `openshell-ui,${SKIP_TO_END}`);
    await runWizard();
    expect(fixture.sequence).toEqual(['openshell', 'openshell-install', 'verify']);
  });

  it('never runs on a copy without OpenShell', async () => {
    vi.stubEnv('NANOCLAW_SKIP', SKIP_TO_END);
    await runWizard();
    expect(fixture.sequence).toEqual(['verify']);
    expect(fixture.info).toEqual([]);
  });
});
