/**
 * `ncl openshell-provider-*` through the real dispatcher, against a real
 * (in-memory) central DB and a scripted `openshell` CLI — no OpenShell binary
 * or gateway is involved.
 *
 * Covers: registration / operator-only; attach + detach success; group not
 * found; provider not found; persistence (per group, ordered, deduplicated,
 * read back by the driver's own lookup); the live-sandbox path both when the
 * group has a live sandbox and when it has none; partial live failure; the
 * append-only audit log for every attempt; and the system-wide profile verbs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { INSTALL_SLUG } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getGroupOpenShellProviders } from '../../db/container-configs.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { FakeOpenShellCli, listJson } from '../../drivers/openshell/fake-cli.js';
import { createArgs, sandboxName } from '../../drivers/openshell/realize.js';
import { groupProvidersFromDb } from '../../drivers/openshell/register.js';
import { fixtureSpec } from '../../drivers/spec-fixture.js';
import { LABELS } from '../../drivers/types.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
// The full resource barrel: proves no name collision with any core resource.
import './index.js';
import {
  readProviderChanges,
  setOpenShellProviderCli,
  setOpenShellProviderLog,
  type ProviderChangeRecord,
} from './openshell-provider.js';

registerResourceHelpCommands();

const VERBS = ['attach', 'detach', 'list', 'profile-list', 'profile-import', 'profile-update'] as const;
const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'mg' };

const SB1 = sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId: 'sess-1' });
const SB2 = sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId: 'sess-2' });
const SB_ENDED = sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId: 'sess-0' });

function sandboxDoc(name: string, phase: string, group = 'ag-1') {
  return {
    name,
    phase,
    labels: { [LABELS.install]: INSTALL_SLUG, [LABELS.group]: group, [LABELS.role]: 'agent', [LABELS.session]: 's' },
  };
}

let cli: FakeOpenShellCli;
let logFile: string;

/** The gateway knows these providers; `provider get` of anything else is NotFound. */
function knownProviders(...names: string[]) {
  const known = names.map((n) => n.replace(/\./g, '\\.')).join('|');
  cli.rules.push(
    { match: new RegExp(`^provider get (${known})$`), stdout: (args) => `Provider: ${args[2]}\n` },
    { match: /^provider get /, fails: 'Error: × status: NotFound, message: "provider not found"' },
  );
}

/** What `sandbox list --selector …` returns for the group. */
function liveSandboxes(docs: ReturnType<typeof sandboxDoc>[]) {
  cli.rules.push({ match: /^sandbox list /, stdout: listJson(docs) });
}

async function run(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  return dispatch({ id: 'r', command, args }, ctx);
}

async function ok(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  const res = await run(command, args, ctx);
  if (!res.ok) throw new Error(res.error.message);
  return res;
}

async function fails(command: string, args: Record<string, unknown>): Promise<string> {
  const res = await run(command, args);
  if (res.ok) throw new Error(`expected ${command} to fail`);
  return res.error.message;
}

const logged = (): ProviderChangeRecord[] => readProviderChanges(logFile);

beforeEach(async () => {
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Main', folder: 'main', agent_provider: null, created_at: now });
  await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now });
  cli = new FakeOpenShellCli();
  setOpenShellProviderCli(() => cli);
  // Never the checkout's own data/.
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'os-provider-log-')), 'changes.jsonl');
  setOpenShellProviderLog(logFile);
});
afterEach(async () => {
  setOpenShellProviderCli(null);
  setOpenShellProviderLog(null);
  await closeDb();
});

describe('openshell-provider resource: registration', () => {
  it('registers exactly its verbs, all operator-only', () => {
    const names = listCommands()
      .map((c) => c.name)
      .filter((n) => n.startsWith('openshell-provider-') && n !== 'openshell-provider-help');
    expect(names.sort()).toEqual(VERBS.map((v) => `openshell-provider-${v}`).sort());
    for (const cmd of listCommands().filter((c) => names.includes(c.name))) expect(cmd.hostOnly).toBe(true);
  });

  it.each(VERBS)('`openshell-provider-%s --help` shows usage without running anything', async (verb) => {
    const res = await ok(`openshell-provider-${verb}`, { help: true });
    expect(res.human).toContain(`ncl openshell-provider ${verb}`);
    expect(cli.calls).toEqual([]);
  });

  it('is refused for agents (no attach, no DB write, nothing run)', async () => {
    const res = await run('openshell-provider-attach', { group: 'ag-1', provider: 'granola' }, agent);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/operator-only/);
    expect(cli.calls).toEqual([]);
    expect(await getGroupOpenShellProviders('ag-1')).toEqual([]);
  });
});

describe('attach', () => {
  it('success with NO live sandbox: persisted, verified with the gateway, nothing attached live', async () => {
    knownProviders('granola');
    liveSandboxes([]);
    const res = await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });

    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
    expect(cli.calls[0]).toEqual(['provider', 'get', 'granola']);
    expect(cli.calls[1].slice(0, 4)).toEqual([
      'sandbox',
      'list',
      '--selector',
      `${LABELS.install}=${INSTALL_SLUG},${LABELS.group}=ag-1,${LABELS.role}=agent`,
    ]);
    expect(cli.callsMatching(/^sandbox provider/)).toEqual([]);
    expect(res.data).toMatchObject({ changed: true, providers: ['granola'], live: [] });
    expect(res.human).toMatch(/No live sandbox for this group right now; takes effect with the next session/);

    expect(logged()).toEqual([
      expect.objectContaining({
        verb: 'attach',
        caller: 'host',
        group: 'ag-1',
        provider: 'granola',
        ok: true,
        persisted: true,
        providers: ['granola'],
        live: [],
      }),
    ]);
  });

  it('success WITH live sandboxes: attaches immediately to each non-ended one', async () => {
    knownProviders('granola');
    liveSandboxes([sandboxDoc(SB1, 'Ready'), sandboxDoc(SB2, 'Provisioning'), sandboxDoc(SB_ENDED, 'Completed')]);
    cli.rules.push({ match: /^sandbox provider attach /, stdout: 'attached\n' });
    const res = await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });

    expect(cli.callsMatching(/^sandbox provider/)).toEqual([
      ['sandbox', 'provider', 'attach', SB1, 'granola'],
      ['sandbox', 'provider', 'attach', SB2, 'granola'],
    ]);
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
    expect(res.human).toContain(`Applied now to 2 live sandbox(es): ${SB1}, ${SB2}`);
    expect(logged()[0]).toMatchObject({
      ok: true,
      live: [
        { sandbox: SB1, command: ['sandbox', 'provider', 'attach', SB1, 'granola'], ok: true },
        { sandbox: SB2, command: ['sandbox', 'provider', 'attach', SB2, 'granola'], ok: true },
      ],
    });
  });

  it('accepts the group folder as well as its id', async () => {
    knownProviders('granola');
    liveSandboxes([]);
    await ok('openshell-provider-attach', { group: 'main', provider: 'granola' });
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
  });

  it('group not found: refused before anything runs, logged as a failed attempt', async () => {
    knownProviders('granola');
    expect(await fails('openshell-provider-attach', { group: 'nope', provider: 'granola' })).toMatch(
      /agent group not found: nope/,
    );
    expect(cli.calls).toEqual([]);
    expect(logged()).toEqual([
      expect.objectContaining({ verb: 'attach', group: 'nope', provider: 'granola', ok: false, persisted: false }),
    ]);
  });

  it('provider not found at the gateway: nothing persisted, nothing attached, logged', async () => {
    knownProviders('granola');
    liveSandboxes([sandboxDoc(SB1, 'Ready')]);
    expect(await fails('openshell-provider-attach', { group: 'ag-1', provider: 'missing' })).toMatch(
      /provider not found: missing/,
    );
    expect(await getGroupOpenShellProviders('ag-1')).toEqual([]);
    expect(cli.callsMatching(/^sandbox /)).toEqual([]);
    expect(logged()[0]).toMatchObject({ ok: false, persisted: false, provider: 'missing' });
  });

  it('an unreachable gateway cannot vouch for the provider: refused, not persisted', async () => {
    cli.rules.push({ match: /^provider get /, fails: 'error: transport error: Connection refused' });
    expect(await fails('openshell-provider-attach', { group: 'ag-1', provider: 'granola' })).toMatch(
      /could not verify provider granola/,
    );
    expect(await getGroupOpenShellProviders('ag-1')).toEqual([]);
  });

  it('refuses a provider name the CLI could misread as a flag', async () => {
    expect(await fails('openshell-provider-attach', { group: 'ag-1', provider: '--global' })).toMatch(
      /not a valid OpenShell provider name/,
    );
    expect(cli.calls).toEqual([]);
    expect(logged()[0]).toMatchObject({ ok: false, provider: '--global' });
  });

  it('a live attach that fails: the durable change stays, the command fails saying exactly what landed', async () => {
    knownProviders('granola');
    liveSandboxes([sandboxDoc(SB1, 'Ready'), sandboxDoc(SB2, 'Ready')]);
    cli.rules.push({ match: new RegExp(`^sandbox provider attach ${SB1} `), stdout: '' });
    cli.rules.push({
      match: new RegExp(`^sandbox provider attach ${SB2} `),
      fails: 'status: Internal, message: "boom"',
    });
    const msg = await fails('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    expect(msg).toMatch(/saved for group main .*applied to 1 of 2 live sandbox\(es\); failed on: .*boom/);
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
    expect(logged()[0]).toMatchObject({
      ok: false,
      persisted: true,
      providers: ['granola'],
      live: [
        { sandbox: SB1, ok: true },
        { sandbox: SB2, ok: false, error: expect.stringMatching(/boom/) },
      ],
    });
  });

  it('cannot list live sandboxes: the durable change stays, the command says none was changed now', async () => {
    knownProviders('granola');
    cli.rules.push({ match: /^sandbox list /, fails: 'error: transport error: Connection refused' });
    expect(await fails('openshell-provider-attach', { group: 'ag-1', provider: 'granola' })).toMatch(
      /saved for group main .*could not be listed, so none was changed now/,
    );
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
    expect(logged()[0]).toMatchObject({ ok: false, persisted: true });
  });

  it('a sandbox that already has the provider counts as done', async () => {
    knownProviders('granola');
    liveSandboxes([sandboxDoc(SB1, 'Ready')]);
    cli.rules.push({ match: /^sandbox provider attach /, fails: 'provider granola is already attached' });
    const res = await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    expect(res.data).toMatchObject({ live: [{ sandbox: SB1, ok: true }] });
  });
});

describe('persistence', () => {
  it('per group, in attach order, deduplicated; read back by the driver lookup into --provider flags', async () => {
    knownProviders('granola', 'github-main');
    liveSandboxes([]);
    await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    await ok('openshell-provider-attach', { group: 'ag-1', provider: 'github-main' });
    const again = await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    expect(again.data).toMatchObject({ changed: false });
    expect(again.human).toMatch(/already attached/);

    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola', 'github-main']);
    expect(await getGroupOpenShellProviders('ag-2')).toEqual([]); // other groups untouched

    // The exact lookup register.ts wires into the driver, feeding createArgs.
    const providers = await groupProvidersFromDb({ agentGroupId: 'ag-1' });
    const spec = fixtureSpec();
    const args = createArgs({
      spec,
      container: spec.containers[0],
      name: 'ncl-x',
      policyPath: '/tmp/p.yaml',
      driverConfig: null,
      providers,
    });
    expect(args.flatMap((a, i) => (a === '--provider' ? [args[i + 1]] : []))).toEqual(['granola', 'github-main']);
  });

  it('survives a fresh read of the row (it is the DB, not process memory)', async () => {
    knownProviders('granola');
    liveSandboxes([]);
    await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    const { getDb } = await import('../../db/connection.js');
    const row = await getDb().get<{ openshell_providers: string }>(
      'SELECT openshell_providers FROM container_configs WHERE agent_group_id = ?',
      'ag-1',
    );
    expect(JSON.parse(row!.openshell_providers)).toEqual(['granola']);
  });
});

describe('detach', () => {
  async function attached(...names: string[]) {
    knownProviders(...names);
    liveSandboxes([]);
    for (const n of names) await ok('openshell-provider-attach', { group: 'ag-1', provider: n });
    cli.rules = [];
    cli.calls.length = 0;
    fs.rmSync(logFile, { force: true });
  }

  it('success with NO live sandbox: removed from the group, nothing detached live', async () => {
    await attached('granola', 'github-main');
    liveSandboxes([]);
    const res = await ok('openshell-provider-detach', { group: 'ag-1', provider: 'granola' });
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['github-main']);
    expect(cli.callsMatching(/^sandbox provider/)).toEqual([]);
    // Detach does not need the provider to still exist at the gateway.
    expect(cli.callsMatching(/^provider get/)).toEqual([]);
    expect(res.data).toMatchObject({ changed: true, providers: ['github-main'], live: [] });
    expect(logged()).toEqual([
      expect.objectContaining({ verb: 'detach', ok: true, persisted: true, providers: ['github-main'] }),
    ]);
  });

  it('success WITH a live sandbox: detached immediately', async () => {
    await attached('granola');
    liveSandboxes([sandboxDoc(SB1, 'Ready')]);
    cli.rules.push({ match: /^sandbox provider detach /, stdout: '' });
    await ok('openshell-provider-detach', { group: 'ag-1', provider: 'granola' });
    expect(cli.callsMatching(/^sandbox provider/)).toEqual([['sandbox', 'provider', 'detach', SB1, 'granola']]);
    expect(await getGroupOpenShellProviders('ag-1')).toEqual([]);
  });

  it('provider not attached to the group: refused, nothing run, logged', async () => {
    await attached('granola');
    expect(await fails('openshell-provider-detach', { group: 'ag-1', provider: 'other' })).toMatch(
      /provider not found on group main: other is not attached \(attached: granola\)/,
    );
    expect(cli.calls).toEqual([]);
    expect(await getGroupOpenShellProviders('ag-1')).toEqual(['granola']);
    expect(logged()[0]).toMatchObject({ verb: 'detach', ok: false, persisted: false });
  });

  it('group not found', async () => {
    expect(await fails('openshell-provider-detach', { group: 'ghost', provider: 'granola' })).toMatch(
      /agent group not found: ghost/,
    );
    expect(logged()[0]).toMatchObject({ verb: 'detach', ok: false, group: 'ghost' });
  });
});

describe('list', () => {
  it("shows the group's providers and live sandboxes", async () => {
    knownProviders('granola');
    liveSandboxes([]);
    await ok('openshell-provider-attach', { group: 'ag-1', provider: 'granola' });
    cli.rules = [];
    liveSandboxes([sandboxDoc(SB1, 'Ready')]);
    const res = await ok('openshell-provider-list', { group: 'main' });
    expect(res.data).toEqual({
      group: { id: 'ag-1', name: 'Main', folder: 'main' },
      providers: ['granola'],
      sandboxes: [{ name: SB1, phase: 'Ready' }],
    });
    expect(res.human).toMatch(/Attached providers: granola/);
  });

  it('still shows the persisted list when the gateway is down', async () => {
    cli.rules.push({ match: /^sandbox list /, fails: 'transport error' });
    const res = await ok('openshell-provider-list', { group: 'ag-1' });
    expect(res.data).toMatchObject({ providers: [], sandboxesError: expect.stringMatching(/transport error/) });
  });

  it('group not found', async () => {
    expect(await fails('openshell-provider-list', { group: 'nope' })).toMatch(/agent group not found/);
  });

  it('does not write the audit log', async () => {
    liveSandboxes([]);
    await ok('openshell-provider-list', { group: 'ag-1' });
    expect(logged()).toEqual([]);
  });
});

describe('profiles (system-wide)', () => {
  it('profile-list runs `provider profile list`', async () => {
    cli.rules.push({ match: /^provider profile list/, stdout: 'ID  NAME\ngranola  Granola\n' });
    const res = await ok('openshell-provider-profile-list', { output: 'json', global: true });
    expect(cli.calls).toEqual([['provider', 'profile', 'list', '-o', 'json', '--global']]);
    expect(res.human).toContain('granola');
  });

  it('profile-import from a file path', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), 'granola.yaml');
    fs.writeFileSync(file, 'id: granola\n');
    cli.rules.push({ match: /^provider profile import /, stdout: 'Imported granola\n' });
    await ok('openshell-provider-profile-import', { file });
    expect(cli.calls).toEqual([['provider', 'profile', 'import', '-f', file]]);
    expect(logged()).toEqual([
      expect.objectContaining({
        verb: 'profile-import',
        ok: true,
        command: ['provider', 'profile', 'import', '-f', file],
      }),
    ]);
  });

  it('profile-import from inline YAML: staged privately for the call, removed afterwards', async () => {
    let staged = '';
    cli.rules.push({
      match: /^provider profile import /,
      onCall: (args) => {
        staged = args[args.indexOf('-f') + 1];
        expect(fs.readFileSync(staged, 'utf8')).toBe('id: granola\nname: Granola\n');
        expect(fs.statSync(staged).mode & 0o777).toBe(0o600);
      },
      stdout: 'Imported granola\n',
    });
    await ok('openshell-provider-profile-import', { yaml: 'id: granola\nname: Granola\n' });
    expect(staged).not.toBe('');
    expect(fs.existsSync(staged)).toBe(false);
    expect(logged()[0]).toMatchObject({ command: ['provider', 'profile', 'import', '-f', '<inline yaml>'] });
  });

  it('profile-import needs exactly one source, and an existing file', async () => {
    expect(await fails('openshell-provider-profile-import', {})).toMatch(/exactly one of --file/);
    expect(await fails('openshell-provider-profile-import', { file: '/x.yaml', yaml: 'a: 1' })).toMatch(/exactly one/);
    expect(await fails('openshell-provider-profile-import', { file: '/does/not/exist.yaml' })).toMatch(
      /profile file not found/,
    );
    expect(cli.calls).toEqual([]);
  });

  it('profile-update takes the profile id and logs failures too', async () => {
    cli.rules.push({
      match: /^provider profile update /,
      fails: 'status: FailedPrecondition, message: "builtin profile"',
    });
    expect(await fails('openshell-provider-profile-update', { id: 'granola', yaml: 'id: granola\n' })).toMatch(
      /builtin profile/,
    );
    expect(cli.calls[0].slice(0, 4)).toEqual(['provider', 'profile', 'update', 'granola']);
    expect(logged()[0]).toMatchObject({ verb: 'profile-update', profile: 'granola', ok: false });
    expect(await fails('openshell-provider-profile-update', { id: 'Bad Id', yaml: 'x' })).toMatch(/profile id/);
  });
});
