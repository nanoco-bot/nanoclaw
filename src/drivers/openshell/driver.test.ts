/**
 * Driver behavior against a scripted CLI — no OpenShell gateway, no Docker.
 */
import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { FIXTURE_POLICY, fixtureSpec, fixtureSpecWithAux } from '../spec-fixture.js';
import { LABELS, type SessionEvent, type SessionKey } from '../types.js';
import { OpenShellSessionDriver, diffSnapshots } from './driver.js';
import { cliErrorSummary, normalizeOpenShellError, sandboxName } from './realize.js';
import { FakeOpenShellCli, listJson, quietLogger, sandboxJson } from './fake-cli.js';

const KEY: SessionKey = { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' };
const NAME = sandboxName(KEY);
const OWN_LABELS = { [LABELS.install]: 'spike', [LABELS.group]: 'g1', [LABELS.session]: 's1', [LABELS.role]: 'agent' };
const NOT_FOUND = `sandbox '${NAME}' not found`;

function setup(rules: FakeOpenShellCli['rules'] = []) {
  const cli = new FakeOpenShellCli();
  cli.rules = rules;
  const driver = new OpenShellSessionDriver({ ...FIXTURE_POLICY, cli, logger: quietLogger, pollIntervalMs: 1000 });
  return { cli, driver };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('sandboxName', () => {
  it('is a DNS-1123 label within OpenShell v0.1.2 19-byte limit, deterministic per key', () => {
    expect(NAME).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(NAME.length).toBeLessThanOrEqual(19);
    expect(sandboxName({ ...KEY })).toBe(NAME);
    expect(sandboxName({ ...KEY, sessionId: 's2' })).not.toBe(NAME);
    expect(sandboxName({ ...KEY, installSlug: 'other' })).not.toBe(NAME);
  });
});

describe('prepare()', () => {
  it('runs the shared validateSpec layer (secret-shaped env is refused before anything is allocated)', async () => {
    const { cli, driver } = setup();
    const spec = fixtureSpec();
    spec.containers[0].env.ANTHROPIC_API_KEY = 'sk-ant-abcdefghijklmnopqrstuvwxyz';
    await expect(driver.prepare(spec)).rejects.toThrow(/denied-by-policy: secret-shaped env/);
    expect(cli.calls).toEqual([]);
  });

  it('refuses auxiliary containers instead of silently dropping them', async () => {
    const { cli, driver } = setup();
    await expect(driver.prepare(fixtureSpecWithAux())).rejects.toThrow(
      /spec-invalid: .*auxiliary containers \(egress-proxy\)/,
    );
    expect(cli.calls).toEqual([]);
  });

  it('refuses a label value it cannot realize verbatim', async () => {
    const { driver } = setup();
    const spec = fixtureSpec({ labels: { 'nanoclaw-group-folder': 'agent-one', lineage: 'has spaces' } });
    await expect(driver.prepare(spec)).rejects.toThrow(/spec-invalid: label lineage/);
  });

  it('allocates nothing: only an idempotency lookup, no create', async () => {
    const { cli, driver } = setup([{ match: /^sandbox get /, fails: NOT_FOUND }]);
    const handle = await driver.prepare(fixtureSpec());
    expect(handle.name).toBe(NAME);
    expect(cli.calls).toEqual([['sandbox', 'get', NAME, '-o', 'json']]);
    expect(await handle.status()).toEqual({ phase: 'ready' });
  });

  it('adopts an existing live sandbox carrying this key (idempotent on key)', async () => {
    const { cli, driver } = setup([
      { match: /^sandbox get /, stdout: sandboxJson({ name: NAME, phase: 'Ready', labels: OWN_LABELS }) },
    ]);
    const handle = await driver.prepare(fixtureSpec());
    await handle.start(); // adopted: nothing to create
    expect(cli.callsMatching(/^sandbox create/)).toEqual([]);
    expect(await handle.status()).toEqual({ phase: 'running' });
  });

  it('refuses to adopt a sandbox wearing the name with foreign labels', async () => {
    const { driver } = setup([
      {
        match: /^sandbox get /,
        stdout: sandboxJson({
          name: NAME,
          phase: 'Ready',
          labels: { ...OWN_LABELS, [LABELS.install]: 'someone-else' },
        }),
      },
    ]);
    await expect(driver.prepare(fixtureSpec())).rejects.toMatchObject({
      kind: 'unknown',
      opaqueRef: `name-collision-${NAME}`,
    });
  });

  it('replaces its own ended sandbox rather than re-handing out a corpse', async () => {
    const { cli, driver } = setup([
      {
        match: /^sandbox get /,
        times: 1,
        stdout: sandboxJson({ name: NAME, phase: 'Completed', exit_code: 0, labels: OWN_LABELS }),
      },
      { match: /^sandbox delete /, stdout: '' },
      { match: /^sandbox get /, fails: NOT_FOUND },
    ]);
    const handle = await driver.prepare(fixtureSpec());
    expect(cli.callsMatching(/^sandbox delete/)).toEqual([['sandbox', 'delete', NAME]]);
    expect(await handle.status()).toEqual({ phase: 'ready' });
  });

  it('surfaces an unreachable gateway as runtime-unavailable', async () => {
    const { driver } = setup([
      { match: /^sandbox get /, fails: 'error: transport error: Connection refused (os error 111)' },
    ]);
    await expect(driver.prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'runtime-unavailable', retryable: true });
  });
});

describe('start()', () => {
  it('creates the sandbox with compiled policy, bind mounts, labels, env, resources and command', async () => {
    let policyAtCreate = '';
    let policyPath = '';
    const { cli, driver } = setup([
      { match: /^sandbox get /, fails: NOT_FOUND },
      {
        match: /^sandbox create /,
        onCall: (args) => {
          policyPath = args[args.indexOf('--policy') + 1];
          policyAtCreate = fs.readFileSync(policyPath, 'utf8');
          expect(fs.statSync(policyPath).mode & 0o777).toBe(0o600);
        },
        stdout: sandboxJson({ name: NAME, phase: 'Ready', labels: OWN_LABELS }),
      },
    ]);
    const spec = fixtureSpec({ resources: { cpus: '1.5', memoryMb: 1024, pidsLimit: 2048, shmSizeMb: 1024 } });
    spec.containers[0].contributedEnv = { HTTPS_PROXY: 'http://gateway:10255', ANTHROPIC_AUTH_TOKEN: 'placeholder' };
    const handle = await driver.prepare(spec);
    await handle.start();
    await handle.start(); // idempotent

    const creates = cli.callsMatching(/^sandbox create/);
    expect(creates).toHaveLength(1);
    const args = creates[0];
    expect(args.slice(0, 6)).toEqual(['sandbox', 'create', '--name', NAME, '--from', 'nanoclaw-agent:spike-p0']);
    expect(JSON.parse(args[args.indexOf('--driver-config-json') + 1])).toEqual({
      docker: {
        mounts: [
          { type: 'bind', source: '/install/data/v2-sessions/g1/s1', target: '/workspace', read_only: false },
          { type: 'bind', source: '/install/container/agent-runner/src', target: '/app/src', read_only: true },
          { type: 'bind', source: '/install/container/CLAUDE.md', target: '/app/CLAUDE.md', read_only: true },
        ],
      },
    });
    const flagValues = (flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
    expect(flagValues('--label')).toEqual([
      'nanoclaw-install=spike',
      'nanoclaw-group=g1',
      'nanoclaw-session=s1',
      'nanoclaw-role=agent',
      'nanoclaw-container-name=nanoclaw-v2-agent-one-1700000000000',
      'nanoclaw-group-folder=agent-one',
      'session-channel=channel-abc',
    ]);
    // contributed lane wins on collision (HTTPS_PROXY), and is emitted after env
    expect(flagValues('--env')).toEqual([
      'TZ=UTC',
      'HTTPS_PROXY=http://gateway:10255',
      'ANTHROPIC_AUTH_TOKEN=placeholder',
    ]);
    expect(flagValues('--cpu')).toEqual(['1.5']);
    expect(flagValues('--memory')).toEqual(['1024Mi']);
    expect(args).toEqual(expect.arrayContaining(['--detach', '--no-tty', '--no-auto-providers']));
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'bash', '-c', 'exec bun run /app/src/index.ts']);

    expect(parseYaml(policyAtCreate)).toEqual({
      version: 1,
      filesystem_policy: {
        include_workdir: true,
        read_only: ['/usr', '/bin', '/lib', '/lib64', '/etc', '/app/src', '/app/CLAUDE.md'],
        read_write: ['/workspace'],
      },
      process: { run_as_user: '501', run_as_group: '1000' },
    });
    expect(fs.existsSync(policyPath)).toBe(false); // transient: the gateway holds the policy now
  });

  it('turns a gateway that refuses bind mounts into an actionable denied-by-policy, and rolls back', async () => {
    const { cli, driver } = setup([
      { match: /^sandbox get /, fails: NOT_FOUND },
      {
        match: /^sandbox create /,
        fails:
          'Error: × status: FailedPrecondition, message: "docker bind mounts require enable_bind_mounts = true in [openshell.drivers.docker]"',
      },
      { match: /^sandbox delete /, fails: NOT_FOUND },
    ]);
    const handle = await driver.prepare(fixtureSpec());
    const err = await handle.start().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ kind: 'denied-by-policy', retryable: false });
    expect((err as { detail: string }).detail).toMatch(/enable_bind_mounts = true/);
    expect((err as { detail: string }).detail).toMatch(/operator fix, not a driver bug/);
    expect(cli.callsMatching(/^sandbox delete/)).toEqual([['sandbox', 'delete', NAME]]);
  });

  it('does not roll back a sandbox it did not create (AlreadyExists = concurrent start of the same key)', async () => {
    const { cli, driver } = setup([
      { match: /^sandbox get /, fails: NOT_FOUND },
      { match: /^sandbox create /, fails: 'status: AlreadyExists, message: "sandbox already exists"' },
    ]);
    const handle = await driver.prepare(fixtureSpec());
    await expect(handle.start()).rejects.toThrow();
    expect(cli.callsMatching(/^sandbox delete/)).toEqual([]);
  });
});

describe('status(), stop(), execSpec()', () => {
  async function adopted(doc: Record<string, unknown>) {
    const ctx = setup([{ match: /^sandbox get /, stdout: sandboxJson({ name: NAME, labels: OWN_LABELS, ...doc }) }]);
    return { ...ctx, handle: await ctx.driver.prepare(fixtureSpec()) };
  }

  it.each([
    [{ phase: 'Provisioning' }, { phase: 'preparing' }],
    [{ phase: 'Ready' }, { phase: 'running' }],
    [{ phase: 'Unknown' }, { phase: 'running' }],
  ])('maps live phase %j -> %j', async (doc, expected) => {
    const { handle } = await adopted(doc);
    expect(await handle.status()).toEqual(expected);
  });

  it.each([
    [{ phase: 'Completed', exit_code: 0 }, { phase: 'stopped' }],
    [
      { phase: 'Stopped', exit_code: 137 },
      { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: 137 } },
    ],
    [
      { phase: 'Error', exit_code: 2 },
      { phase: 'failed', failure: { kind: 'started-then-died', retryable: false, exitCode: 2 } },
    ],
    [
      { phase: 'Error', configuration_admission: { state: 'rejected', error: 'policy rejected' } },
      { phase: 'failed', failure: { kind: 'denied-by-policy', retryable: false, detail: 'policy rejected' } },
    ],
  ])('maps ended phase %j -> %j', async (doc, expected) => {
    // An ended own sandbox is replaced at prepare(); read status through a listed handle instead.
    const { driver } = setup([
      { match: /^sandbox list /, stdout: listJson([{ name: NAME, labels: OWN_LABELS, ...doc }]) },
      { match: /^sandbox get /, stdout: sandboxJson({ name: NAME, labels: OWN_LABELS, ...doc }) },
    ]);
    const [snapshot] = await driver.listSessions('spike');
    expect(await snapshot.handle.status()).toEqual(expected);
  });

  it('stop() is full teardown (delete), tolerates already-gone, and a requested stop is not a failure', async () => {
    const { cli, handle } = await adopted({ phase: 'Ready' });
    cli.rules = [
      { match: /^sandbox delete /, stdout: '' },
      {
        match: /^sandbox get /,
        stdout: sandboxJson({ name: NAME, labels: OWN_LABELS, phase: 'Stopped', exit_code: 143 }),
      },
    ];
    await handle.stop('test');
    expect(cli.callsMatching(/^sandbox delete/)).toEqual([['sandbox', 'delete', NAME]]);
    expect(await handle.status()).toEqual({ phase: 'stopped' });
    cli.rules = [{ match: /^sandbox delete /, fails: NOT_FOUND }];
    await expect(handle.stop('again')).resolves.toBeUndefined();
  });

  it('execSpec describes `openshell sandbox exec`, never runs it', async () => {
    const { cli, handle } = await adopted({ phase: 'Ready' });
    const before = cli.calls.length;
    expect(handle.execSpec(['bash'])).toEqual({
      bin: 'openshell',
      argsTty: ['sandbox', 'exec', '--name', NAME, '--tty', '--', 'bash'],
      argsPlain: ['sandbox', 'exec', '--name', NAME, '--no-tty', '--', 'bash'],
    });
    expect(cli.calls.length).toBe(before);
  });
});

describe('listSessions()', () => {
  it('reconstructs handles from labels alone, filtered by install + agent role, across pages', async () => {
    const other = { ...OWN_LABELS, [LABELS.session]: 's2' };
    const { cli, driver } = setup([
      {
        match: /--page-token tok2/,
        stdout: listJson([{ name: 'ncl-b', phase: 'Error', exit_code: 1, labels: other }]),
      },
      {
        match: /^sandbox list /,
        stdout: listJson(
          [
            { name: NAME, phase: 'Ready', labels: OWN_LABELS },
            { name: 'stray', phase: 'Ready', labels: { [LABELS.install]: 'spike', [LABELS.role]: 'agent' } },
          ],
          'tok2',
        ),
      },
    ]);
    const snapshots = await driver.listSessions('spike');
    expect(cli.calls[0]).toEqual([
      'sandbox',
      'list',
      '--selector',
      'nanoclaw-install=spike,nanoclaw-role=agent',
      '--page-size',
      '100',
      '-o',
      'json',
    ]);
    expect(snapshots.map((s) => [s.handle.name, s.handle.key, s.phase, s.failure])).toEqual([
      [NAME, KEY, 'running', undefined],
      ['ncl-b', { ...KEY, sessionId: 's2' }, 'terminal', { kind: 'started-then-died', retryable: false, exitCode: 1 }],
    ]);
  });
});

describe('watchSessions() — honest polling', () => {
  const k2: SessionKey = { ...KEY, sessionId: 's2' };
  const snap = (key: SessionKey, phase: 'starting' | 'running' | 'terminal') =>
    ({ handle: { key } as never, phase }) as Parameters<typeof diffSnapshots>[1][number];

  it('diff: baseline hints only corpses and vanished known keys', () => {
    const known = new Map([['x', k2]]);
    expect(diffSnapshots(null, [snap(KEY, 'terminal')], known)).toEqual([
      { key: KEY, kind: 'terminal' },
      { key: k2, kind: 'terminal' },
    ]);
  });

  it('diff: new -> phase, changed -> phase/terminal, vanished -> terminal', () => {
    const id = (k: SessionKey) => `${k.installSlug}\u0000${k.agentGroupId}\u0000${k.sessionId}`;
    const prev = new Map([[id(KEY), { key: KEY, phase: 'starting' as const }]]);
    expect(diffSnapshots(prev, [snap(KEY, 'running'), snap(k2, 'starting')], undefined)).toEqual([
      { key: KEY, kind: 'phase' },
      { key: k2, kind: 'phase' },
    ]);
    const prev2 = new Map([
      [id(KEY), { key: KEY, phase: 'running' as const }],
      [id(k2), { key: k2, phase: 'running' as const }],
    ]);
    expect(diffSnapshots(prev2, [snap(KEY, 'terminal')], undefined)).toEqual([
      { key: KEY, kind: 'terminal' },
      { key: k2, kind: 'terminal' },
    ]);
  });

  it('one poller per install; emits on change; backs off on failure and recovers; stop() ends polling', async () => {
    vi.useFakeTimers();
    let phase = 'Provisioning';
    let failing = false;
    const { cli, driver } = setup([
      {
        match: /^sandbox list /,
        stdout: () => {
          if (failing) throw new Error('error: transport error: Connection refused');
          return listJson([{ name: NAME, phase, labels: OWN_LABELS }]);
        },
      },
    ]);
    const a: SessionEvent[] = [];
    const b: SessionEvent[] = [];
    const wa = driver.watchSessions('spike', (e) => a.push(e));
    const wb = driver.watchSessions('spike', (e) => b.push(e));

    await vi.advanceTimersByTimeAsync(0); // baseline poll
    expect(cli.calls.length).toBe(1); // one subscription per install, not per subscriber
    expect(a).toEqual([]);

    phase = 'Ready';
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).toEqual([{ key: KEY, kind: 'phase' }]);
    expect(b).toEqual(a);

    failing = true;
    await vi.advanceTimersByTimeAsync(1000); // fails -> retry in 1s
    await vi.advanceTimersByTimeAsync(1000); // fails -> retry in 2s
    const callsWhileDown = cli.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(cli.calls.length).toBe(callsWhileDown); // backing off
    failing = false;
    phase = 'Completed';
    await vi.advanceTimersByTimeAsync(1000); // recovers: baseline re-hints the corpse
    expect(a.at(-1)).toEqual({ key: KEY, kind: 'terminal' });

    wa.stop();
    wb.stop();
    const callsAtStop = cli.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cli.calls.length).toBe(callsAtStop);
  });
});

describe('reapResidue()', () => {
  it('deletes ended sandboxes of this install, never live or gateway-owned ones', async () => {
    const { cli, driver } = setup([
      {
        match: /^sandbox list /,
        stdout: listJson([
          { name: 'ncl-live', phase: 'Ready', labels: OWN_LABELS },
          { name: 'ncl-dead', phase: 'Completed', labels: { ...OWN_LABELS, [LABELS.session]: 's9' } },
          { name: 'ncl-err', phase: 'Error', labels: { ...OWN_LABELS, [LABELS.session]: 's8' } },
          { name: 'gw', phase: 'Stopped', labels: { [LABELS.install]: 'spike', [LABELS.role]: 'gateway' } },
        ]),
      },
      { match: /^sandbox delete /, stdout: '' },
    ]);
    await driver.reapResidue('spike');
    expect(cli.calls[0]).toEqual([
      'sandbox',
      'list',
      '--selector',
      'nanoclaw-install=spike',
      '--page-size',
      '100',
      '-o',
      'json',
    ]);
    expect(cli.callsMatching(/^sandbox delete/)).toEqual([
      ['sandbox', 'delete', 'ncl-dead'],
      ['sandbox', 'delete', 'ncl-err'],
    ]);
  });
});

describe('ensureReady()', () => {
  it('fails fatally with an actionable message when the gateway is unreachable', async () => {
    const { driver } = setup([{ match: /^sandbox list /, fails: 'transport error' }]);
    await expect(driver.ensureReady()).rejects.toThrow(/OpenShell gateway is required but unreachable/);
  });
});

describe('normalizeOpenShellError (real gateway messages @ v0.1.2)', () => {
  it.each([
    [
      'docker bind mounts require enable_bind_mounts = true in [openshell.drivers.docker]',
      'denied-by-policy',
      /enable_bind_mounts = true/,
    ],
    [
      'caller driver config is disabled; a gateway administrator must enable allow_driver_config',
      'denied-by-policy',
      /allow_driver_config = true/,
    ],
    ['external resource not admitted by required labels', 'denied-by-policy', /resource_admission/],
  ])('%s -> %s naming the setting', (msg, kind, re) => {
    const err = normalizeOpenShellError(new Error(msg));
    expect(err.kind).toBe(kind);
    expect((err as unknown as { detail: string }).detail).toMatch(re);
  });

  it.each([
    ['spawn openshell ENOENT', 'runtime-unavailable'],
    ['pull access denied for nanoclaw-agent', 'image-unavailable'],
    ['no space left on device', 'resources-exhausted'],
    ['something novel', 'unknown'],
  ])('%s -> %s', (msg, kind) => {
    expect(normalizeOpenShellError(new Error(msg)).kind).toBe(kind);
  });
});

describe('per-group policy reaches the sandbox (groupPolicy)', () => {
  it("alice's create carries the CRM rule, bob's identical spec does not", async () => {
    const policies: Record<string, unknown> = {};
    const cli = new FakeOpenShellCli();
    cli.rules = [
      { match: /^sandbox get /, fails: 'sandbox not found' },
      {
        match: /^sandbox create /,
        onCall: (args) => {
          const folder = args.find((a) => a.startsWith('nanoclaw-group-folder='))!.split('=')[1];
          policies[folder] = parseYaml(fs.readFileSync(args[args.indexOf('--policy') + 1], 'utf8'));
        },
        stdout: '{}',
      },
    ];
    const model = { name: 'model', host: 'host.openshell.internal', ports: [18790], binaries: ['/usr/local/bin/bun'] };
    const crm = { name: 'crm_api', host: 'host.openshell.internal', ports: [18791], binaries: ['/usr/bin/curl'] };
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      logger: quietLogger,
      policy: { egress: [model] },
      groupPolicy: { alice: { egress: [crm] } },
    });
    for (const folder of ['alice', 'bob']) {
      const spec = fixtureSpec({
        key: { ...KEY, sessionId: `s-${folder}` },
        labels: { 'nanoclaw-group-folder': folder },
      });
      await (await driver.prepare(spec)).start();
    }
    const rules = (folder: string) =>
      Object.keys((policies[folder] as { network_policies: object }).network_policies).sort();
    expect(rules('alice')).toEqual(['crm_api', 'model']);
    expect(rules('bob')).toEqual(['model']);
  });
});

describe('CLI stderr handling (shapes captured from a live v0.1.2 gateway)', () => {
  const warning = (k: string) =>
    `⚠ ${k} looks like a credential passed as a plain environment variable.\n  The agent inside the sandbox can read this value directly.\n\n  To hide it from the agent, use a provider instead of --env.\n  See: https://docs.nvidia.com/openshell/latest/how-it-works/providers/overview\n\n`;
  const withWarnings = (error: string) =>
    `${warning('ANTHROPIC_AUTH_TOKEN')}${warning('CRM_API_TOKEN')}Provisioning sandbox (structured output on stdout)...\n${error}`;

  it('cliErrorSummary keeps the Error: block, not the leading warnings', () => {
    const raw = withWarnings(
      `Error:   × sandbox entered error phase while provisioning: ContainerCreateFailed:\n  │ mount target '/workspace' is reserved for the OpenShell workspace"`,
    );
    expect(raw.indexOf('Error:')).toBeGreaterThan(500); // the old head-of-stderr matching could never see it
    expect(cliErrorSummary(raw)).toBe(
      `Error: × sandbox entered error phase while provisioning: ContainerCreateFailed: mount target '/workspace' is reserved for the OpenShell workspace"`,
    );
  });

  it('maps a reserved-workspace mount to an actionable spec-invalid', () => {
    const err = normalizeOpenShellError(
      new Error(
        withWarnings(
          `Error:   × sandbox entered error phase while provisioning: ContainerCreateFailed:\n  │ mount target '/workspace' is reserved for the OpenShell workspace"`,
        ),
      ),
    );
    expect(err.kind).toBe('spec-invalid');
    expect((err as unknown as { detail: string }).detail).toMatch(/WORKDIR is outside every mount target/);
  });

  it('still recognizes gateway-config errors behind credential warnings', () => {
    const err = normalizeOpenShellError(
      new Error(
        withWarnings('Error:   × docker bind mounts require enable_bind_mounts = true in [openshell.drivers.docker]'),
      ),
    );
    expect(err.kind).toBe('denied-by-policy');
  });
});
