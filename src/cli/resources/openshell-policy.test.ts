/**
 * `ncl openshell-policy-*` through the real dispatcher: registration, help,
 * operator-only enforcement, session → sandbox resolution, and the exact
 * `openshell` argv each verb runs (against a recording fake CLI — no OpenShell
 * binary or gateway is involved).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { INSTALL_SLUG } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
// The full resource barrel: proves no name collision with any core resource.
import './index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setOpenShellPolicyCli, setOpenShellPolicyLog } from './openshell-policy.js';

registerResourceHelpCommands();

const VERBS = ['list', 'view', 'approve', 'reject', 'add-rule', 'apply-preset'] as const;
const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'mg' };

let calls: string[][];
let replies: Record<string, string | Error>;

function fakeCli(): OpenShellCli {
  return {
    bin: '/opt/openshell/bin/openshell',
    async run(args) {
      calls.push(args);
      const reply = replies[args.slice(0, 2).join(' ')];
      if (reply instanceof Error) throw reply;
      return reply ?? '';
    },
  };
}

async function ok(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  const res = await dispatch({ id: 'r', command, args }, ctx);
  if (!res.ok) throw new Error(res.error.message);
  return res;
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  calls = [];
  replies = {};
  setOpenShellPolicyCli(fakeCli);
  // Never the checkout's own data/.
  setOpenShellPolicyLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'os-policy-log-')), 'changes.jsonl'));
});
afterEach(async () => {
  setOpenShellPolicyCli(null);
  setOpenShellPolicyLog(null);
  await closeDb();
});

describe('openshell-policy resource', () => {
  it('registers exactly the six verbs, all operator-only, without touching `policies`', () => {
    const names = listCommands()
      .map((c) => c.name)
      .filter((n) => n.startsWith('openshell-policy-') && n !== 'openshell-policy-help');
    expect(names.sort()).toEqual(VERBS.map((v) => `openshell-policy-${v}`).sort());
    for (const cmd of listCommands().filter((c) => names.includes(c.name))) expect(cmd.hostOnly).toBe(true);
    expect(listCommands().some((c) => c.name === 'policies-list')).toBe(true);
  });

  it.each(VERBS)('`openshell-policy-%s --help` resolves and shows usage without running anything', async (verb) => {
    const res = await ok(`openshell-policy-${verb}`, { help: true });
    expect(res.human).toContain(`ncl openshell-policy ${verb}`);
    expect(res.human).toMatch(/--sandbox/);
    expect(calls).toEqual([]);
  });

  it('is refused for agents, even with global scope', async () => {
    const res = await dispatch({ id: 'r', command: 'openshell-policy-list', args: { sandbox: 'ncl-abc' } }, agent);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toMatch(/operator-only/);
    expect(calls).toEqual([]);
  });

  it('list: pending proposals plus a note that the agent cannot draft rules itself', async () => {
    replies['rule get'] = "No network rules for sandbox 'ncl-abc'\n";
    replies['settings get'] = JSON.stringify({ settings: {} });
    const res = await ok('openshell-policy-list', { sandbox: 'ncl-abc' });
    expect(calls).toEqual([
      ['rule', 'get', 'ncl-abc', '--status', 'pending'],
      ['settings', 'get', 'ncl-abc', '--json'],
    ]);
    expect(res.data).toMatchObject({ proposals: 'unset' });
    expect(res.human).toMatch(
      /No network rules[\s\S]*Note: Proposals here come from connections OpenShell denied\. agent_policy_proposals_enabled is not set/,
    );
  });

  it('list: no note when proposals are on; settings failure reads as unknown, not on', async () => {
    replies['settings get'] = JSON.stringify({
      settings: { agent_policy_proposals_enabled: { value: 'true', scope: 'global' } },
    });
    expect((await ok('openshell-policy-list', { sandbox: 'ncl-abc' })).data).not.toHaveProperty('note');
    replies['settings get'] = new OpenShellCliError('permission denied', 'permission denied', 1);
    expect((await ok('openshell-policy-list', { sandbox: 'ncl-abc' })).data).toMatchObject({ proposals: 'unknown' });
  });

  it('resolves --session to the sandbox the driver created for it', async () => {
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now });
    await createSession({
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now,
      created_at: now,
    });
    await ok('openshell-policy-view', { session: 'sess-1' });
    const expected = sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId: 'sess-1' });
    expect(calls).toEqual([['policy', 'get', expected, '--full', '-o', 'table']]);
  });

  it('approve / reject / add-rule run the documented OpenShell commands', async () => {
    await ok('openshell-policy-approve', { sandbox: 'ncl-abc', 'chunk-id': 'c1' });
    await ok('openshell-policy-reject', { sandbox: 'ncl-abc', 'chunk-id': 'c2', reason: 'too broad' });
    await ok('openshell-policy-add-rule', {
      sandbox: 'ncl-abc',
      'add-endpoint': 'api.example.com:443',
      binary: '/usr/bin/curl',
      'dry-run': true,
    });
    expect(calls).toEqual([
      ['rule', 'approve', 'ncl-abc', '--chunk-id', 'c1'],
      ['rule', 'reject', 'ncl-abc', '--chunk-id', 'c2', '--reason', 'too broad'],
      [
        'policy',
        'update',
        'ncl-abc',
        '--add-endpoint',
        'api.example.com:443',
        '--binary',
        '/usr/bin/curl',
        '--dry-run',
      ],
    ]);
  });

  it('validates arguments before running anything', async () => {
    const run = (command: string, args: Record<string, unknown>) =>
      dispatch({ id: 'r', command, args }, host).then((r) => (r.ok ? '' : r.error.message));
    expect(await run('openshell-policy-approve', { sandbox: 'ncl-abc' })).toMatch(/--chunk-id is required/);
    expect(await run('openshell-policy-reject', { sandbox: 'ncl-abc', 'chunk-id': 'c' })).toMatch(
      /--reason is required/,
    );
    expect(await run('openshell-policy-list', {})).toMatch(/exactly one of --sandbox/);
    expect(await run('openshell-policy-list', { sandbox: 'a', session: 'b' })).toMatch(/exactly one/);
    expect(await run('openshell-policy-view', { session: 'missing' })).toMatch(/session not found/);
    expect(await run('openshell-policy-add-rule', { sandbox: 'ncl-abc' })).toMatch(/nothing to change/);
    expect(await run('openshell-policy-list', { sandbox: 'ncl-abc', status: 'all' })).toMatch(/must be one of/);
    expect(calls).toEqual([]);
  });

  it('names the setting to fix when the openshell CLI is missing', async () => {
    replies['policy get'] = new OpenShellCliError('spawn ENOENT', 'spawn ENOENT', 'ENOENT');
    const res = await dispatch({ id: 'r', command: 'openshell-policy-view', args: { sandbox: 'ncl-abc' } }, host);
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error.message).toMatch(/openshell CLI not found at '\/opt\/openshell\/bin\/openshell'.*OPENSHELL_BIN/);
  });
});
