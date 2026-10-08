/**
 * The setup console's API, end to end over real HTTP: group changes land in
 * the policy file and are applied live to the group's running sandboxes
 * through a recording fake `openshell`; blocked requests and the activity log
 * come back as the page reads them.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readPolicyFile } from '../../../../../src/drivers/openshell/policy-file.js';
import { STATIC_DIR } from './exec.js';
import type { ExecResult } from './openshell-ops.js';
import { createHandler, type UiDeps } from './routes.js';

const SECRET = 'granola-secret-value-123';
const ALICE = { id: 'ag-1', name: 'Alice', folder: 'alice' };
const BOB = { id: 'ag-2', name: 'Bob', folder: 'bob' };
const sb = (session: string) => `ncl-${session}`;

const exec = (stdout = '', code: number | null = 0, stderr = ''): ExecResult => ({ code, stdout, stderr });

let server: http.Server;
let base: string;
let dir: string;
let calls: { args: string[]; env: Record<string, string> }[];
let respond: (args: string[]) => ExecResult;
let sessions: Record<string, { id: string; status: string; container_status: string; created_at: string }[]>;
let deps: UiDeps & { restartGroup: ReturnType<typeof vi.fn>; runCredentialScript: ReturnType<typeof vi.fn> };

const PENDING = [
  'Network Rules:',
  '  Chunk: ck-1',
  '  Status: pending',
  '  Rule: allow_api_example_com_443',
  '  Binary: /usr/bin/curl',
  '  Rationale: Allow curl to connect to api.example.com:443 (HTTPS).',
  '  Endpoints: api.example.com:443 [L4]',
  '  Hits: 3 (first seen …)',
  '',
].join('\n');

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    // static asset
  }
  return { status: res.status, json, text, headers: res.headers };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-console-'));
  calls = [];
  respond = (args) => {
    if (args.join(' ') === 'provider list -o json')
      return exec(
        JSON.stringify({
          providers: [{ name: 'granola-alice', type: 'granola', credential_keys: ['GRANOLA_API_KEY'] }],
        }),
      );
    if (args[0] === 'rule' && args[1] === 'get') return exec(PENDING);
    return exec('ok');
  };
  sessions = {
    'ag-1': [
      { id: 's1', status: 'active', container_status: 'running', created_at: '2026-10-08T00:00:00Z' },
      { id: 's-old', status: 'closed', container_status: 'stopped', created_at: '2026-10-07T00:00:00Z' },
    ],
    'ag-2': [{ id: 's2', status: 'active', container_status: 'running', created_at: '2026-10-08T00:00:00Z' }],
  };
  deps = {
    runOpenShell: async (args, env) => {
      calls.push({ args, env });
      return respond(args);
    },
    runCredentialScript: vi.fn(async () => exec(`stored ${SECRET}`)),
    checkCredentials: () => ({ credentials: 'configured', credentialSource: 'openshell-provider:oauth' }),
    gatewayKind: () => 'openshell',
    listGroups: async () => [ALICE, BOB],
    groupSessions: async (id) => sessions[id] ?? [],
    sandboxName: (_g, s) => sb(s),
    restartGroup: vi.fn(async () => ({ ok: true, data: { restarted: 1 } })),
    policyFile: path.join(dir, 'policy.yaml'),
    activityLog: path.join(dir, 'activity.jsonl'),
    staticDir: STATIC_DIR,
    now: () => new Date('2026-10-08T12:00:00.000Z'),
  };
  server = http.createServer(createHandler(deps));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('page', () => {
  it('serves the page and script with a content security policy, and the script never writes HTML', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toMatch(/default-src 'self'/);
    for (const id of ['group-select', 'tab-providers', 'tab-network', 'tab-approvals', 'tab-audit', 'type-submit'])
      expect(page.text).toContain(`id="${id}"`);
    const js = await call('GET', '/app.js');
    expect(js.text).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });

  it('unknown paths are 404; a group is required and must exist', async () => {
    expect((await call('GET', '/etc/passwd')).status).toBe(404);
    expect((await call('GET', '/api/groups/network')).status).toBe(400);
    expect((await call('GET', '/api/groups/network?group=nope')).status).toBe(404);
  });

  it('POST bodies must be JSON', async () => {
    const res = await fetch(`${base}/api/groups/network`, { method: 'POST', body: 'group=ag-1' });
    expect(res.status).toBe(415);
  });
});

describe('network rules', () => {
  const RULE = { group: 'ag-1', name: 'crm', host: 'api.hubapi.com', ports: '443,8443', binaries: ['/usr/bin/curl'] };

  it('add: saved in the policy file, then one policy update per port on each running sandbox of the group only', async () => {
    const r = await call('POST', '/api/groups/network', RULE);
    expect(r.status).toBe(200);
    expect(readPolicyFile(deps.policyFile).groups?.alice?.egress).toEqual([
      { name: 'crm', host: 'api.hubapi.com', ports: [443, 8443], binaries: ['/usr/bin/curl'] },
    ]);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'policy update ncl-s1 --add-endpoint api.hubapi.com:443 --binary /usr/bin/curl --rule-name crm',
      'policy update ncl-s1 --add-endpoint api.hubapi.com:8443 --binary /usr/bin/curl --rule-name crm',
    ]);
    expect(r.json.live).toEqual([{ sandbox: 'ncl-s1', ok: true }]);
    expect((await call('GET', '/api/groups/network?group=ag-1')).json.rules).toHaveLength(1);
    expect((await call('GET', '/api/groups/network?group=ag-2')).json.rules).toEqual([]);
  });

  it('a sandbox that refuses the change is reported, and the saved rule stays', async () => {
    respond = () => exec('', 1, 'Error: sandbox not ready');
    const r = await call('POST', '/api/groups/network', { ...RULE, ports: '443' });
    expect(r.status).toBe(200);
    expect(r.json.live).toEqual([{ sandbox: 'ncl-s1', ok: false, error: 'Error: sandbox not ready' }]);
    expect(readPolicyFile(deps.policyFile).groups?.alice?.egress).toHaveLength(1);
  });

  it('remove: dropped from the file and from the running sandbox; bad input is a 400 that changes nothing', async () => {
    await call('POST', '/api/groups/network', RULE);
    calls = [];
    expect((await call('DELETE', '/api/groups/network?group=ag-1&name=crm')).status).toBe(200);
    expect(calls.map((c) => c.args.join(' '))).toEqual(['policy update ncl-s1 --remove-rule crm']);
    expect(readPolicyFile(deps.policyFile).groups?.alice?.egress).toEqual([]);
    for (const bad of [
      { ...RULE, name: '_provider_x' },
      { ...RULE, host: 'not a host' },
      { ...RULE, binaries: ['curl'] },
    ])
      expect((await call('POST', '/api/groups/network', bad)).status).toBe(400);
    expect((await call('DELETE', '/api/groups/network?group=ag-1&name=ghost')).status).toBe(400);
  });
});

describe('providers', () => {
  it('attach an existing provider: checked in OpenShell, saved, attached live; listed with its type', async () => {
    const r = await call('POST', '/api/groups/providers', { group: 'ag-1', name: 'granola-alice' });
    expect(r.status).toBe(200);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'provider get granola-alice',
      'sandbox provider attach ncl-s1 granola-alice --wait --timeout 25',
    ]);
    expect(readPolicyFile(deps.policyFile).groups?.alice?.providers).toEqual(['granola-alice']);
    expect((await call('GET', '/api/groups/providers?group=ag-1')).json.providers).toEqual([
      { name: 'granola-alice', type: 'granola', credentialKeys: ['GRANOLA_API_KEY'], missing: false },
    ]);
    expect(deps.restartGroup).not.toHaveBeenCalled();
  });

  it('create with a type: the value travels only in the child env and never comes back', async () => {
    respond = (args) => (args[1] === 'create' ? exec('', 1, `Error: bad ${SECRET}`) : exec('ok'));
    const r = await call('POST', '/api/groups/providers', {
      group: 'ag-1',
      name: 'granola-alice',
      type: 'granola',
      credentials: [{ key: 'GRANOLA_API_KEY', value: SECRET }],
    });
    expect(r.status).toBe(400);
    expect(calls[0].args).toEqual([
      'provider',
      'create',
      '--name',
      'granola-alice',
      '--type',
      'granola',
      '--credential',
      'GRANOLA_API_KEY',
    ]);
    expect(calls[0].env).toEqual({ GRANOLA_API_KEY: SECRET });
    expect(r.text).not.toContain(SECRET);
    expect(readPolicyFile(deps.policyFile).groups).toBeUndefined(); // nothing saved
  });

  it('restart only when asked and the attach reached a running sandbox', async () => {
    const r = await call('POST', '/api/groups/providers', { group: 'ag-1', name: 'granola-alice', restart: true });
    expect(deps.restartGroup).toHaveBeenCalledWith('ag-1');
    expect(r.json.restart).toEqual({ ok: true, restarted: 1 });
    sessions['ag-1'] = [];
    const quiet = await call('POST', '/api/groups/providers', { group: 'ag-1', name: 'other', restart: true });
    expect(quiet.json.restart).toBeUndefined();
  });

  it('detach: removed from the file and detached live; a provider OpenShell lacks is refused', async () => {
    await call('POST', '/api/groups/providers', { group: 'ag-1', name: 'granola-alice' });
    calls = [];
    expect((await call('DELETE', '/api/groups/providers?group=ag-1&name=granola-alice')).status).toBe(200);
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'sandbox provider detach ncl-s1 granola-alice --wait --timeout 25',
    ]);
    respond = () => exec('', 1, 'provider not found');
    expect((await call('POST', '/api/groups/providers', { group: 'ag-1', name: 'ghost' })).status).toBe(400);
  });
});

describe('blocked requests and activity', () => {
  it('lists the newest running sandbox’s proposals with their targets', async () => {
    const r = await call('GET', '/api/groups/policy?group=ag-1&status=pending');
    expect(calls.at(-1)!.args).toEqual(['rule', 'get', 'ncl-s1', '--status', 'pending']);
    expect(r.json.sandbox).toBe('ncl-s1');
    expect(r.json.chunks).toEqual([
      expect.objectContaining({
        chunkId: 'ck-1',
        binary: '/usr/bin/curl',
        targets: [{ host: 'api.example.com', port: 443 }],
      }),
    ]);
    sessions['ag-1'] = [];
    expect((await call('GET', '/api/groups/policy?group=ag-1')).json.sandbox).toBeNull();
  });

  it('approve / reject run OpenShell’s own commands on a sandbox of that group only, and are logged', async () => {
    await call('POST', '/api/policy/approve', { group: 'ag-1', sandbox: 'ncl-s1', chunkId: 'ck-1' });
    await call('POST', '/api/policy/reject', { group: 'ag-1', sandbox: 'ncl-s1', chunkId: 'ck-2', reason: 'no' });
    expect(calls.map((c) => c.args.join(' '))).toEqual([
      'rule approve ncl-s1 --chunk-id ck-1',
      'rule reject ncl-s1 --chunk-id ck-2 --reason no',
    ]);
    expect(
      (await call('POST', '/api/policy/approve', { group: 'ag-1', sandbox: 'ncl-s2', chunkId: 'ck-1' })).status,
    ).toBe(400);
    const audit = (await call('GET', '/api/groups/audit?group=ag-1')).json.entries;
    expect(audit.map((e: { action: string; outcome: string }) => `${e.action}:${e.outcome}`)).toEqual([
      'approve:approved',
      'reject:rejected',
    ]);
    expect((await call('GET', '/api/groups/audit?group=ag-2')).json.entries).toEqual([]);
  });
});

describe('Claude credential', () => {
  it('runs auth.ts with exactly the submitted variable, reports the kind read back, and never echoes the value', async () => {
    const token = 'sk-ant-oat01-FAKE-VALUE';
    const r = await call('POST', '/api/credential', { kind: 'oauth', value: token });
    expect(r.status).toBe(200);
    const env = deps.runCredentialScript.mock.calls[0][0] as NodeJS.ProcessEnv;
    expect(env.NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
    expect(env.NANOCLAW_ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.json.credential).toEqual({ credentials: 'configured', source: 'openshell-provider', kind: 'oauth' });
    expect((await call('POST', '/api/credential', { kind: 'oauth', value: 'sk-ant-api03-x' })).status).toBe(400);
  });
});
