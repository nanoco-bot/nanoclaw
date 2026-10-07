/**
 * `ncl openshell-provider attach/detach` also apply the change live to the
 * group's running sandboxes (`openshell sandbox provider attach|detach
 * <sandbox> <name> --wait`), after the durable write and never instead of it.
 * Against a recording fake `openshell` CLI and a test DB with seeded sessions.
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

const restartAgentGroupContainers = vi.hoisted(() => vi.fn(async () => 1));
vi.mock('../../container-restart.js', () => ({ restartAgentGroupContainers }));

import { INSTALL_SLUG } from '../../config.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { attachGroupProvider, listGroupProviders } from '../../db/openshell-group-resources.js';
import { createSession } from '../../db/sessions.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import type { Session } from '../../types.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
import './index.js';
import { readChanges, setOpenShellPolicyLog } from './openshell-change-log.js';
import { setOpenShellPolicyCli } from './openshell-policy.js';

const host: CallerContext = { caller: 'host' };
let tmp: string;
let calls: { args: string[]; timeoutMs?: number }[];
let failOn: (args: string[]) => string | null;

const sb = (sessionId: string) => sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId });
const live = (verb: 'attach' | 'detach', sandbox: string, name = 'gh') => [
  'sandbox',
  'provider',
  verb,
  sandbox,
  name,
  '--wait',
  '--timeout',
  '25',
];

function fakeCli(): OpenShellCli {
  return {
    bin: '/usr/bin/openshell',
    async run(args, opts) {
      calls.push({ args, timeoutMs: opts?.timeoutMs });
      const msg = failOn(args);
      if (msg) throw new OpenShellCliError(msg, msg, 1);
      return 'ok';
    },
  };
}

async function session(id: string, container_status: Session['container_status'], agent_group_id = 'ag-1') {
  await createSession({
    id,
    agent_group_id,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: container_status === 'stopped' ? 'closed' : 'active',
    container_status,
    last_active: null,
    created_at: new Date().toISOString(),
  });
}

async function run(command: string, args: Record<string, unknown>) {
  const res = await dispatch({ id: 'r', command, args }, host);
  if (!res.ok) throw new Error(res.error.message);
  return res as {
    data: { saved: boolean; live: { sandbox: string; ok: boolean; error?: string }[]; message: string };
  };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const [id, name, folder] of [
    ['ag-1', 'Alice', 'alice'],
    ['ag-2', 'Bob', 'bob'],
  ]) {
    await createAgentGroup({ id, name, folder, agent_provider: null, created_at: '2026-10-01T00:00:00.000Z' });
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-prov-live-'));
  calls = [];
  failOn = () => null;
  setOpenShellPolicyCli(fakeCli);
  setOpenShellPolicyLog(path.join(tmp, 'changes.jsonl'));
});
afterEach(async () => {
  setOpenShellPolicyCli(null);
  setOpenShellPolicyLog(null);
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('attach', () => {
  it('saved, then `sandbox provider attach --wait` on each running/idle sandbox of the group only', async () => {
    await session('s1', 'running');
    await session('s-idle', 'idle');
    await session('s-stopped', 'stopped');
    await session('s-bob', 'running', 'ag-2');
    const res = await run('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(calls.map((c) => c.args)).toEqual([
      ['provider', 'get', 'gh'],
      live('attach', sb('s1')),
      live('attach', sb('s-idle')),
    ]);
    expect(calls.slice(1).every((c) => c.timeoutMs === 30_000)).toBe(true);
    expect(res.data.saved).toBe(true);
    expect(res.data.live).toEqual([
      { sandbox: sb('s1'), ok: true },
      { sandbox: sb('s-idle'), ok: true },
    ]);
    expect(res.data.message).toBe(
      `Attached OpenShell provider gh to alice for future sandboxes. Applied live to ${sb('s1')}, ${sb('s-idle')}.`,
    );
    expect((await listGroupProviders('ag-1')).map((p) => p.name)).toEqual(['gh']);
  });

  it('no running sandbox: no live call; the durable write alone is success', async () => {
    await session('s-stopped', 'stopped');
    const res = await run('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(calls.map((c) => c.args)).toEqual([['provider', 'get', 'gh']]);
    expect(res.data).toMatchObject({ saved: true, live: [] });
    expect(res.data.message).toMatch(/No running sandbox to apply it to now\.$/);
  });

  it('a gateway that refuses the provider attaches nothing, live or durable', async () => {
    await session('s1', 'running');
    failOn = (args) => (args[1] === 'get' ? 'not found' : null);
    const res = await dispatch(
      { id: 'r', command: 'openshell-provider-attach', args: { group: 'alice', 'openshell-provider': 'gh' } },
      host,
    );
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await listGroupProviders('ag-1')).toEqual([]);
  });

  it('one sandbox fails: saved, both outcomes reported, nothing thrown, change log has each sandbox', async () => {
    await session('s-a', 'running');
    await session('s-b', 'running');
    failOn = (args) => (args[3] === sb('s-a') ? 'wait timed out' : null);
    const res = await run('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(res.data.live).toEqual(
      expect.arrayContaining([
        { sandbox: sb('s-a'), ok: false, error: 'wait timed out' },
        { sandbox: sb('s-b'), ok: true },
      ]),
    );
    expect(res.data.message).toContain(`Failed on ${sb('s-a')}: wait timed out.`);
    expect((await listGroupProviders('ag-1')).map((p) => p.name)).toEqual(['gh']); // not rolled back
    const log = readChanges(path.join(tmp, 'changes.jsonl'));
    expect(log.map((r) => [r.verb, r.sandbox ?? null, r.ok, r.provider?.name])).toEqual(
      expect.arrayContaining([
        ['provider-attach', null, true, 'gh'],
        ['provider-attach', sb('s-a'), false, 'gh'],
        ['provider-attach', sb('s-b'), true, 'gh'],
      ]),
    );
  });
});

describe('detach', () => {
  it('removed, then `sandbox provider detach --wait` on the running sandbox', async () => {
    await attachGroupProvider({ agentGroupId: 'ag-1', name: 'gh', type: null, credentials: {} });
    await session('s1', 'running');
    const res = await run('openshell-provider-detach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(calls.map((c) => c.args)).toEqual([live('detach', sb('s1'))]);
    expect(res.data.live).toEqual([{ sandbox: sb('s1'), ok: true }]);
    expect(res.data.message).toBe(
      `Detached OpenShell provider gh from alice for future sandboxes. Applied live to ${sb('s1')}.`,
    );
    expect(await listGroupProviders('ag-1')).toEqual([]);
  });
});

describe('--restart', () => {
  it('attach --restart with a running sandbox restarts the group after the live attach', async () => {
    restartAgentGroupContainers.mockClear();
    await session('s1', 'running');
    const res = await run('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'gh', restart: true });
    expect(restartAgentGroupContainers).toHaveBeenCalledWith('ag-1', 'openshell provider attached');
    expect(res.data).toMatchObject({ restarted: 1 });
    expect(res.data.message).toMatch(/Restarted 1 container so the agent picks it up now\.$/);
  });

  it('without --restart, or with nothing running, nothing is restarted', async () => {
    restartAgentGroupContainers.mockClear();
    await session('s1', 'running');
    const plain = await run('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(plain.data).not.toHaveProperty('restarted');
    await run('openshell-provider-detach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
  });

  it('detach --restart with nothing running restarts nothing and says so in data', async () => {
    restartAgentGroupContainers.mockClear();
    await attachGroupProvider({ agentGroupId: 'ag-1', name: 'gh', type: null, credentials: {} });
    const res = await run('openshell-provider-detach', { group: 'alice', 'openshell-provider': 'gh', restart: true });
    expect(restartAgentGroupContainers).not.toHaveBeenCalled();
    expect(res.data).toMatchObject({ restarted: 0 });
  });
});

describe('the approval-tier description states the blast radius', () => {
  it.each(['openshell-provider-attach', 'openshell-provider-detach'])('%s mentions live sandboxes', (name) => {
    const cmd = listCommands().find((c) => c.name === name)!;
    expect(cmd.access).toBe('approval');
    expect(cmd.description).toMatch(/running now/);
    expect(cmd.description).toMatch(/several live sandboxes at once/);
  });
});
