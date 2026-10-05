/**
 * The OpenShell question through the real wizard (setup/auto.ts): answered by
 * flag/env or an earlier `.env` answer, the wizard runs `--step openshell`
 * without installing a gateway, then its own gateway step installs
 * `openshell`. Unanswered without a TTY means no: nothing runs and the default
 * gateway is installed exactly as before.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  select: vi.fn(),
  runSkill: vi.fn(async () => ({ deferred: [], agentTasks: [] })),
  quietSteps: [] as { step: string; args: string[] }[],
  stepResult: {} as Record<string, { ok: boolean; fields: Record<string, string> }>,
  info: [] as string[],
  warn: [] as string[],
  fail: vi.fn(async (step: string) => {
    throw new Error(`fail:${step}`);
  }),
}));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.select }));
vi.mock('./lib/skill-driver.js', () => ({ runSkill: fixture.runSkill }));
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
}));
vi.mock('./logs.js', () => ({ reset: vi.fn(), userInput: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: async (step: string, _labels: unknown, args: string[] = []) => {
    fixture.quietSteps.push({ step, args });
    const r = fixture.stepResult[step] ?? { ok: true, fields: { STATUS: 'success' } };
    return { ok: r.ok, exitCode: r.ok ? 0 : 1, blocks: [], transcript: '', terminal: { type: 'X', fields: r.fields } };
  },
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: {
    message: vi.fn(),
    error: vi.fn(),
    warn: (m: string) => fixture.warn.push(m),
    info: (m: string) => fixture.info.push(m),
    // The gateway step's success line: stop the wizard right after it.
    success: () => {
      throw new Error('gateway boundary');
    },
  },
}));

let root: string;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.quietSteps = [];
  fixture.stepResult = {};
  fixture.info = [];
  fixture.warn = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-openshell-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '');
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
  vi.stubEnv('NANOCLAW_TEMPLATE_PATH', '');
  vi.stubEnv('NANOCLAW_OPENSHELL', '');
  vi.stubEnv('OPENSHELL_BIN', '');
  vi.stubEnv('OPENSHELL_GATEWAY', '');
  vi.stubEnv('NANOCLAW_OPENSHELL_UI', '');
  vi.stubEnv('NANOCLAW_OPENSHELL_UI_PORT', '');
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,auth,mounts,service,cli-agent,timezone,channel,verify,first-chat');
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
  // The wizard ends at the gateway boundary (or a fail()); either rejection
  // surfaces through main()'s own catch, which calls process.exit.
  await import('./auto.js');
  await exited;
}

describe('OpenShell sandboxing through the real wizard', () => {
  it('unanswered without a TTY: no openshell step, default gateway unchanged', async () => {
    await runWizard();
    expect(fixture.quietSteps).toEqual([]);
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.anything());
    expect(fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').not.toMatch(
      /NANOCLAW_RUNTIME_DRIVER/,
    );
  });

  it('NANOCLAW_OPENSHELL=true: runs the step (gateway deferred) and installs the openshell gateway', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('OPENSHELL_BIN', '/opt/openshell/bin/openshell');
    vi.stubEnv('OPENSHELL_GATEWAY', 'lab');
    await runWizard();
    expect(fixture.quietSteps).toEqual([
      {
        step: 'openshell',
        args: ['--enable', '--no-gateway', '--bin', '/opt/openshell/bin/openshell', '--gateway', 'lab'],
      },
    ]);
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/openshell', expect.anything());
    expect(fixture.runSkill).not.toHaveBeenCalledWith('/skills/onecli', expect.anything());
  });

  it('an earlier answer in .env is kept on re-run without asking', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\nOPENSHELL_BIN=/usr/bin/openshell\n');
    await runWizard();
    expect(fixture.quietSteps).toEqual([
      { step: 'openshell', args: ['--enable', '--no-gateway', '--bin', '/usr/bin/openshell'] },
    ]);
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/openshell', expect.anything());
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
    expect(fixture.quietSteps).toEqual([]);
    expect(fixture.runSkill).not.toHaveBeenCalled();
  });

  it('NANOCLAW_OPENSHELL=false on an OpenShell copy switches back to Docker', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'false');
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\n');
    await runWizard();
    expect(fixture.quietSteps).toEqual([{ step: 'openshell', args: ['--disable'] }]);
  });

  it('offers the setup UI only after OpenShell is enabled; NANOCLAW_OPENSHELL_UI=true runs `openshell-ui --enable`', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'true');
    fixture.stepResult['openshell-ui'] = { ok: true, fields: { STATUS: 'success', URL: 'http://bob-lab:8790/' } };
    await runWizard();
    expect(fixture.quietSteps.map((s) => s.step)).toEqual(['openshell', 'openshell-ui']);
    expect(fixture.quietSteps[1].args).toEqual(['--enable']);
    expect(fixture.info.join('\n')).toContain('http://bob-lab:8790/');
    // OpenShell's own flow is untouched: its gateway still installs afterwards.
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/openshell', expect.anything());
  });

  it('passes NANOCLAW_OPENSHELL_UI_PORT through as --port', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI_PORT', '9001');
    await runWizard();
    expect(fixture.quietSteps.find((s) => s.step === 'openshell-ui')?.args).toEqual(['--enable', '--port', '9001']);
  });

  it('is its own yes/no: OpenShell on but the UI unanswered without a TTY → not started', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    await runWizard();
    expect(fixture.quietSteps.map((s) => s.step)).toEqual(['openshell']);
  });

  it('NANOCLAW_OPENSHELL_UI=false → not started', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'false');
    await runWizard();
    expect(fixture.quietSteps.map((s) => s.step)).toEqual(['openshell']);
  });

  it('never offered when OpenShell is not enabled, even with the flag set', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'true');
    await runWizard();
    expect(fixture.quietSteps).toEqual([]);
  });

  it('respects NANOCLAW_SKIP=openshell-ui', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'true');
    vi.stubEnv(
      'NANOCLAW_SKIP',
      'openshell-ui,environment,container,auth,mounts,service,cli-agent,timezone,channel,verify,first-chat',
    );
    await runWizard();
    expect(fixture.quietSteps.map((s) => s.step)).toEqual(['openshell']);
  });

  it('a UI that fails to start is a warning; setup carries on to the gateway', async () => {
    vi.stubEnv('NANOCLAW_OPENSHELL', 'true');
    vi.stubEnv('NANOCLAW_OPENSHELL_UI', 'true');
    fixture.stepResult['openshell-ui'] = { ok: false, fields: { STATUS: 'failed' } };
    await runWizard();
    // The only fail() is the harness's own stop at the gateway boundary; nothing failed for the UI.
    expect(fixture.fail.mock.calls.map((c) => c[0])).toEqual(['gateway']);
    expect(fixture.warn.join('\n')).toMatch(/setup UI didn't start/);
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/openshell', expect.anything());
  });
});
