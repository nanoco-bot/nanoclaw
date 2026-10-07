import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PolicyFrame } from './commands.js';
import { readDecisions } from './history.js';
import { createHandler, type DispatchResult, type ExecResult, type UiDeps } from './routes.js';
import { STATIC_DIR } from './exec.js';

let server: http.Server;
let base: string;
let dir: string;
let deps: UiDeps & {
  runOpenShell: ReturnType<typeof vi.fn>;
  dispatchPolicy: ReturnType<typeof vi.fn>;
  dispatchNcl: ReturnType<typeof vi.fn>;
  runCredentialScript: ReturnType<typeof vi.fn>;
  checkCredentials: ReturnType<typeof vi.fn>;
};

const exec = (stdout = '', code: number | null = 0, stderr = ''): ExecResult => ({ code, stdout, stderr });
const policyOk = (output: string, extra: Record<string, unknown> = {}): DispatchResult => ({
  ok: true,
  data: { sandbox: 'ncl-abc', command: [], output, ...extra },
});

async function call(method: string, url: string, body?: unknown, contentType = 'application/json') {
  const res = await fetch(base + url, {
    method,
    headers: body !== undefined ? { 'content-type': contentType } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, any> | undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text, type: res.headers.get('content-type') ?? '' };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-'));
  deps = {
    runOpenShell: vi.fn(async () => exec()),
    dispatchPolicy: vi.fn(async () => policyOk('')),
    dispatchNcl: vi.fn(async () => ({ ok: true, data: { profiles: [] } })),
    runCredentialScript: vi.fn(async () => exec('stored')),
    checkCredentials: vi.fn(() => ({ credentials: 'configured', credentialSource: 'running-service:api-key' })),
    gatewayKind: () => 'openshell',
    listGroups: async () => [],
    groupSessions: async () => [],
    sandboxName: (g: string, s: string) => `ncl-${g}-${s}`,
    changeLog: path.join(dir, 'data', 'openshell-policy', 'changes.jsonl'),
    decisionLog: path.join(dir, 'data', 'openshell-setup-ui', 'decisions.jsonl'),
    staticDir: STATIC_DIR,
    now: () => new Date('2026-10-05T12:00:00.000Z'),
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

describe('static page', () => {
  it('serves the HTML and the script: install-wide credential, group selector, four group tabs', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/text\/html/);
    for (const id of ['credential', 'group']) expect(page.text).toContain(`<section id="${id}">`);
    for (const tab of ['providers', 'network', 'approvals', 'audit']) {
      expect(page.text).toContain(`id="tab-${tab}"`);
      expect(page.text).toContain(`data-tab="${tab}"`);
    }
    expect(page.text).toContain('id="group-select"');
    const js = await call('GET', '/app.js');
    expect(js.type).toMatch(/javascript/);
    expect(js.text).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });

  it('unknown paths are 404 JSON', async () => {
    expect((await call('GET', '/etc/passwd')).status).toBe(404);
    expect((await call('GET', '/../package.json')).status).toBe(404);
  });
});

describe('1 · credential', () => {
  it('runs auth.ts with exactly the submitted variable set, then reports the kind read back by checkCredentials()', async () => {
    deps.checkCredentials.mockReturnValueOnce({ credentials: 'configured', credentialSource: 'running-service:oauth' });
    const r = await call('POST', '/api/credential', { kind: 'oauth', value: 'sk-ant-oat01-FAKE-VALUE' });
    expect(r.status).toBe(200);
    expect(deps.runCredentialScript).toHaveBeenCalledTimes(1);
    const env = deps.runCredentialScript.mock.calls[0][0] as NodeJS.ProcessEnv;
    expect(env.NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-FAKE-VALUE');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(r.json).toMatchObject({
      ok: true,
      credential: { credentials: 'configured', source: 'running-service', kind: 'oauth' },
      gateway: 'openshell',
    });
    expect(r.text).not.toContain('sk-ant-oat01-FAKE-VALUE');
  });

  it('a script that exits 0 is NOT success unless the credential is actually where the relay reads it', async () => {
    deps.checkCredentials.mockReturnValueOnce({ credentials: 'missing', credentialSource: 'unit-environment:none' });
    const r = await call('POST', '/api/credential', { kind: 'api-key', value: 'sk-ant-api03-FAKE' });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ ok: false, credential: { credentials: 'missing', kind: 'none' } });
  });

  it('shows the script’s own failure text, scrubbed of the submitted secret', async () => {
    deps.runCredentialScript.mockResolvedValueOnce(exec('', 1, 'bad token sk-ant-api03-SECRETVALUE rejected'));
    deps.checkCredentials.mockReturnValueOnce({ credentials: 'missing', credentialSource: 'drop-in-file:none' });
    const r = await call('POST', '/api/credential', { kind: 'api-key', value: 'sk-ant-api03-SECRETVALUE' });
    expect(r.json?.script).toEqual({ code: 1, stdout: '', stderr: 'bad token [redacted] rejected' });
  });

  it('validates before running anything; non-JSON POSTs are refused (CSRF backstop)', async () => {
    expect((await call('POST', '/api/credential', { kind: 'oauth', value: 'sk-ant-api03-x' })).status).toBe(400);
    expect(
      (await call('POST', '/api/credential', 'kind=oauth&value=x', 'application/x-www-form-urlencoded')).status,
    ).toBe(415);
    expect((await call('POST', '/api/credential', '{not json')).status).toBe(400);
    expect(deps.runCredentialScript).not.toHaveBeenCalled();
  });

  it('status reports the current credential and the provider type list', async () => {
    const r = await call('GET', '/api/status');
    expect(r.json?.credential).toEqual({ credentials: 'configured', source: 'running-service', kind: 'api-key' });
    expect(r.json?.providerTypes.find((t: { id: string }) => t.id === 'pypi')).toMatchObject({ generic: true });
  });
});

describe('2 · providers', () => {
  it('builtin type: create argv with --credential KEY (value in env), then a provider get read-back', async () => {
    deps.runOpenShell
      .mockResolvedValueOnce(exec("Created provider 'anthropic-main'\n"))
      .mockResolvedValueOnce(exec('Name: anthropic-main\nType: anthropic\n'));
    const r = await call('POST', '/api/providers', {
      name: 'anthropic-main',
      type: 'anthropic',
      credentials: [{ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-api03-FAKE' }],
    });
    expect(r.status).toBe(200);
    expect(deps.runOpenShell.mock.calls).toEqual([
      [
        ['provider', 'create', '--name', 'anthropic-main', '--type', 'anthropic', '--credential', 'ANTHROPIC_API_KEY'],
        { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' },
      ],
      [['provider', 'get', 'anthropic-main'], {}],
    ]);
    expect(r.json).toMatchObject({
      ok: true,
      generic: false,
      argv: [
        'openshell',
        'provider',
        'create',
        '--name',
        'anthropic-main',
        '--type',
        'anthropic',
        '--credential',
        'ANTHROPIC_API_KEY',
      ],
      create: { code: 0, stdout: "Created provider 'anthropic-main'\n" },
      readBack: { code: 0, stdout: 'Name: anthropic-main\nType: anthropic\n' },
    });
    expect(r.text).not.toContain('sk-ant-api03-FAKE');
  });

  it('generic type: free-form env name + value, repeated config rows; empty rows ignored', async () => {
    deps.runOpenShell.mockResolvedValueOnce(exec('ok')).mockResolvedValueOnce(exec('Name: pkgs'));
    const r = await call('POST', '/api/providers', {
      name: 'pkgs',
      type: 'pypi',
      credentials: [
        { key: 'PIP_INDEX_TOKEN', value: 'tok-1' },
        { key: '', value: '' },
      ],
      config: [
        { key: 'index_url', value: 'https://x.invalid/simple' },
        { key: 'region', value: 'eu' },
      ],
      globalProfile: true,
    });
    expect(deps.runOpenShell.mock.calls[0]).toEqual([
      [
        'provider',
        'create',
        '--name',
        'pkgs',
        '--type',
        'pypi',
        '--credential',
        'PIP_INDEX_TOKEN',
        '--config',
        'index_url=https://x.invalid/simple',
        '--config',
        'region=eu',
        '--global-profile',
      ],
      { PIP_INDEX_TOKEN: 'tok-1' },
    ]);
    expect(r.json).toMatchObject({ ok: true, generic: true, missingDeclaredCredentials: [] });
  });

  it('OpenShell’s own error text comes back verbatim; no read-back after a failed create', async () => {
    deps.runOpenShell.mockResolvedValueOnce(exec('', 1, "error: provider 'dup' already exists\n"));
    const r = await call('POST', '/api/providers', {
      name: 'dup',
      type: 'openai',
      credentials: [{ key: 'OPENAI_API_KEY', value: 'k' }],
    });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ ok: false, create: { code: 1, stderr: "error: provider 'dup' already exists\n" } });
    expect(r.json).not.toHaveProperty('readBack');
    expect(deps.runOpenShell).toHaveBeenCalledTimes(1);
  });

  it('invalid input is a 400 before anything runs; list runs `provider list`', async () => {
    expect((await call('POST', '/api/providers', { name: '--x', type: 'openai' })).status).toBe(400);
    expect((await call('POST', '/api/providers', { name: 'a', type: 'openai', credentials: 'nope' })).status).toBe(400);
    expect(deps.runOpenShell).not.toHaveBeenCalled();
    deps.runOpenShell.mockResolvedValueOnce(exec('NAME  TYPE\nanthropic-main  anthropic\n'));
    const r = await call('GET', '/api/providers');
    expect(deps.runOpenShell).toHaveBeenCalledWith(['provider', 'list'], {});
    expect(r.json?.list.stdout).toContain('anthropic-main');
  });
});

describe('3 · policy proposals', () => {
  const listing =
    '  Chunk: ck-1\n  Status: pending\n  Rule: allow_pypi\n  Binary: /usr/bin/python3\n  Rationale: pip\n';

  it('lists via openshell-policy-list, parses chunks, and passes the proposals-disabled note through', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce(
      policyOk("No network rules for sandbox 'ncl-abc'\n", {
        proposals: 'unset',
        note: 'agent_policy_proposals_enabled is not set (default: off)…',
      }),
    );
    const empty = await call('GET', '/api/policy?sandbox=ncl-abc');
    expect(deps.dispatchPolicy).toHaveBeenLastCalledWith({
      command: 'openshell-policy-list',
      args: { sandbox: 'ncl-abc', status: 'pending' },
    });
    expect(empty.json).toMatchObject({
      ok: true,
      chunks: [],
      proposals: 'unset',
      note: expect.stringMatching(/not set/),
    });

    deps.dispatchPolicy.mockResolvedValueOnce(policyOk(listing, { proposals: 'enabled' }));
    const one = await call('GET', '/api/policy?sandbox=ncl-abc&status=pending');
    expect(one.json?.chunks).toEqual([
      { chunkId: 'ck-1', status: 'pending', rule: 'allow_pypi', binary: '/usr/bin/python3', rationale: 'pip' },
    ]);
    expect(one.json).not.toHaveProperty('note');
  });

  it('surfaces the resource’s error (e.g. missing CLI) as a 502 with its message', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce({
      ok: false,
      error: { code: 'handler-error', message: "openshell CLI not found at '/opt/openshell'" },
    });
    const r = await call('GET', '/api/policy?sandbox=ncl-abc');
    expect(r.status).toBe(502);
    expect(r.json?.error).toMatch(/CLI not found/);
    expect((await call('GET', '/api/policy')).status).toBe(400); // no sandbox → refused before dispatch
    expect((await call('GET', '/api/policy?sandbox=s&status=all')).status).toBe(400);
  });

  it('approve / reject dispatch the existing commands and append to the decision log (failures too)', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce(policyOk('Approved ck-1'));
    const a = await call('POST', '/api/policy/approve', { sandbox: 'ncl-abc', chunkId: 'ck-1' });
    expect(a.json).toMatchObject({ ok: true, decision: 'approved', output: 'Approved ck-1' });
    expect(deps.dispatchPolicy).toHaveBeenLastCalledWith({
      command: 'openshell-policy-approve',
      args: { sandbox: 'ncl-abc', chunk_id: 'ck-1' },
    });

    deps.dispatchPolicy.mockResolvedValueOnce({
      ok: false,
      error: { code: 'handler-error', message: 'chunk not found' },
    });
    const rj = await call('POST', '/api/policy/reject', { sandbox: 'ncl-abc', chunkId: 'ck-9', reason: 'too broad' });
    expect(rj.status).toBe(502);
    expect(deps.dispatchPolicy).toHaveBeenLastCalledWith({
      command: 'openshell-policy-reject',
      args: { sandbox: 'ncl-abc', chunk_id: 'ck-9', reason: 'too broad' },
    });

    expect(readDecisions(deps.decisionLog)).toEqual([
      {
        ts: '2026-10-05T12:00:00.000Z',
        sandbox: 'ncl-abc',
        chunkId: 'ck-1',
        decision: 'approved',
        ok: true,
        actor: 'openshell-setup-ui',
      },
      {
        ts: '2026-10-05T12:00:00.000Z',
        sandbox: 'ncl-abc',
        chunkId: 'ck-9',
        decision: 'rejected',
        reason: 'too broad',
        ok: false,
        error: 'chunk not found',
        actor: 'openshell-setup-ui',
      },
    ]);
    expect(fs.statSync(deps.decisionLog).mode & 0o777).toBe(0o600);
  });

  it('reject without a reason is refused and not logged', async () => {
    expect((await call('POST', '/api/policy/reject', { sandbox: 'ncl-abc', chunkId: 'ck-1' })).status).toBe(400);
    expect(deps.dispatchPolicy).not.toHaveBeenCalled();
    expect(readDecisions(deps.decisionLog)).toEqual([]);
  });

  it('view returns the policy as parsed JSON when the output is JSON', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce(policyOk('{"network_policies":{"a":{}}}'));
    const r = await call('GET', '/api/policy/view?sandbox=ncl-abc');
    expect(deps.dispatchPolicy).toHaveBeenLastCalledWith({
      command: 'openshell-policy-view',
      args: { sandbox: 'ncl-abc', output: 'json' },
    });
    expect(r.json).toMatchObject({ ok: true, policy: { network_policies: { a: {} } } });
  });
});

describe('4 · history', () => {
  it('UI log first (newest first), then decisions only OpenShell knows about', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce(policyOk('Approved'));
    await call('POST', '/api/policy/approve', { sandbox: 'ncl-abc', chunkId: 'ck-1' });
    deps.dispatchPolicy.mockImplementation(async (frame: PolicyFrame) =>
      frame.args.status === 'approved'
        ? policyOk('  Chunk: ck-1\n  Status: approved\n\n  Chunk: ck-7\n  Status: approved\n  Rule: via_cli\n')
        : policyOk('  Chunk: ck-8\n  Status: rejected\n'),
    );
    const r = await call('GET', '/api/history?sandbox=ncl-abc');
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-list',
      args: { sandbox: 'ncl-abc', status: 'approved' },
    });
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-list',
      args: { sandbox: 'ncl-abc', status: 'rejected' },
    });
    expect(r.json?.entries).toEqual([
      {
        ts: '2026-10-05T12:00:00.000Z',
        sandbox: 'ncl-abc',
        chunkId: 'ck-1',
        decision: 'approved',
        ok: true,
        actor: 'openshell-setup-ui',
        source: 'ui-log',
      },
      { sandbox: 'ncl-abc', chunkId: 'ck-7', decision: 'approved', rule: 'via_cli', source: 'openshell' },
      { sandbox: 'ncl-abc', chunkId: 'ck-8', decision: 'rejected', source: 'openshell' },
    ]);
    expect(r.json?.logFile).toBe(deps.decisionLog);
  });

  it('without a sandbox: just the local log; an OpenShell failure is reported, not fatal', async () => {
    expect((await call('GET', '/api/history')).json).toMatchObject({ entries: [] });
    deps.dispatchPolicy.mockResolvedValue({ ok: false, error: { code: 'handler-error', message: 'gateway down' } });
    const r = await call('GET', '/api/history?sandbox=ncl-abc');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ entries: [], remoteError: 'gateway down' });
  });
});

describe('custom provider profiles (templates)', () => {
  const acme = {
    id: 'acme-crm',
    label: 'ACME CRM',
    type: 'acme',
    credentialKeys: ['ACME_API_KEY'],
    configKeys: ['region'],
  };

  it('status and /api/profiles list shipped + custom templates; custom ones come from ncl in-process', async () => {
    deps.dispatchNcl.mockResolvedValue({ ok: true, data: { profiles: [acme] } });
    const status = await call('GET', '/api/status');
    const t = status.json?.providerTypes.find((p: { id: string }) => p.id === 'acme-crm');
    expect(t).toMatchObject({
      source: 'custom',
      type: 'acme',
      credentialKeys: ['ACME_API_KEY'],
      configKeys: ['region'],
    });
    expect(status.json?.providerTypes.find((p: { id: string }) => p.id === 'anthropic')).toMatchObject({
      source: 'builtin',
    });
    expect(deps.dispatchNcl).toHaveBeenCalledWith({ command: 'openshell-provider-profile-list', args: {} });
    const profiles = await call('GET', '/api/profiles');
    expect(profiles.json?.templates.map((p: { id: string }) => p.id)).toContain('acme-crm');
  });

  it('custom profiles unavailable (e.g. host has not migrated yet): shipped list still served, with the reason', async () => {
    deps.dispatchNcl.mockResolvedValue({ ok: false, error: { code: 'unavailable', message: 'no such table' } });
    const r = await call('GET', '/api/status');
    expect(r.status).toBe(200);
    expect(r.json?.customProfilesError).toBe('no such table');
    expect(r.json?.providerTypes.length).toBeGreaterThan(10);
  });

  it('POST /api/profiles creates through ncl (names only) and returns the refreshed list', async () => {
    deps.dispatchNcl.mockImplementation(async (frame: PolicyFrame) =>
      frame.command === 'openshell-provider-profile-create'
        ? { ok: true, data: { profile: { ...acme } } }
        : { ok: true, data: { profiles: [acme] } },
    );
    const r = await call('POST', '/api/profiles', {
      id: 'acme-crm',
      label: 'ACME CRM',
      type: 'acme',
      credentialKeys: ['ACME_API_KEY'],
      configKeys: ['region'],
    });
    expect(r.status).toBe(200);
    expect(deps.dispatchNcl.mock.calls[0][0]).toEqual({
      command: 'openshell-provider-profile-create',
      args: { id: 'acme-crm', label: 'ACME CRM', type: 'acme', credential_keys: 'ACME_API_KEY', config_keys: 'region' },
    });
    expect(r.json?.profile.id).toBe('acme-crm');
    expect(r.json?.templates.some((p: { id: string }) => p.id === 'acme-crm')).toBe(true);
  });

  it('a refused profile is a 400 with ncl’s reason; delete goes through ncl too', async () => {
    deps.dispatchNcl.mockResolvedValueOnce({
      ok: false,
      error: { code: 'handler-error', message: "profile id 'Bad' must be lowercase" },
    });
    const bad = await call('POST', '/api/profiles', { id: 'Bad' });
    expect(bad.status).toBe(400);
    expect(bad.json?.error).toMatch(/must be lowercase/);
    deps.dispatchNcl.mockResolvedValue({ ok: true, data: { profiles: [] } });
    const del = await call('DELETE', '/api/profiles?id=acme-crm');
    expect(del.status).toBe(200);
    expect(deps.dispatchNcl).toHaveBeenCalledWith({
      command: 'openshell-provider-profile-delete',
      args: { id: 'acme-crm' },
    });
  });

  it('selecting a custom template: create uses its --type, and the missing-credential hint uses its keys', async () => {
    deps.dispatchNcl.mockResolvedValue({ ok: true, data: { profiles: [acme] } });
    deps.runOpenShell.mockResolvedValueOnce(exec('ok')).mockResolvedValueOnce(exec('Name: acme-1'));
    const r = await call('POST', '/api/providers', { name: 'acme-1', type: 'acme', credentials: [] });
    expect(deps.runOpenShell.mock.calls[0][0]).toEqual(['provider', 'create', '--name', 'acme-1', '--type', 'acme']);
    expect(r.json).toMatchObject({ ok: true, generic: false, missingDeclaredCredentials: ['ACME_API_KEY'] });
  });

  it('the page has the template select and the save-profile form', async () => {
    const page = await call('GET', '/');
    for (const id of ['prov-type', 'profile-save', 'profile-id', 'profile-creds', 'profile-delete'])
      expect(page.text).toContain(`id="${id}"`);
  });
});
