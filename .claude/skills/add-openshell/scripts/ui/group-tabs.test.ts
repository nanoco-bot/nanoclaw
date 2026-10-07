/**
 * Part C: per-agent-group tabs. Pure helpers (default sandbox, audit merge),
 * every new/changed route with the group param, and one end-to-end pass over
 * all four tabs for one group with the gateway/CLI mocked.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PolicyFrame } from './commands.js';
import { STATIC_DIR } from './exec.js';
import { groupAudit, sandboxCandidates, type SessionSummary } from './group-view.js';
import { appendDecision, readDecisions } from './history.js';
import { createHandler, type DispatchResult, type UiDeps } from './routes.js';

const ALICE = { id: 'ag-1', name: 'Alice', folder: 'alice' };
const BOB = { id: 'ag-2', name: 'Bob', folder: 'bob' };
const SECRET = 'ghp_FIXTUREfixtureFIXTUREfixture0123';
const sb = (g: string, s: string) => `ncl-${g}-${s}`;

const sessions: Record<string, SessionSummary[]> = {
  'ag-1': [
    { id: 's-old', status: 'active', container_status: 'running', created_at: '2026-10-01T00:00:00Z' },
    { id: 's-new', status: 'active', container_status: 'running', created_at: '2026-10-05T00:00:00Z' },
    { id: 's-idle', status: 'active', container_status: 'idle', created_at: '2026-10-06T00:00:00Z' },
    { id: 's-closed', status: 'closed', container_status: 'stopped', created_at: '2026-10-07T00:00:00Z' },
  ],
  'ag-2': [],
};

describe('sandboxCandidates (default sandbox for Pending approvals)', () => {
  it('active sessions only; running first, newest first; closed sessions excluded', () => {
    expect(sandboxCandidates(sessions['ag-1'], (s) => sb('ag-1', s)).map((c) => c.sessionId)).toEqual([
      's-new',
      's-old',
      's-idle',
    ]);
  });
  it('none live → empty', () => {
    expect(sandboxCandidates([], (s) => s)).toEqual([]);
  });
});

describe('groupAudit', () => {
  const sandboxes = new Set([sb('ag-1', 's-new'), sb('ag-1', 's-closed')]);
  it('keeps the group’s entries from both logs — approved and denied/failed alike — newest first', () => {
    const entries = groupAudit({
      group: ALICE,
      sandboxes,
      changes: [
        {
          ts: '2026-10-05T01:00:00Z',
          verb: 'provider-attach',
          group: { id: 'ag-1' },
          provider: { name: 'gh', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
          ok: true,
          caller: 'host',
        },
        {
          ts: '2026-10-05T02:00:00Z',
          verb: 'add-rule',
          sandbox: sb('ag-1', 's-closed'),
          command: ['policy', 'update'],
          ok: false,
          error: 'nope',
        },
        { ts: '2026-10-05T03:00:00Z', verb: 'network-add', group: { id: 'ag-2' }, rule: { name: 'other' }, ok: true },
        { ts: '2026-10-05T04:00:00Z', verb: 'apply-preset', sandbox: 'ncl-someone-else', ok: true },
      ],
      decisions: [
        {
          ts: '2026-10-05T05:00:00Z',
          sandbox: sb('ag-1', 's-new'),
          chunkId: 'c1',
          decision: 'approved',
          ok: true,
          actor: 'ui',
        },
        {
          ts: '2026-10-05T06:00:00Z',
          sandbox: 'x',
          chunkId: 'c2',
          decision: 'rejected',
          reason: 'too broad',
          ok: true,
          actor: 'ui',
          group: { id: 'ag-1', folder: 'alice' },
        },
        { ts: '2026-10-05T07:00:00Z', sandbox: 'ncl-bob', chunkId: 'c3', decision: 'approved', ok: true, actor: 'ui' },
      ],
      remote: [{ sandbox: sb('ag-1', 's-new'), chunkId: 'c9', decision: 'rejected', source: 'openshell' }],
    });
    expect(entries.map((e) => [e.source, e.action, e.outcome])).toEqual([
      ['decision-log', 'reject', 'rejected'],
      ['decision-log', 'approve', 'approved'],
      ['change-log', 'add-rule', 'failed'],
      ['change-log', 'provider-attach', 'applied'],
      ['openshell', 'reject', 'rejected'],
    ]);
    expect(entries.find((e) => e.action === 'provider-attach')!.detail).toBe(
      'provider gh (github) · keys GITHUB_TOKEN',
    );
  });
});

// ---------------------------------------------------------------- routes

let server: http.Server;
let base: string;
let dir: string;
let deps: UiDeps & { dispatchNcl: ReturnType<typeof vi.fn>; dispatchPolicy: ReturnType<typeof vi.fn> };
let store: { providers: Record<string, unknown[]>; rules: Record<string, unknown[]> };

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text) as Record<string, any>, text };
}

/** A stand-in for the in-process ncl commands, backed by a tiny in-memory store. */
async function fakeNcl(frame: PolicyFrame): Promise<DispatchResult> {
  const a = frame.args as Record<string, any>;
  switch (frame.command) {
    case 'openshell-provider-profile-list':
      return { ok: true, data: { profiles: [] } };
    case 'openshell-provider-list':
      return { ok: true, data: { providers: store.providers[a.group] ?? [] } };
    case 'openshell-provider-attach':
      if (a.type === 'boom')
        return {
          ok: false,
          error: { code: 'handler-error', message: `openshell provider create failed: bad ${SECRET}` },
        };
      (store.providers[a.group] ??= []).push({
        name: a.openshell_provider,
        type: a.type ?? null,
        credentialKeys: Object.keys(a.credentials ?? {}),
      });
      return { ok: true, data: { message: `Attached ${a.openshell_provider}` } };
    case 'openshell-provider-detach':
      store.providers[a.group] = (store.providers[a.group] ?? []).filter((p: any) => p.name !== a.openshell_provider);
      return { ok: true, data: { message: 'Detached' } };
    case 'openshell-network-list':
      return { ok: true, data: { rules: store.rules[a.group] ?? [] } };
    case 'openshell-network-add':
      (store.rules[a.group] ??= []).push({
        name: a.name,
        host: a.host,
        ports: a.ports.split(',').map(Number),
        binaries: JSON.parse(a.binary),
      });
      return { ok: true, data: { message: 'Added' } };
    case 'openshell-network-remove':
      store.rules[a.group] = (store.rules[a.group] ?? []).filter((r: any) => r.name !== a.name);
      return { ok: true, data: { message: 'Removed' } };
    default:
      return { ok: false, error: { code: 'unknown-command', message: frame.command } };
  }
}

const RULES_PENDING = 'Chunk: c-pend\n  Status: pending\n  Rule: allow_api_example_com_443\n  Binary: /usr/bin/curl\n';

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-groups-'));
  store = { providers: {}, rules: {} };
  deps = {
    runOpenShell: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
    dispatchPolicy: vi.fn(
      async (frame: PolicyFrame): Promise<DispatchResult> => ({
        ok: true,
        data: {
          output: frame.command === 'openshell-policy-list' && frame.args.status === 'pending' ? RULES_PENDING : '',
        },
      }),
    ),
    dispatchNcl: vi.fn(fakeNcl),
    runCredentialScript: vi.fn(),
    checkCredentials: vi.fn(() => ({ credentials: 'configured', credentialSource: 'running-service:oauth' })),
    gatewayKind: () => 'openshell',
    listGroups: async () => [ALICE, BOB],
    groupSessions: async (id: string) => sessions[id] ?? [],
    sandboxName: sb,
    changeLog: path.join(dir, 'changes.jsonl'),
    decisionLog: path.join(dir, 'decisions.jsonl'),
    staticDir: STATIC_DIR,
    now: () => new Date('2026-10-06T12:00:00.000Z'),
  } as never;
  server = http.createServer(createHandler(deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('group routes', () => {
  it('GET /api/groups lists the agent groups', async () => {
    expect((await call('GET', '/api/groups')).json.groups).toEqual([ALICE, BOB]);
  });

  it('every per-group route requires a known group', async () => {
    for (const url of ['/api/groups/providers', '/api/groups/network', '/api/groups/policy', '/api/groups/audit']) {
      expect((await call('GET', url)).status).toBe(400);
      expect((await call('GET', `${url}?group=nope`)).status).toBe(404);
    }
    expect((await call('POST', '/api/groups/providers', { group: 'nope', name: 'x' })).status).toBe(404);
  });

  it('providers: attach (create with credentials) / list / detach go through ncl with the group id; secrets never echoed', async () => {
    const r = await call('POST', '/api/groups/providers', {
      group: 'ag-1',
      name: 'gh-alice',
      type: 'github',
      credentials: [
        { key: 'GITHUB_TOKEN', value: SECRET },
        { key: '', value: '' },
      ],
      config: [],
    });
    expect(r.status).toBe(200);
    expect(deps.dispatchNcl).toHaveBeenCalledWith({
      command: 'openshell-provider-attach',
      args: { group: 'ag-1', openshell_provider: 'gh-alice', type: 'github', credentials: { GITHUB_TOKEN: SECRET } },
    });
    expect(r.text).not.toContain(SECRET);
    expect((await call('GET', '/api/groups/providers?group=ag-1')).json.providers).toEqual([
      { name: 'gh-alice', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
    ]);
    expect((await call('GET', '/api/groups/providers?group=ag-2')).json.providers).toEqual([]);
    expect((await call('DELETE', '/api/groups/providers?group=ag-1&name=gh-alice')).status).toBe(200);
    expect((await call('GET', '/api/groups/providers?group=ag-1')).json.providers).toEqual([]);
  });

  it('attach-only (no type) sends no credentials; an ncl refusal is a 400 with the reason, scrubbed', async () => {
    await call('POST', '/api/groups/providers', {
      group: 'ag-1',
      name: 'shared',
      type: '',
      credentials: [{ key: 'K', value: 'v-should-not-go' }],
    });
    expect(deps.dispatchNcl.mock.calls.at(-1)![0]).toEqual({
      command: 'openshell-provider-attach',
      args: { group: 'ag-1', openshell_provider: 'shared', credentials: { K: 'v-should-not-go' } },
    });
    const bad = await call('POST', '/api/groups/providers', {
      group: 'ag-1',
      name: 'x',
      type: 'boom',
      credentials: [{ key: 'GITHUB_TOKEN', value: SECRET }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('openshell provider create failed: bad [redacted]');
  });

  it('network: add / list / remove per group', async () => {
    const add = await call('POST', '/api/groups/network', {
      group: 'ag-1',
      name: 'crm',
      host: 'api.hubapi.com',
      ports: '443,8443',
      binaries: ['/usr/local/bin/node', ' /usr/local/bin/bun '],
    });
    expect(add.status).toBe(200);
    expect(deps.dispatchNcl).toHaveBeenCalledWith({
      command: 'openshell-network-add',
      args: {
        group: 'ag-1',
        name: 'crm',
        host: 'api.hubapi.com',
        ports: '443,8443',
        binary: '["/usr/local/bin/node","/usr/local/bin/bun"]',
      },
    });
    expect((await call('GET', '/api/groups/network?group=ag-1')).json.rules).toHaveLength(1);
    await call('DELETE', '/api/groups/network?group=ag-1&name=crm');
    expect((await call('GET', '/api/groups/network?group=ag-1')).json.rules).toEqual([]);
  });

  it('pending approvals: the default sandbox is the newest running session; others offered; override must be live', async () => {
    const r = await call('GET', '/api/groups/policy?group=ag-1');
    expect(r.json.sandbox).toBe(sb('ag-1', 's-new'));
    expect(r.json.sandboxes.map((c: { sessionId: string }) => c.sessionId)).toEqual(['s-new', 's-old', 's-idle']);
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-list',
      args: { sandbox: sb('ag-1', 's-new'), status: 'pending' },
    });
    expect(r.json.chunks.map((c: { chunkId: string }) => c.chunkId)).toEqual(['c-pend']);
    const pick = await call('GET', `/api/groups/policy?group=ag-1&sandbox=${sb('ag-1', 's-old')}`);
    expect(pick.json.sandbox).toBe(sb('ag-1', 's-old'));
    expect((await call('GET', `/api/groups/policy?group=ag-1&sandbox=${sb('ag-1', 's-closed')}`)).status).toBe(400);
    const none = await call('GET', '/api/groups/policy?group=ag-2');
    expect(none.json).toMatchObject({
      sandbox: null,
      chunks: [],
      note: 'bob has no live session, so no sandbox to review.',
    });
  });

  it('approve/reject from a group tab records the group on the decision', async () => {
    await call('POST', '/api/policy/reject', {
      group: 'ag-1',
      sandbox: sb('ag-1', 's-new'),
      chunkId: 'c-pend',
      reason: 'no',
    });
    expect(readDecisions(deps.decisionLog)[0]).toMatchObject({
      decision: 'rejected',
      group: { id: 'ag-1', folder: 'alice' },
    });
  });

  it('the credential stays install-wide: no group param, unchanged route', async () => {
    const r = await call('GET', '/api/status');
    expect(r.json.credential).toEqual({ credentials: 'configured', source: 'running-service', kind: 'oauth' });
  });
});

describe('all four tabs for one agent group, end to end', () => {
  it('Providers → Network paths → Pending approvals (approve) → Audit log shows all of it, approved and denied', async () => {
    // A change-log record the ncl commands would have written (shared log), and an earlier failed one.
    fs.writeFileSync(
      deps.changeLog,
      [
        {
          ts: '2026-10-06T10:00:00Z',
          verb: 'provider-attach',
          caller: 'host',
          group: { id: 'ag-1', folder: 'alice' },
          provider: { name: 'gh-alice', type: 'github', credentialKeys: ['GITHUB_TOKEN'] },
          ok: true,
        },
        {
          ts: '2026-10-06T10:05:00Z',
          verb: 'apply-preset',
          caller: 'host',
          sandbox: sb('ag-1', 's-old'),
          preset: { name: 'github', version: 1, rule: 'github_api' },
          ok: false,
          error: 'gateway said no',
        },
        {
          ts: '2026-10-06T10:06:00Z',
          verb: 'network-add',
          caller: 'host',
          group: { id: 'ag-2', folder: 'bob' },
          rule: { name: 'bobs' },
          ok: true,
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n',
    );
    appendDecision(deps.decisionLog, {
      ts: '2026-10-06T09:00:00Z',
      sandbox: sb('ag-1', 's-old'),
      chunkId: 'c-old',
      decision: 'rejected',
      reason: 'too broad',
      ok: true,
      actor: 'openshell-setup-ui',
    });

    // 1 · Providers
    expect(
      (
        await call('POST', '/api/groups/providers', {
          group: 'ag-1',
          name: 'gh-alice',
          type: 'github',
          credentials: [{ key: 'GITHUB_TOKEN', value: SECRET }],
        })
      ).status,
    ).toBe(200);
    expect((await call('GET', '/api/groups/providers?group=ag-1')).json.providers).toHaveLength(1);
    // 2 · Network paths
    expect(
      (
        await call('POST', '/api/groups/network', {
          group: 'ag-1',
          name: 'crm',
          host: 'api.hubapi.com',
          ports: '443',
          binaries: ['/usr/local/bin/node'],
        })
      ).status,
    ).toBe(200);
    expect((await call('GET', '/api/groups/network?group=ag-1')).json.rules).toHaveLength(1);
    // 3 · Pending approvals
    const pending = await call('GET', '/api/groups/policy?group=ag-1');
    expect(pending.json.chunks).toHaveLength(1);
    expect(
      (await call('POST', '/api/policy/approve', { group: 'ag-1', sandbox: pending.json.sandbox, chunkId: 'c-pend' }))
        .json.ok,
    ).toBe(true);
    // 4 · Audit log
    const audit = await call('GET', '/api/groups/audit?group=ag-1');
    expect(audit.status).toBe(200);
    expect(audit.json.entries.map((e: { action: string; outcome: string }) => `${e.action}:${e.outcome}`)).toEqual([
      'approve:approved', // 12:00, this run's decision (group recorded)
      'apply-preset:failed', // 10:05, by sandbox
      'provider-attach:applied', // 10:00, by group
      'reject:rejected', // 09:00, decision on an older sandbox of the group
    ]);
    expect(audit.text).not.toContain('bobs');
    expect(audit.text).not.toContain(SECRET);
    expect(audit.json.logs).toEqual({ changes: deps.changeLog, decisions: deps.decisionLog });
    // OpenShell's own listing was consulted for the default sandbox.
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-list',
      args: { sandbox: sb('ag-1', 's-new'), status: 'approved' },
    });
  });
});
