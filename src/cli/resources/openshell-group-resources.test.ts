/**
 * `ncl openshell-provider-*` and `ncl openshell-network-*` through the real
 * dispatcher, against a recording fake `openshell` CLI and a test DB:
 * per-group (id / folder / name), operator-only, argv built by the pure
 * provider-commands.ts builders, credentials only ever in the child env, and
 * every change in the shared change log.
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

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { credentialValueHash, listGroupEgressRules, listGroupProviders } from '../../db/openshell-group-resources.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import {
  groupEgressRule,
  providerCreateInvocation,
  providerGetArgs,
  stringMap,
} from '../../drivers/openshell/provider-commands.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
import './index.js';
import { readChanges, setOpenShellPolicyLog } from './openshell-change-log.js';
import { setOpenShellNetworkFileRules } from './openshell-network.js';
import { setOpenShellPolicyCli } from './openshell-policy.js';

const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'mg' };
const SECRET = 'ghp_FIXTUREfixtureFIXTUREfixture0123';

let tmp: string;
let calls: { args: string[]; env?: Record<string, string> }[];
let fail: ((args: string[]) => string | null) | null;

function fakeCli(): OpenShellCli {
  return {
    bin: '/usr/bin/openshell',
    async run(args, opts) {
      calls.push({ args, ...(opts?.env ? { env: opts.env } : {}) });
      const msg = fail?.(args);
      if (msg) throw new OpenShellCliError(msg, msg, 1);
      return '';
    },
  };
}
async function ok(command: string, args: Record<string, unknown>, ctx = host) {
  const res = await dispatch({ id: 'r', command, args }, ctx);
  if (!res.ok) throw new Error(res.error.message);
  return res;
}
async function errorOf(command: string, args: Record<string, unknown>, ctx = host) {
  const res = await dispatch({ id: 'r', command, args }, ctx);
  return res.ok ? '' : res.error.message;
}

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-group-cli-'));
  calls = [];
  fail = null;
  setOpenShellPolicyCli(fakeCli);
  setOpenShellPolicyLog(path.join(tmp, 'changes.jsonl'));
  setOpenShellNetworkFileRules(() => ['file_rule']);
});
afterEach(async () => {
  setOpenShellPolicyCli(null);
  setOpenShellPolicyLog(null);
  setOpenShellNetworkFileRules(null);
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('pure builders (provider-commands.ts)', () => {
  it('provider create: credential KEY names on argv, values only in the child env', () => {
    expect(
      providerCreateInvocation({
        name: 'github-alice',
        type: 'github',
        credentials: { GITHUB_TOKEN: SECRET },
        config: { base_url: 'https://api.github.com' },
      }),
    ).toEqual({
      args: [
        'provider',
        'create',
        '--name',
        'github-alice',
        '--type',
        'github',
        '--credential',
        'GITHUB_TOKEN',
        '--config',
        'base_url=https://api.github.com',
      ],
      env: { GITHUB_TOKEN: SECRET },
    });
    expect(providerGetArgs('github-alice')).toEqual(['provider', 'get', 'github-alice']);
  });

  it.each([
    [{ name: '-x', type: 'github' }, /not a valid OpenShell provider name/],
    [{ name: 'p', type: 'GitHub' }, /not a valid OpenShell provider type/],
    [{ name: 'p', type: 'github', credentials: { PATH: 'x' } }, /reserved/],
    [{ name: 'p', type: 'github', credentials: { 'bad-name': 'x' } }, /environment-variable name/],
    [{ name: 'p', type: 'github', config: { k: '--evil' } }, /may not start with '-'/],
  ])('refuses %o', (input, error) => {
    expect(() => providerCreateInvocation(input as never)).toThrow(error);
  });

  it('stringMap never echoes a value it refuses', () => {
    expect(() => stringMap(`{"GITHUB_TOKEN": "${SECRET}"`, 'credential')).toThrow(/must be a JSON object/);
    try {
      stringMap(`{"GITHUB_TOKEN": "${SECRET}"`, 'credential');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(SECRET);
      expect((e as Error).cause).toBeUndefined();
    }
  });

  it('group network rule: EgressRule shape, ports parsed, reserved names refused', () => {
    expect(
      groupEgressRule({ name: 'crm', host: 'api.hubapi.com', ports: '443,8443', binaries: '/usr/local/bin/node' }),
    ).toEqual({
      name: 'crm',
      host: 'api.hubapi.com',
      ports: [443, 8443],
      binaries: ['/usr/local/bin/node'],
    });
    expect(() => groupEgressRule({ name: 'x', host: 'h:443', ports: 443, binaries: '/b' })).toThrow(/bare host/);
    expect(() => groupEgressRule({ name: 'nanoclaw_gateway', host: 'h', ports: 443, binaries: '/b' })).toThrow(
      /reserved/,
    );
    expect(() => groupEgressRule({ name: 'x', host: 'h', ports: 'abc', binaries: '/b' })).toThrow(/TCP ports/);
    expect(() => groupEgressRule({ name: 'x', host: 'h', ports: 443, binaries: 'node' })).toThrow(/absolute path/);
  });
});

describe('ncl openshell-provider', () => {
  it('registers attach / detach / list, operator-only; attach/detach approval-tier', async () => {
    const cmds = listCommands().filter(
      (c) =>
        c.name.startsWith('openshell-provider-') &&
        !c.name.startsWith('openshell-provider-profile') &&
        c.name !== 'openshell-provider-help',
    );
    expect(cmds.map((c) => c.name).sort()).toEqual([
      'openshell-provider-attach',
      'openshell-provider-detach',
      'openshell-provider-list',
    ]);
    for (const c of cmds) expect(c.hostOnly).toBe(true);
    expect(cmds.find((c) => c.name.endsWith('attach'))!.access).toBe('approval');
    expect(await errorOf('openshell-provider-list', { group: 'alice' }, agent)).toMatch(/operator-only/);
  });

  it('uses --openshell-provider, never --provider (the AI model provider flag)', async () => {
    expect(await errorOf('openshell-provider-attach', { group: 'alice', provider: 'x' })).toMatch(
      /--openshell-provider is required|unknown/i,
    );
  });

  it('attach with --type creates in the gateway (values via env only), stores key names + hash, logs no value', async () => {
    const res = await ok('openshell-provider-attach', {
      group: 'Alice', // by display name
      'openshell-provider': 'github-alice',
      type: 'github',
      credentials: { GITHUB_TOKEN: SECRET },
    });
    expect(calls).toEqual([
      {
        args: ['provider', 'create', '--name', 'github-alice', '--type', 'github', '--credential', 'GITHUB_TOKEN'],
        env: { GITHUB_TOKEN: SECRET },
      },
    ]);
    const [row] = await listGroupProviders('ag-1');
    expect(row).toMatchObject({ name: 'github-alice', type: 'github', credentialKeys: ['GITHUB_TOKEN'] });
    expect(row.credentialHashes.GITHUB_TOKEN).toBe(credentialValueHash(SECRET));
    const db = JSON.stringify(await getDb().all('SELECT * FROM openshell_group_providers'));
    const log = fs.readFileSync(path.join(tmp, 'changes.jsonl'), 'utf8');
    for (const text of [db, log, JSON.stringify(res)]) expect(text).not.toContain(SECRET);
    expect(readChanges(path.join(tmp, 'changes.jsonl'))[0]).toMatchObject({
      verb: 'provider-attach',
      group: { id: 'ag-1', folder: 'alice' },
      provider: { name: 'github-alice', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
      command: ['provider', 'create', '--name', 'github-alice', '--type', 'github', '--credential', 'GITHUB_TOKEN'],
      ok: true,
    });
  });

  it('credentials arrive as a JSON string too (the flag form)', async () => {
    await ok('openshell-provider-attach', {
      group: 'alice',
      'openshell-provider': 'gh',
      type: 'github',
      credentials: JSON.stringify({ GITHUB_TOKEN: SECRET }),
    });
    expect(calls[0].env).toEqual({ GITHUB_TOKEN: SECRET });
  });

  it('attach without --type: the gateway must already have it (provider get), then it is recorded', async () => {
    await ok('openshell-provider-attach', { group: 'ag-1', 'openshell-provider': 'anthropic-shared' });
    expect(calls.map((c) => c.args)).toEqual([['provider', 'get', 'anthropic-shared']]);
    expect((await listGroupProviders('ag-1')).map((p) => p.name)).toEqual(['anthropic-shared']);
  });

  it('a provider the gateway does not have is not recorded; failure logged, secret scrubbed', async () => {
    fail = (args) => (args[1] === 'get' ? "provider 'ghost' not found" : null);
    expect(await errorOf('openshell-provider-attach', { group: 'alice', 'openshell-provider': 'ghost' })).toMatch(
      /OpenShell has no provider 'ghost'/,
    );
    fail = () => `bad token ${SECRET}`;
    const msg = await errorOf('openshell-provider-attach', {
      group: 'alice',
      'openshell-provider': 'gh',
      type: 'github',
      credentials: { GITHUB_TOKEN: SECRET },
    });
    expect(msg).toBe('openshell provider create failed: bad token [redacted]');
    expect(await listGroupProviders('ag-1')).toEqual([]);
    expect(readChanges(path.join(tmp, 'changes.jsonl')).map((r) => r.ok)).toEqual([false, false]);
    expect(fs.readFileSync(path.join(tmp, 'changes.jsonl'), 'utf8')).not.toContain(SECRET);
  });

  it('credentials without --type are refused (nothing to create them in)', async () => {
    expect(
      await errorOf('openshell-provider-attach', {
        group: 'alice',
        'openshell-provider': 'gh',
        credentials: { K: 'v' },
      }),
    ).toMatch(/need --type/);
    expect(calls).toEqual([]);
  });

  it('list (key names, never hashes) and detach, per group; unknown group fails', async () => {
    await ok('openshell-provider-attach', {
      group: 'alice',
      'openshell-provider': 'gh',
      type: 'github',
      credentials: { GITHUB_TOKEN: SECRET },
    });
    await ok('openshell-provider-attach', { group: 'bob', 'openshell-provider': 'shared' });
    const list = await ok('openshell-provider-list', { group: 'alice' });
    expect((list.data as { providers: unknown[] }).providers).toEqual([
      {
        agentGroupId: 'ag-1',
        name: 'gh',
        type: 'github',
        credentialKeys: ['GITHUB_TOKEN'],
        attachedAt: expect.any(String),
      },
    ]);
    expect(JSON.stringify(list)).not.toContain(credentialValueHash(SECRET));
    await ok('openshell-provider-detach', { group: 'alice', 'openshell-provider': 'gh' });
    expect(await listGroupProviders('ag-1')).toEqual([]);
    expect((await listGroupProviders('ag-2')).map((p) => p.name)).toEqual(['shared']);
    expect(await errorOf('openshell-provider-detach', { group: 'alice', 'openshell-provider': 'gh' })).toMatch(
      /not attached/,
    );
    expect(await errorOf('openshell-provider-list', { group: 'nobody' })).toBe('agent group not found: nobody');
  });
});

describe('ncl openshell-network', () => {
  it('add / replace / list / remove per group, logged; no openshell call', async () => {
    await ok('openshell-network-add', {
      group: 'alice',
      name: 'crm',
      host: 'api.hubapi.com',
      ports: '443',
      binary: '/usr/local/bin/node',
    });
    await ok('openshell-network-add', {
      group: 'alice',
      name: 'crm',
      host: 'api.hubapi.com',
      ports: '443,8443',
      binary: JSON.stringify(['/usr/local/bin/node', '/usr/local/bin/bun']),
    });
    expect((await listGroupEgressRules('ag-1')).map(({ createdAt: _c, ...r }) => r)).toEqual([
      {
        name: 'crm',
        host: 'api.hubapi.com',
        ports: [443, 8443],
        binaries: ['/usr/local/bin/node', '/usr/local/bin/bun'],
      },
    ]);
    expect(await listGroupEgressRules('ag-2')).toEqual([]);
    const list = await ok('openshell-network-list', { group: 'alice' });
    expect(list.human).toContain('crm: api.hubapi.com:443,8443');
    await ok('openshell-network-remove', { group: 'alice', name: 'crm' });
    expect(await listGroupEgressRules('ag-1')).toEqual([]);
    expect(calls).toEqual([]);
    expect(readChanges(path.join(tmp, 'changes.jsonl')).map((r) => r.verb)).toEqual([
      'network-add',
      'network-add',
      'network-remove',
    ]);
  });

  it('refuses a name the policy file already uses for that group (it would fail the next sandbox)', async () => {
    expect(
      await errorOf('openshell-network-add', {
        group: 'alice',
        name: 'file_rule',
        host: 'h.example.com',
        ports: '443',
        binary: '/b',
      }),
    ).toMatch(/already used by NANOCLAW_OPENSHELL_POLICY_FILE/);
  });

  it('is operator-only', async () => {
    expect(await errorOf('openshell-network-list', { group: 'alice' }, agent)).toMatch(/operator-only/);
  });
});
