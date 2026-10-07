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
  dispatchProvider: ReturnType<typeof vi.fn>;
  listGroups: ReturnType<typeof vi.fn>;
  groupSandboxNames: ReturnType<typeof vi.fn>;
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
    dispatchProvider: vi.fn(async (): Promise<DispatchResult> => ({ ok: true, data: { output: '' } })),
    listGroups: vi.fn(async () => [{ id: 'ag-1', name: 'Main', folder: 'main' }]),
    groupSandboxNames: vi.fn(async () => [] as string[]),
    listPresets: () => [{ name: 'github', version: 1, description: 'GitHub API + git over HTTPS' }],
    runCredentialScript: vi.fn(async () => exec('stored')),
    checkCredentials: vi.fn(() => ({ credentials: 'configured', credentialSource: 'running-service:api-key' })),
    gatewayKind: () => 'openshell',
    decisionLog: path.join(dir, 'data', 'openshell-setup-ui', 'decisions.jsonl'),
    policyChangeLog: path.join(dir, 'data', 'openshell-policy', 'changes.jsonl'),
    providerChangeLog: path.join(dir, 'data', 'openshell-provider', 'changes.jsonl'),
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
  it('serves the HTML and the script: Providers / Agent groups (4 sub-tabs) / Claude credential', async () => {
    const page = await call('GET', '/');
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/text\/html/);
    // Top-level tabs, each a panel reachable from its nav link.
    for (const tab of ['providers', 'group', 'credential']) {
      expect(page.text).toMatch(new RegExp(`<div id="tab-${tab}" class="tab"`));
      expect(page.text).toContain(`id="tab-link-${tab}"`);
    }
    // System-wide Providers tab: profiles + provider instances.
    for (const id of ['profiles', 'providers', 'credential'])
      expect(page.text).toMatch(new RegExp(`<section id="${id}"`));
    // Per-group sub-tabs.
    for (const sub of ['attach', 'network', 'pending', 'audit']) {
      expect(page.text).toContain(`<section id="${sub}" class="subtab"`);
      expect(page.text).toContain(`href="#group/${sub}" id="sub-link-${sub}"`);
    }
    expect(page.text).toContain('<select id="group">');
    const js = await call('GET', '/app.js');
    expect(js.type).toMatch(/javascript/);
    expect(js.text).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
  });

  it('every element the script looks up exists in the page (no dead control after the tabs move)', async () => {
    const page = (await call('GET', '/')).text;
    const js = (await call('GET', '/app.js')).text;
    const ids = new Set([...js.matchAll(/\$\('([A-Za-z0-9-]+)'\)/g)].map((m) => m[1]));
    expect(ids.size).toBeGreaterThan(40);
    for (const id of ids) expect(page, `#${id}`).toContain(`id="${id}"`);
    // The tab switcher builds these ids from its tab lists.
    for (const t of ['providers', 'group', 'credential']) expect(page).toContain(`id="tab-${t}"`);
    for (const t of ['attach', 'network', 'pending', 'audit']) expect(page).toContain(`id="sub-link-${t}"`);
    // Every pre-tabs control is still there.
    for (const id of ['cred-save', 'prov-create', 'prov-list', 'pol-list', 'pol-view', 'pol-sandbox', 'hist-load'])
      expect(page).toContain(`id="${id}"`);
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

describe('Providers tab · profiles (system-wide)', () => {
  it('list dispatches openshell-provider-profile-list', async () => {
    deps.dispatchProvider.mockResolvedValueOnce({ ok: true, data: { command: [], output: 'granola  Granola\n' } });
    const r = await call('GET', '/api/profiles');
    expect(deps.dispatchProvider).toHaveBeenCalledWith({
      command: 'openshell-provider-profile-list',
      args: { output: 'table' },
    });
    expect(r.json).toMatchObject({ ok: true, output: 'granola  Granola\n' });
  });

  it('import sends the pasted/uploaded YAML text to profile-import (no group); errors come back as 502', async () => {
    deps.dispatchProvider.mockResolvedValueOnce({ ok: true, data: { output: 'Imported granola' } });
    const ok = await call('POST', '/api/profiles', { yaml: 'id: granola\n', global: true });
    expect(ok.status).toBe(200);
    expect(deps.dispatchProvider).toHaveBeenLastCalledWith({
      command: 'openshell-provider-profile-import',
      args: { yaml: 'id: granola\n', global: true },
    });
    deps.dispatchProvider.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'lint failed' } });
    const bad = await call('POST', '/api/profiles', { yaml: 'nope' });
    expect(bad.status).toBe(502);
    expect(bad.json).toMatchObject({ ok: false, error: 'lint failed' });
  });

  it('import: empty YAML is a 400; a body over the profile cap is a 413', async () => {
    expect((await call('POST', '/api/profiles', { yaml: '  ' })).status).toBe(400);
    expect((await call('POST', '/api/profiles', { yaml: 'x'.repeat(1_100_000) })).status).toBe(413);
    expect(deps.dispatchProvider).not.toHaveBeenCalled();
  });
});

describe('Agent groups · selector + Attach / Detach', () => {
  it('lists agent groups', async () => {
    expect((await call('GET', '/api/groups')).json).toEqual({ groups: [{ id: 'ag-1', name: 'Main', folder: 'main' }] });
  });

  it("group providers: the resource's list (providers + live sandboxes)", async () => {
    deps.dispatchProvider.mockResolvedValueOnce({
      ok: true,
      data: { group: { id: 'ag-1' }, providers: ['granola'], sandboxes: [{ name: 'ncl-abc', phase: 'Ready' }] },
    });
    const r = await call('GET', '/api/group/providers?group=ag-1');
    expect(deps.dispatchProvider).toHaveBeenCalledWith({ command: 'openshell-provider-list', args: { group: 'ag-1' } });
    expect(r.json).toMatchObject({ ok: true, providers: ['granola'], sandboxes: [{ name: 'ncl-abc' }] });
    expect((await call('GET', '/api/group/providers')).status).toBe(400);
  });

  it('attach / detach dispatch the openshell-provider resource (which persists, applies live, and logs)', async () => {
    deps.dispatchProvider.mockResolvedValue({ ok: true, data: { providers: ['granola'], live: [] } });
    const a = await call('POST', '/api/group/providers/attach', { group: 'ag-1', provider: 'granola' });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ ok: true, result: { providers: ['granola'] } });
    await call('POST', '/api/group/providers/detach', { group: 'ag-1', provider: 'granola' });
    expect(deps.dispatchProvider.mock.calls.map((c) => c[0])).toEqual([
      { command: 'openshell-provider-attach', args: { group: 'ag-1', provider: 'granola' } },
      { command: 'openshell-provider-detach', args: { group: 'ag-1', provider: 'granola' } },
    ]);
  });

  it("attach: invalid input is a 400 before anything runs; the resource's refusal is a 502 with its text", async () => {
    expect((await call('POST', '/api/group/providers/attach', { group: 'ag-1', provider: '-x' })).status).toBe(400);
    expect((await call('POST', '/api/group/providers/attach', { provider: 'granola' })).status).toBe(400);
    expect(deps.dispatchProvider).not.toHaveBeenCalled();
    deps.dispatchProvider.mockResolvedValueOnce({
      ok: false,
      error: { code: 'handler-error', message: 'provider not found: granola' },
    });
    const r = await call('POST', '/api/group/providers/attach', { group: 'ag-1', provider: 'granola' });
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ ok: false, error: 'provider not found: granola' });
  });
});

describe('Agent groups · Network paths', () => {
  it('add-rule dispatches openshell-policy-add-rule with only the fields given', async () => {
    deps.dispatchPolicy.mockResolvedValueOnce(policyOk('merged policy preview'));
    const r = await call('POST', '/api/policy/add-rule', {
      sandbox: 'ncl-abc',
      addEndpoint: 'api.example.com:443',
      binary: '/usr/bin/curl',
      ruleName: '',
      dryRun: true,
    });
    expect(r.json).toMatchObject({ ok: true, output: 'merged policy preview' });
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-add-rule',
      args: { sandbox: 'ncl-abc', add_endpoint: 'api.example.com:443', binary: '/usr/bin/curl', dry_run: true },
    });
  });

  it('add-rule that changes nothing is a 400', async () => {
    expect((await call('POST', '/api/policy/add-rule', { sandbox: 'ncl-abc', binary: '/x' })).status).toBe(400);
    expect(deps.dispatchPolicy).not.toHaveBeenCalled();
  });

  it('presets are listed; apply-preset dispatches openshell-policy-apply-preset', async () => {
    expect((await call('GET', '/api/presets')).json?.presets[0]).toMatchObject({ name: 'github', version: 1 });
    deps.dispatchPolicy.mockResolvedValueOnce({ ok: true, data: { dryRun: true, applied: 0, commands: [['policy']] } });
    const r = await call('POST', '/api/policy/apply-preset', { sandbox: 'ncl-abc', preset: 'github', dryRun: true });
    expect(r.json).toMatchObject({ ok: true, result: { dryRun: true } });
    expect(deps.dispatchPolicy).toHaveBeenCalledWith({
      command: 'openshell-policy-apply-preset',
      args: { sandbox: 'ncl-abc', preset: 'github', dry_run: true },
    });
    expect((await call('POST', '/api/policy/apply-preset', { sandbox: 'ncl-abc', preset: '../x' })).status).toBe(400);
  });
});

describe('Agent groups · Audit log', () => {
  function writeLines(file: string, lines: unknown[]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it("combines this group's provider log, network decisions and policy changes on its sandboxes; newest first", async () => {
    deps.groupSandboxNames.mockResolvedValueOnce(['ncl-old']);
    deps.dispatchProvider.mockResolvedValueOnce({
      ok: true,
      data: { providers: [], sandboxes: [{ name: 'ncl-live', phase: 'Ready' }] },
    });
    // Remote: one approved decision on the live sandbox that no local log has.
    deps.dispatchPolicy.mockImplementation(async (frame: PolicyFrame) =>
      policyOk(frame.args.status === 'approved' ? '  Chunk: remote-1\n  Rule: r\n' : ''),
    );
    writeLines(deps.providerChangeLog, [
      {
        ts: '2026-10-01T00:00:00.000Z',
        verb: 'attach',
        caller: 'host',
        group: 'ag-1',
        provider: 'granola',
        ok: true,
        live: [],
      },
      {
        ts: '2026-10-04T00:00:00.000Z',
        verb: 'detach',
        caller: 'host',
        group: 'ag-1',
        provider: 'granola',
        ok: false,
        error: 'boom',
        persisted: true,
      },
      { ts: '2026-10-05T00:00:00.000Z', verb: 'attach', caller: 'host', group: 'ag-2', provider: 'other', ok: true },
      { ts: '2026-10-05T00:00:00.000Z', verb: 'profile-import', caller: 'host', ok: true },
    ]);
    writeLines(deps.policyChangeLog, [
      {
        ts: '2026-10-02T00:00:00.000Z',
        verb: 'add-rule',
        caller: 'host',
        sandbox: 'ncl-old',
        command: ['policy', 'update', 'ncl-old', '--add-endpoint', 'a:443'],
        ok: true,
      },
      { ts: '2026-10-02T00:00:00.000Z', verb: 'add-rule', caller: 'host', sandbox: 'ncl-someone-else', ok: true },
    ]);
    writeLines(deps.decisionLog, [
      {
        ts: '2026-10-03T00:00:00.000Z',
        sandbox: 'ncl-live',
        chunkId: 'c1',
        decision: 'rejected',
        reason: 'no',
        ok: true,
        actor: 'openshell-setup-ui',
      },
    ]);

    const r = await call('GET', '/api/audit?group=ag-1');
    expect(r.status).toBe(200);
    expect(deps.groupSandboxNames).toHaveBeenCalledWith('ag-1');
    expect(r.json?.sandboxes.sort()).toEqual(['ncl-live', 'ncl-old']);
    expect(r.json?.entries.map((e: Record<string, unknown>) => [e.ts ?? null, e.kind, e.action, e.subject])).toEqual([
      ['2026-10-04T00:00:00.000Z', 'provider', 'detach', 'granola'],
      ['2026-10-03T00:00:00.000Z', 'network-decision', 'rejected', 'c1'],
      ['2026-10-02T00:00:00.000Z', 'network-change', 'add-rule', '--add-endpoint a:443'],
      ['2026-10-01T00:00:00.000Z', 'provider', 'attach', 'granola'],
      [null, 'network-decision', 'approved', 'remote-1 · r'],
    ]);
    expect(r.json?.entries[0]).toMatchObject({ ok: false, detail: 'boom (group config was saved)' });
  });

  it('needs a group; a gateway that cannot list sandboxes still returns the local logs', async () => {
    expect((await call('GET', '/api/audit')).status).toBe(400);
    deps.dispatchProvider.mockResolvedValueOnce({ ok: false, error: { code: 'x', message: 'db missing' } });
    const r = await call('GET', '/api/audit?group=ag-1');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ entries: [], liveError: 'db missing' });
  });
});
