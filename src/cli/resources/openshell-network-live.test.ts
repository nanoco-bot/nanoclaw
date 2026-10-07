/**
 * Part D: `ncl openshell-network add/remove` also apply the change live to the
 * group's running sandboxes (container_status running/idle), after the durable
 * write and never instead of it. Against a recording fake `openshell` CLI and a
 * test DB with seeded sessions.
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
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { listGroupEgressRules, putGroupEgressRule } from '../../db/openshell-group-resources.js';
import { createSession } from '../../db/sessions.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import type { Session } from '../../types.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
import './index.js';
import { readChanges, setOpenShellPolicyLog } from './openshell-change-log.js';
import { liveSummary, setOpenShellNetworkFileRules } from './openshell-network.js';
import { setOpenShellPolicyCli } from './openshell-policy.js';

const host: CallerContext = { caller: 'host' };
let tmp: string;
let calls: { args: string[]; timeoutMs?: number }[];
let failOn: (args: string[]) => string | null;

const sb = (sessionId: string) => sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: 'ag-1', sessionId });

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
    human?: string;
  };
}

const ADD = {
  group: 'alice',
  name: 'crm',
  host: 'api.hubapi.com',
  ports: '443,8443',
  binary: '["/usr/local/bin/node","/usr/local/bin/bun"]',
};

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Alice',
    folder: 'alice',
    agent_provider: null,
    created_at: '2026-10-01T00:00:00.000Z',
  });
  await createAgentGroup({
    id: 'ag-2',
    name: 'Bob',
    folder: 'bob',
    agent_provider: null,
    created_at: '2026-10-01T00:00:00.000Z',
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-net-live-'));
  calls = [];
  failOn = () => null;
  setOpenShellPolicyCli(fakeCli);
  setOpenShellPolicyLog(path.join(tmp, 'changes.jsonl'));
  setOpenShellNetworkFileRules(() => []);
});
afterEach(async () => {
  setOpenShellPolicyCli(null);
  setOpenShellPolicyLog(null);
  setOpenShellNetworkFileRules(null);
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('(a) one running sandbox', () => {
  it('add: saved, then one `policy update` per port with the rule’s binaries and name (add-rule’s argv)', async () => {
    await session('s1', 'running');
    await session('s-stopped', 'stopped'); // not running: untouched
    await session('s-bob', 'running', 'ag-2'); // another group: untouched
    const res = await run('openshell-network-add', ADD);
    expect(calls.map((c) => c.args)).toEqual([
      [
        'policy',
        'update',
        sb('s1'),
        '--add-endpoint',
        'api.hubapi.com:443',
        '--binary',
        '/usr/local/bin/node',
        '--binary',
        '/usr/local/bin/bun',
        '--rule-name',
        'crm',
      ],
      [
        'policy',
        'update',
        sb('s1'),
        '--add-endpoint',
        'api.hubapi.com:8443',
        '--binary',
        '/usr/local/bin/node',
        '--binary',
        '/usr/local/bin/bun',
        '--rule-name',
        'crm',
      ],
    ]);
    expect(calls.every((c) => c.timeoutMs === 30_000)).toBe(true);
    expect(res.data.saved).toBe(true);
    expect(res.data.live).toEqual([{ sandbox: sb('s1'), ok: true }]);
    expect(res.data.message).toBe(
      `Network path crm (api.hubapi.com:443,8443) saved for future sandboxes of alice. Applied live to ${sb('s1')}.`,
    );
    expect((await listGroupEgressRules('ag-1')).map((r) => r.name)).toEqual(['crm']);
  });

  it('remove: deleted, then `policy update --remove-rule <name>` on the running sandbox; idle counts as running', async () => {
    await putGroupEgressRule('ag-1', {
      name: 'crm',
      host: 'api.hubapi.com',
      ports: [443],
      binaries: ['/usr/bin/curl'],
    });
    await session('s-idle', 'idle');
    const res = await run('openshell-network-remove', { group: 'alice', name: 'crm' });
    expect(calls.map((c) => c.args)).toEqual([['policy', 'update', sb('s-idle'), '--remove-rule', 'crm']]);
    expect(res.data.live).toEqual([{ sandbox: sb('s-idle'), ok: true }]);
    expect(await listGroupEgressRules('ag-1')).toEqual([]);
  });

  it('each live call lands in the change log with its sandbox, after the durable record', async () => {
    await session('s1', 'running');
    await run('openshell-network-add', { ...ADD, ports: '443' });
    expect(readChanges(path.join(tmp, 'changes.jsonl')).map((r) => [r.verb, r.sandbox ?? null, r.ok])).toEqual([
      ['network-add', null, true],
      ['network-add', sb('s1'), true],
    ]);
  });
});

describe('(b) no running sandbox', () => {
  it('add: no live call at all; the durable write alone is success', async () => {
    await session('s-stopped', 'stopped');
    const res = await run('openshell-network-add', ADD);
    expect(calls).toEqual([]);
    expect(res.data).toMatchObject({ saved: true, live: [] });
    expect(res.data.message).toMatch(/saved for future sandboxes of alice\. No running sandbox to apply it to now\.$/);
    expect(await listGroupEgressRules('ag-1')).toHaveLength(1);
  });
});

describe('(c) partial failure', () => {
  it('two running sandboxes, one fails: saved, both outcomes reported, nothing thrown, the other still applied', async () => {
    await session('s-a', 'running');
    await session('s-b', 'running');
    failOn = (args) => (args[2] === sb('s-a') ? "sandbox 's-a' not ready" : null);
    const res = await run('openshell-network-add', { ...ADD, ports: '443' });
    expect(res.data.saved).toBe(true);
    expect(res.data.live).toEqual(
      expect.arrayContaining([
        { sandbox: sb('s-a'), ok: false, error: "sandbox 's-a' not ready" },
        { sandbox: sb('s-b'), ok: true },
      ]),
    );
    expect(res.data.live).toHaveLength(2);
    expect(res.data.message).toContain(`Applied live to ${sb('s-b')}.`);
    expect(res.data.message).toContain(`Failed on ${sb('s-a')}: sandbox 's-a' not ready.`);
    expect((await listGroupEgressRules('ag-1')).map((r) => r.name)).toEqual(['crm']); // not rolled back
    const log = readChanges(path.join(tmp, 'changes.jsonl'));
    expect(log.filter((r) => r.sandbox).map((r) => [r.sandbox, r.ok])).toEqual(
      expect.arrayContaining([
        [sb('s-a'), false],
        [sb('s-b'), true],
      ]),
    );
  });

  it('a sandbox whose first port fails is not sent its second port (one error per sandbox)', async () => {
    await session('s-a', 'running');
    failOn = (args) => (args.includes('api.hubapi.com:443') ? 'boom' : null);
    const res = await run('openshell-network-add', ADD);
    expect(calls).toHaveLength(1);
    expect(res.data.live).toEqual([{ sandbox: sb('s-a'), ok: false, error: 'boom' }]);
  });

  it('liveSummary wording', () => {
    expect(liveSummary([])).toBe('No running sandbox to apply it to now.');
    expect(
      liveSummary([
        { sandbox: 'a', ok: true },
        { sandbox: 'b', ok: true },
        { sandbox: 'c', ok: false, error: 'x' },
      ]),
    ).toBe('Applied live to a, b. Failed on c: x.');
  });
});

describe('(d) the approval-tier description states the blast radius', () => {
  it.each(['openshell-network-add', 'openshell-network-remove'])('%s mentions live sandboxes', (name) => {
    const cmd = listCommands().find((c) => c.name === name)!;
    expect(cmd.access).toBe('approval');
    expect(cmd.description).toMatch(/running now/);
    expect(cmd.description).toMatch(/several live sandboxes at once/);
  });
});
