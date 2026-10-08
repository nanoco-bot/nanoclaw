import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyMountProbe,
  dockerImageState,
  ensureOpenShellRuntime,
  gatewayConfigRemedy,
  inspectOpenShellRuntime,
  isLocalGateway,
  NANOCLAW_GATEWAY_SETTINGS,
  NEW_GATEWAY_TOML,
  openShellHostSupport,
  parseGatewayStatus,
  planGatewayConfigCreate,
  probeGatewayMounts,
  PROBE_IMAGE,
  supervisorImageRef,
  type Run,
  type RunResult,
} from './runtime.js';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const err = (stderr: string, code = 1): RunResult => ({ code, stdout: '', stderr });

const CONNECTED = JSON.stringify({
  authentication: { provider: 'mTLS transport', status: 'authenticated' },
  gateway: 'openshell',
  server: 'https://127.0.0.1:17670',
  status: 'connected',
  version: '0.1.2',
});
const NOT_CONFIGURED = '{\n  "status": "not_configured"\n}\n';
const REFUSED =
  '\nError:   × client error (Connect)\n  ├─▶ tcp connect error\n  ╰─▶ Connection refused (os error 111)\n';
const INFO_DOCKER = JSON.stringify({ compute_drivers: [{ name: 'docker', capabilities: { driver_name: 'docker' } }] });
const SUPERVISOR = 'ghcr.io/nvidia/openshell/supervisor:0.1.2';
const NO_SUCH_IMAGE = `Error response from daemon: No such image: ${SUPERVISOR}`;

// The three refusals and the pass, as a v0.1.2 gateway prints them (captured live).
const PROBE = {
  allow: err(
    "Error:   × code: 'The system is not in a state required for the operation's\n  │ execution', message: \"caller driver config is disabled; a gateway\n  │ administrator must enable allow_driver_config\"\n",
  ),
  bind: err(
    "Error:   × code: 'The system is not in a state required for the operation's\n  │ execution', message: \"docker bind mounts require enable_bind_mounts = true\n  │ in [openshell.drivers.docker]\"\n",
  ),
  admission: err(
    "Error:   × code: 'The system is not in a state required for the operation's\n  │ execution', message: \"host bind or image mount cannot be attached while\n  │ resource admission is enabled: no trusted label resolver\"\n",
  ),
  passed: err(
    'Error:   × sandbox entered error phase while provisioning: ImagePullFailed: pull\n  │ Docker image failed: Docker responded with status code 400: invalid\n  │ reference format: repository name (nanoclaw-probe/INVALID) must be\n  │ lowercase\n',
  ),
};

/** A scripted machine: first matching rule answers; every call is recorded. */
function machine(rules: [(cmd: string, args: string[]) => boolean, RunResult | (() => RunResult)][]) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  const run: Run = (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    const rule = rules.find(([match]) => match(cmd, args));
    if (!rule) throw new Error(`unexpected call: ${cmd} ${args.join(' ')}`);
    return typeof rule[1] === 'function' ? rule[1]() : rule[1];
  };
  return { run, calls };
}

const is =
  (...prefix: string[]) =>
  (cmd: string, args: string[]) =>
    [cmd, ...args].slice(0, prefix.length).join(' ') === prefix.join(' ');

describe('openShellHostSupport', () => {
  it('Linux x86_64/arm64 and Apple silicon Macs are supported', () => {
    expect(openShellHostSupport({ platform: 'linux', arch: 'x64' })).toEqual({ ok: true });
    expect(openShellHostSupport({ platform: 'linux', arch: 'arm64' })).toEqual({ ok: true });
    expect(openShellHostSupport({ platform: 'macos', arch: 'arm64' })).toEqual({ ok: true });
  });

  it('an Intel Mac is refused, saying why', () => {
    const r = openShellHostSupport({ platform: 'macos', arch: 'x64', appleSilicon: false });
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/doesn't support Intel Macs/) });
  });

  it('an Apple silicon Mac running x64 Node (Rosetta) is told to switch Node, not that its Mac is unsupported', () => {
    const r = openShellHostSupport({ platform: 'macos', arch: 'x64', appleSilicon: true });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/Rosetta/);
    expect(!r.ok && r.reason).not.toMatch(/Intel Macs/);
  });

  it('other platforms and Linux architectures are refused', () => {
    expect(openShellHostSupport({ platform: 'unknown', arch: 'x64' }).ok).toBe(false);
    expect(openShellHostSupport({ platform: 'linux', arch: 'arm' }).ok).toBe(false);
  });
});

describe('parseGatewayStatus (v0.1.2 `openshell status -o json`)', () => {
  it('connected: version and server', () => {
    expect(parseGatewayStatus(ok(CONNECTED))).toEqual({
      state: 'connected',
      version: '0.1.2',
      server: 'https://127.0.0.1:17670',
    });
  });
  it('no gateway registered is exit 0 with not_configured', () => {
    expect(parseGatewayStatus(ok(NOT_CONFIGURED))).toEqual({ state: 'not_configured' });
  });
  it('a stopped gateway is a non-zero exit', () => {
    expect(parseGatewayStatus(err(REFUSED))).toEqual({
      state: 'unreachable',
      detail: 'Connection refused (os error 111)',
    });
  });
  it('a missing CLI is code 127', () => {
    expect(parseGatewayStatus(err('spawnSync openshell ENOENT', 127)).state).toBe('cli_missing');
  });
  it('garbage is unreachable, not connected', () => {
    expect(parseGatewayStatus(ok('not json')).state).toBe('unreachable');
  });
});

describe('supervisorImageRef / isLocalGateway', () => {
  it('is the gateway version on OpenShell’s supervisor repo (OCI-safe), unless overridden', () => {
    expect(supervisorImageRef('0.1.2')).toBe(SUPERVISOR);
    expect(supervisorImageRef('v0.1.2')).toBe(SUPERVISOR);
    expect(supervisorImageRef('0.2.0+abc')).toBe('ghcr.io/nvidia/openshell/supervisor:0.2.0-abc');
    expect(supervisorImageRef('0.1.2', ' registry.local/sup:1 ')).toBe('registry.local/sup:1');
  });
  it('loopback endpoints are local; anything else is remote', () => {
    expect(isLocalGateway('https://127.0.0.1:17670')).toBe(true);
    expect(isLocalGateway('https://localhost:17670')).toBe(true);
    expect(isLocalGateway('https://[::1]:17670')).toBe(true);
    expect(isLocalGateway('')).toBe(true);
    expect(isLocalGateway('https://gateway.example.com')).toBe(false);
  });
});

describe('dockerImageState', () => {
  it('present / missing / unknown (Docker not answering)', () => {
    expect(dockerImageState(SUPERVISOR, machine([[is('docker'), ok('sha256:d7b5')]]).run)).toBe('present');
    expect(dockerImageState(SUPERVISOR, machine([[is('docker'), err(NO_SUCH_IMAGE)]]).run)).toBe('missing');
    expect(
      dockerImageState(
        SUPERVISOR,
        machine([[is('docker'), err('failed to connect to the docker API at unix:///var/run/docker.sock')]]).run,
      ),
    ).toBe('unknown');
  });
});

describe('inspectOpenShellRuntime (verify: read-only)', () => {
  it('connected + image present', () => {
    const m = machine([
      [is('openshell', 'status'), ok(CONNECTED)],
      [is('docker', 'image', 'inspect'), ok('sha256:d7b5')],
    ]);
    expect(inspectOpenShellRuntime({ bin: 'openshell', env: { OPENSHELL_GATEWAY: 'lab' }, run: m.run })).toEqual({
      gateway: 'connected',
      gatewayVersion: '0.1.2',
      supervisorImageRef: SUPERVISOR,
      supervisorImage: 'present',
    });
    expect(m.calls[0].env).toEqual({ OPENSHELL_GATEWAY: 'lab' });
    // Never pulls.
    expect(m.calls.some((c) => c.args[0] === 'pull')).toBe(false);
  });

  it('image pruned after the gateway started → missing', () => {
    const m = machine([
      [is('openshell', 'status'), ok(CONNECTED)],
      [is('docker', 'image', 'inspect'), err(NO_SUCH_IMAGE)],
    ]);
    expect(inspectOpenShellRuntime({ bin: 'openshell', env: {}, run: m.run }).supervisorImage).toBe('missing');
  });

  it('gateway down: reported, image unknown (no version to check against)', () => {
    const m = machine([[is('openshell', 'status'), err(REFUSED)]]);
    expect(inspectOpenShellRuntime({ bin: 'openshell', env: {}, run: m.run })).toEqual({
      gateway: 'unreachable',
      supervisorImage: 'unknown',
    });
  });

  it('a remote gateway’s image is not this machine’s to check', () => {
    const remote = JSON.stringify({ status: 'connected', version: '0.1.2', server: 'https://gw.example.com' });
    const m = machine([[is('openshell', 'status'), ok(remote)]]);
    expect(inspectOpenShellRuntime({ bin: 'openshell', env: {}, run: m.run }).supervisorImage).toBe('remote');
  });
});

describe('classifyMountProbe (messages from a live v0.1.2 gateway)', () => {
  it('names the first missing setting, in the gateway’s own order', () => {
    expect(classifyMountProbe(PROBE.allow)).toMatchObject({ result: 'missing', setting: 'allow_driver_config' });
    expect(classifyMountProbe(PROBE.bind)).toMatchObject({ result: 'missing', setting: 'enable_bind_mounts' });
    expect(classifyMountProbe(PROBE.admission)).toMatchObject({ result: 'missing', setting: 'resource_admission' });
  });
  it('getting as far as the image reference means every setting is in place', () => {
    expect(classifyMountProbe(PROBE.passed)).toEqual({ result: 'ok' });
  });
  it('anything else is unknown, with the detail', () => {
    expect(classifyMountProbe(err('Error: × permission denied'))).toMatchObject({ result: 'unknown' });
  });
});

describe('probeGatewayMounts', () => {
  it('creates nothing runnable: an invalid image, one read-only bind of the host dir; deletes the record', () => {
    const m = machine([
      [is('openshell', 'sandbox', 'create'), PROBE.passed],
      [is('openshell', 'sandbox', 'delete'), ok()],
    ]);
    expect(
      probeGatewayMounts({ bin: 'openshell', env: {}, hostDir: '/srv/nanoclaw', run: m.run, name: 'nc-probe-t' }),
    ).toEqual({
      result: 'ok',
    });
    const create = m.calls[0].args;
    expect(create).toEqual(expect.arrayContaining(['--name', 'nc-probe-t', '--from', PROBE_IMAGE, '--detach']));
    expect(JSON.parse(create[create.indexOf('--driver-config-json') + 1])).toEqual({
      docker: { mounts: [{ type: 'bind', source: '/srv/nanoclaw', target: '/nanoclaw-probe', read_only: true }] },
    });
    expect(m.calls[1].args).toEqual(['sandbox', 'delete', 'nc-probe-t']);
  });

  it('a refused probe leaves no record, so there is nothing to delete', () => {
    const m = machine([[is('openshell', 'sandbox', 'create'), PROBE.allow]]);
    probeGatewayMounts({ bin: 'openshell', env: {}, hostDir: '/x', run: m.run });
    expect(m.calls).toHaveLength(1);
  });

  it('the generated name fits OpenShell’s 19-byte DNS-1123 limit', () => {
    const m = machine([
      [is('openshell', 'sandbox', 'create'), PROBE.passed],
      [is('openshell', 'sandbox', 'delete'), ok()],
    ]);
    probeGatewayMounts({ bin: 'openshell', env: {}, hostDir: '/x', run: m.run });
    const name = m.calls[0].args[m.calls[0].args.indexOf('--name') + 1];
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(19);
  });
});

describe('gatewayConfigRemedy', () => {
  it('gives the exact TOML and the platform’s restart command', () => {
    expect(NANOCLAW_GATEWAY_SETTINGS).toBe(
      '[openshell.drivers.docker]\nallow_driver_config = true\nenable_bind_mounts = true\n\n[openshell.drivers.docker.resource_admission]\nenabled = false',
    );
    expect(gatewayConfigRemedy('linux')).toContain(NANOCLAW_GATEWAY_SETTINGS);
    expect(gatewayConfigRemedy('linux')).toContain('systemctl --user restart openshell-gateway');
    expect(gatewayConfigRemedy('macos')).toContain('brew services restart nvidia/openshell/openshell');
  });

  it('on macOS names the Homebrew config the service reads while ~/.config has none', () => {
    expect(gatewayConfigRemedy('macos')).toContain('$(brew --prefix)/var/openshell/gateway.toml');
    expect(gatewayConfigRemedy('linux')).not.toContain('brew');
  });
});

describe('ensureOpenShellRuntime (the install step’s checks)', () => {
  // Every test gets its own fake home, so nothing is ever written to the real ~/.config.
  let home: string;
  let base: {
    bin: string;
    env: NodeJS.ProcessEnv;
    platform: string;
    hostDir: string;
    sleep: () => Promise<void>;
    home: string;
    hostEnv: NodeJS.ProcessEnv;
  };
  const configDir = () => path.join(home, '.config', 'openshell');
  const configFile = () => path.join(configDir(), 'gateway.toml');
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-home-'));
    base = {
      bin: '/usr/bin/openshell',
      env: {},
      platform: 'linux',
      hostDir: '/srv/nc',
      sleep: async () => {},
      home,
      hostEnv: {},
    };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function healthy(overrides: [(cmd: string, args: string[]) => boolean, RunResult | (() => RunResult)][] = []) {
    return machine([
      ...overrides,
      [is('/usr/bin/openshell', 'status'), ok(CONNECTED)],
      [is('/usr/bin/openshell', 'gateway', 'info'), ok(INFO_DOCKER)],
      [is('docker', 'image', 'inspect'), ok('sha256:d7b5')],
      [is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.passed],
      [is('/usr/bin/openshell', 'sandbox', 'delete'), ok()],
    ]);
  }

  it('all good: connected, image present, mounts accepted; pulls nothing', async () => {
    const m = healthy();
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toEqual({
      ok: true,
      gatewayVersion: '0.1.2',
      server: 'https://127.0.0.1:17670',
      supervisorImageRef: SUPERVISOR,
      supervisorImage: 'present',
      mounts: 'ok',
      warnings: [],
    });
    expect(m.calls.some((c) => c.args[0] === 'pull')).toBe(false);
  });

  it('pulls a missing supervisor image, then confirms it', async () => {
    let pulled = false;
    const m = healthy([
      [is('docker', 'image', 'inspect'), () => (pulled ? ok('sha256:d7b5') : err(NO_SUCH_IMAGE))],
      [
        is('docker', 'pull'),
        () => {
          pulled = true;
          return ok();
        },
      ],
    ]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: true, supervisorImage: 'pulled' });
    expect(m.calls.find((c) => c.args[0] === 'pull')?.args).toEqual(['pull', SUPERVISOR]);
  });

  it('a pull that does not produce the image fails with the exact docker pull to run', async () => {
    const m = healthy([
      [is('docker', 'image', 'inspect'), err(NO_SUCH_IMAGE)],
      [is('docker', 'pull'), err('denied')],
    ]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: false, error: 'supervisor_image_missing' });
    expect(!r.ok && r.hint).toContain(`docker pull ${SUPERVISOR}`);
  });

  it('honours an operator override of the supervisor image', async () => {
    const m = healthy();
    const r = await ensureOpenShellRuntime({ ...base, run: m.run, supervisorOverride: 'registry.local/sup:1' });
    expect(r).toMatchObject({ ok: true, supervisorImageRef: 'registry.local/sup:1' });
    expect(m.calls.find((c) => c.cmd === 'docker')?.args).toContain('registry.local/sup:1');
  });

  it('no gateway registered (e.g. Linux without a systemd user session): fails at once, with how to start it', async () => {
    const m = machine([[is('/usr/bin/openshell', 'status'), ok(NOT_CONFIGURED)]]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: false, error: 'gateway_not_registered' });
    expect(!r.ok && r.hint).toContain('systemctl --user enable --now openshell-gateway');
    expect(m.calls).toHaveLength(1);
  });

  it('a registered gateway that never answers: waits, then fails with how to restart it', async () => {
    const m = machine([[is('/usr/bin/openshell', 'status'), err(REFUSED)]]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run, waitMs: 6_000, pollMs: 2_000 });
    expect(r).toMatchObject({ ok: false, error: 'gateway_unreachable' });
    expect(!r.ok && r.hint).toContain('systemctl --user restart openshell-gateway');
    expect(m.calls).toHaveLength(4); // first try + 3 polls
  });

  it('a gateway still starting (pulling images) is waited for', async () => {
    let tries = 0;
    const m = healthy([[is('/usr/bin/openshell', 'status'), () => (++tries < 3 ? err(REFUSED) : ok(CONNECTED))]]);
    expect(await ensureOpenShellRuntime({ ...base, run: m.run })).toMatchObject({ ok: true });
    expect(tries).toBe(3);
  });

  it('a gateway on a non-Docker compute driver is refused (NanoClaw’s mounts are Docker driver config)', async () => {
    const m = healthy([
      [is('/usr/bin/openshell', 'gateway', 'info'), ok(JSON.stringify({ compute_drivers: [{ name: 'vm' }] }))],
    ]);
    expect(await ensureOpenShellRuntime({ ...base, run: m.run })).toMatchObject({ ok: false, error: 'compute_driver' });
  });

  it('a remote gateway: no local image check, still probed', async () => {
    const remote = JSON.stringify({ status: 'connected', version: '0.1.2', server: 'https://gw.example.com' });
    const m = healthy([[is('/usr/bin/openshell', 'status'), ok(remote)]]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: true, supervisorImage: 'remote', mounts: 'ok' });
    expect(m.calls.some((c) => c.cmd === 'docker')).toBe(false);
  });

  it('Docker not answering is its own failure, not "image missing"', async () => {
    const m = healthy([[is('docker', 'image', 'inspect'), err('failed to connect to the docker API')]]);
    expect(await ensureOpenShellRuntime({ ...base, run: m.run })).toMatchObject({
      ok: false,
      error: 'docker_unavailable',
    });
  });

  it.each([
    ['allow_driver_config', PROBE.allow],
    ['enable_bind_mounts', PROBE.bind],
    ['resource_admission', PROBE.admission],
  ])(
    'an operator gateway.toml exists and the gateway lacks %s: the original failure, file untouched, no restart',
    async (_setting, result) => {
      const operatorToml = '[openshell]\nversion = 2\n\n[openshell.gateway]\n# operator-owned\n';
      fs.mkdirSync(configDir(), { recursive: true });
      fs.writeFileSync(configFile(), operatorToml);
      const before = fs.statSync(configFile());
      const m = healthy([[is('/usr/bin/openshell', 'sandbox', 'create'), result]]);
      const r = await ensureOpenShellRuntime({ ...base, run: m.run });
      expect(r).toEqual({
        ok: false,
        error: 'gateway_config',
        message: expect.stringMatching(/^OpenShell's gateway refuses NanoClaw's sandbox mounts \(needs [^)]+\)\.$/),
        hint: gatewayConfigRemedy('linux'),
      });
      expect(fs.readFileSync(configFile(), 'utf8')).toBe(operatorToml);
      expect(fs.statSync(configFile()).mtimeMs).toBe(before.mtimeMs);
      expect(m.calls.some((c) => c.cmd === 'systemctl')).toBe(false);
      expect(m.calls.some((c) => c.args[1] === 'delete')).toBe(false);
    },
  );

  it.each([
    ['allow_driver_config', PROBE.allow],
    ['enable_bind_mounts', PROBE.bind],
    ['resource_admission', PROBE.admission],
  ])(
    'fresh Linux install, no gateway.toml, missing %s: creates it, restarts, re-probes, ok with a warning',
    async (_setting, result) => {
      let restarted = false;
      let statusAfterRestart = 0;
      const m = healthy([
        [is('/usr/bin/openshell', 'sandbox', 'create'), () => (restarted ? PROBE.passed : result)],
        [
          is('systemctl', '--user', 'restart', 'openshell-gateway'),
          () => {
            restarted = true;
            return ok();
          },
        ],
        // The gateway takes a couple of polls to come back after the restart.
        [
          is('/usr/bin/openshell', 'status'),
          () => (restarted && ++statusAfterRestart < 3 ? err(REFUSED) : ok(CONNECTED)),
        ],
      ]);
      const r = await ensureOpenShellRuntime({ ...base, run: m.run });
      expect(r).toMatchObject({ ok: true, mounts: 'ok', gatewayConfigCreated: configFile() });
      expect(r.ok && r.warnings).toHaveLength(1);
      expect(r.ok && r.warnings[0]).toContain(`NanoClaw created ${configFile()}`);
      expect(r.ok && r.warnings[0]).toContain('systemctl --user restart openshell-gateway');
      expect(fs.readFileSync(configFile(), 'utf8')).toBe(`[openshell]\nversion = 2\n\n${NANOCLAW_GATEWAY_SETTINGS}\n`);
      expect(fs.statSync(configFile()).mode & 0o777).toBe(0o600);
      expect(m.calls.filter((c) => c.cmd === 'systemctl')).toHaveLength(1);
      expect(m.calls.filter((c) => c.args[0] === 'sandbox' && c.args[1] === 'create')).toHaveLength(2);
      expect(statusAfterRestart).toBe(3);
    },
  );

  it('fresh Linux install, created + restarted, but the re-probe still refuses: original gateway_config failure, noting the attempt', async () => {
    const m = healthy([
      [is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.allow],
      [is('systemctl', '--user', 'restart', 'openshell-gateway'), ok()],
    ]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: false, error: 'gateway_config', hint: gatewayConfigRemedy('linux') });
    expect(!r.ok && r.message).toMatch(
      /^OpenShell's gateway refuses NanoClaw's sandbox mounts \(needs allow_driver_config = true\)\./,
    );
    expect(!r.ok && r.message).toContain(
      `NanoClaw created ${configFile()} with these settings and restarted the gateway, but it still refuses`,
    );
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(NEW_GATEWAY_TOML);
    expect(m.calls.filter((c) => c.cmd === 'systemctl')).toHaveLength(1);
    expect(m.calls.filter((c) => c.args[1] === 'create')).toHaveLength(2); // retried exactly once
  });

  it('fresh Linux install, created, but the restart command fails: gateway_config, noting it', async () => {
    const m = healthy([
      [is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.allow],
      [is('systemctl'), err('Failed to connect to bus: No medium found')],
    ]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: false, error: 'gateway_config', hint: gatewayConfigRemedy('linux') });
    expect(!r.ok && r.message).toContain(
      '`systemctl --user restart openshell-gateway` failed (Failed to connect to bus',
    );
    expect(m.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
  });

  it('fresh Linux install, created + restarted, but the gateway never comes back: gateway_config, noting it', async () => {
    let restarted = false;
    const m = healthy([
      [is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.allow],
      [
        is('systemctl'),
        () => {
          restarted = true;
          return ok();
        },
      ],
      [is('/usr/bin/openshell', 'status'), () => (restarted ? err(REFUSED) : ok(CONNECTED))],
    ]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run, waitMs: 4_000, pollMs: 2_000 });
    expect(r).toMatchObject({ ok: false, error: 'gateway_config' });
    expect(!r.ok && r.message).toContain("didn't answer again within 4s");
    expect(m.calls.filter((c) => c.args[1] === 'create')).toHaveLength(1);
  });

  it('macOS keeps the original failure and hint: no file written, no restart attempted', async () => {
    const m = healthy([[is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.allow]]);
    const r = await ensureOpenShellRuntime({ ...base, platform: 'macos', run: m.run });
    expect(r).toEqual({
      ok: false,
      error: 'gateway_config',
      message: "OpenShell's gateway refuses NanoClaw's sandbox mounts (needs allow_driver_config = true).",
      hint: gatewayConfigRemedy('macos'),
    });
    expect(fs.existsSync(configDir())).toBe(false);
    expect(m.calls.some((c) => c.cmd === 'brew' || c.cmd === 'systemctl')).toBe(false);
  });

  it('a dangling gateway.toml symlink counts as existing: not followed, not replaced', async () => {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.symlinkSync(path.join(home, 'nowhere.toml'), configFile());
    const m = healthy([[is('/usr/bin/openshell', 'sandbox', 'create'), PROBE.allow]]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: false, error: 'gateway_config' });
    expect(fs.existsSync(path.join(home, 'nowhere.toml'))).toBe(false);
    expect(m.calls.some((c) => c.cmd === 'systemctl')).toBe(false);
  });

  it('an inconclusive probe is a warning, not a failure', async () => {
    const m = healthy([[is('/usr/bin/openshell', 'sandbox', 'create'), err('Error: × something new')]]);
    const r = await ensureOpenShellRuntime({ ...base, run: m.run });
    expect(r).toMatchObject({ ok: true, mounts: 'unknown' });
    expect(r.ok && r.warnings).toHaveLength(1);
  });
});

describe('planGatewayConfigCreate (when setup may create the gateway config itself)', () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-plan-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const plan = (over: Partial<Parameters<typeof planGatewayConfigCreate>[0]> = {}) =>
    planGatewayConfigCreate({
      platform: 'linux',
      bin: '/usr/bin/openshell',
      server: 'https://127.0.0.1:17670',
      env: {},
      hostEnv: {},
      home,
      ...over,
    });

  it('a local Linux gateway with nothing at ~/.config/openshell/gateway.toml: create there', () => {
    expect(plan()).toEqual({ create: true, path: path.join(home, '.config', 'openshell', 'gateway.toml') });
    expect(plan({ hostEnv: { XDG_CONFIG_HOME: path.join(home, '.config') } }).create).toBe(true);
  });

  it('never on macOS (Homebrew always seeds its own gateway.toml, which ~/.config would shadow)', () => {
    expect(plan({ platform: 'macos' })).toEqual({ create: false, reason: expect.stringMatching(/Linux-only/) });
  });

  it('never when the config lives somewhere else or the gateway is not this machine’s', () => {
    expect(plan({ hostEnv: { OPENSHELL_GATEWAY_CONFIG: '/etc/openshell/gw.toml' } }).create).toBe(false);
    expect(plan({ env: { OPENSHELL_GATEWAY_CONFIG: '/etc/openshell/gw.toml' } }).create).toBe(false);
    expect(plan({ hostEnv: { XDG_CONFIG_HOME: '/elsewhere' } }).create).toBe(false);
    expect(plan({ bin: '/snap/bin/openshell' }).create).toBe(false);
    expect(plan({ server: 'https://gw.example.com' }).create).toBe(false);
  });

  it('never when a gateway.toml or a gateway.env already exists', () => {
    const dir = path.join(home, '.config', 'openshell');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gateway.env'), '');
    expect(plan().create).toBe(false);
    fs.rmSync(path.join(dir, 'gateway.env'));
    fs.writeFileSync(path.join(dir, 'gateway.toml'), '');
    expect(plan()).toEqual({ create: false, reason: expect.stringMatching(/already exists/) });
  });
});
