/**
 * Service types (OpenShell provider profiles) in the setup UI: the YAML the
 * simple form generates, the gateway listing parser, and the /api/types and
 * /api/gateway routes against a mocked `openshell`.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chunkEndpoints, parseRuleChunks } from './commands.js';
import { STATIC_DIR } from './exec.js';
import { buildProfileYaml, parseGatewayTypes, yamlProfileId } from './provider-types.js';
import { createHandler, type ExecResult, type UiDeps } from './routes.js';

const exec = (stdout = '', code: number | null = 0, stderr = ''): ExecResult => ({ code, stdout, stderr });

const GRANOLA = {
  id: 'granola',
  label: 'Granola',
  credentialKey: 'GRANOLA_API_KEY',
  endpoints: [{ host: 'public-api.granola.ai', port: 443, access: 'read-only' }],
  binaries: ['/usr/bin/curl', '/usr/local/bin/node'],
};

describe('buildProfileYaml', () => {
  it('renders a bearer profile OpenShell imports', () => {
    const { id, yaml } = buildProfileYaml(GRANOLA);
    expect(id).toBe('granola');
    expect(yaml).toBe(
      [
        'id: granola',
        'display_name: "Granola"',
        'description: "Granola API"',
        'category: other',
        'credentials:',
        '  - name: api_key',
        '    description: "Granola credential"',
        '    env_vars: [GRANOLA_API_KEY]',
        '    required: true',
        '    auth_style: bearer',
        '    header_name: authorization',
        'discovery:',
        '  credentials: [api_key]',
        'endpoints:',
        '  - host: public-api.granola.ai',
        '    port: 443',
        '    protocol: rest',
        '    access: read-only',
        '    enforcement: enforce',
        'binaries: [/usr/bin/curl, /usr/local/bin/node]',
        '',
      ].join('\n'),
    );
  });

  it('a custom header uses header_name; a pasted URL is reduced to its host', () => {
    const { yaml } = buildProfileYaml({
      ...GRANOLA,
      authStyle: 'header',
      authName: 'X-Api-Key',
      endpoints: [{ host: 'https://api.acme.io/v1/', port: 8443 }],
    });
    expect(yaml).toContain('auth_style: header\n    header_name: x-api-key\n');
    expect(yaml).toContain('  - host: api.acme.io\n    port: 8443\n');
  });

  it.each([
    [{ id: 'Bad Id' }, /type id/],
    [{ credentialKey: 'granola-key' }, /credential variable/],
    [{ authStyle: 'query' }, /bearer or header/],
    [{ authStyle: 'header' }, /header name/],
    [{ endpoints: [] }, /at least one host/],
    [{ endpoints: [{ host: 'not a host' }] }, /not a host name/],
    [{ endpoints: [{ host: 'a.io', port: 70000 }] }, /not a TCP port/],
    [{ binaries: [] }, /at least one program/],
    [{ binaries: ['curl'] }, /absolute program path/],
  ])('refuses %o', (patch, msg) => {
    expect(() => buildProfileYaml({ ...GRANOLA, ...patch })).toThrow(msg);
  });

  it('a label with quotes cannot break out of its YAML string', () => {
    const { yaml } = buildProfileYaml({ ...GRANOLA, label: 'Evil"\nid: other' });
    expect(yaml.match(/^id: /gm)).toHaveLength(1);
  });
});

describe('parseGatewayTypes / yamlProfileId / chunk endpoints', () => {
  it('reads `profile list -o json` (OpenShell v0.1.2 shape)', () => {
    const json = JSON.stringify([
      {
        id: 'httpbin-demo',
        display_name: 'httpbin demo',
        description: 'Demo',
        credentials: [{ name: 'api_token', env_vars: ['HTTPBIN_TOKEN'], auth_style: 'bearer' }],
        endpoints: [{ host: 'httpbin.org', port: 443, access: 'read-only' }],
        binaries: ['/usr/bin/curl'],
      },
    ]);
    expect(parseGatewayTypes(json)).toEqual([
      {
        id: 'httpbin-demo',
        label: 'httpbin demo',
        description: 'Demo',
        credentialKeys: ['HTTPBIN_TOKEN'],
        endpoints: [{ host: 'httpbin.org', port: 443, access: 'read-only' }],
        binaries: ['/usr/bin/curl'],
      },
    ]);
    expect(() => parseGatewayTypes('No profiles found.')).toThrow(/not JSON/);
  });

  it('yamlProfileId', () => {
    expect(yamlProfileId('display_name: X\nid: "acme"\n')).toBe('acme');
    expect(() => yamlProfileId('display_name: X')).toThrow(/id:/);
  });

  it('a proposal carries its endpoints and binaries', () => {
    const [c] = parseRuleChunks(
      '  Chunk: c1\n  Status: pending\n  Rule: allow_x\n  Binary: /usr/bin/curl\n' +
        '  Endpoints: public-api.granola.ai:443 [L4], b.io:8443\n  Binaries: /usr/bin/curl\n  Hits: 3 (first seen …)\n',
    );
    expect(c).toMatchObject({ binaries: '/usr/bin/curl', hits: '3 (first seen …)' });
    expect(chunkEndpoints(c)).toEqual([
      { host: 'public-api.granola.ai', port: 443 },
      { host: 'b.io', port: 8443 },
    ]);
  });
});

describe('/api/types and /api/gateway', () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  let runOpenShell: ReturnType<typeof vi.fn>;
  let imported: string | undefined;
  let listed: object[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-types-'));
    imported = undefined;
    listed = [];
    runOpenShell = vi.fn(async (args: string[]) => {
      if (args.join(' ') === 'provider profile list -o json') return exec(JSON.stringify(listed));
      if (args[2] === 'import') {
        imported = fs.readFileSync(args[4], 'utf8');
        listed.push({ id: yamlProfileId(imported), endpoints: [], binaries: [] });
        return exec('Imported 1 provider profile.');
      }
      if (args[2] === 'delete') return exec(`✓ Deleted provider profile ${args[3]}`);
      if (args[0] === 'status')
        return exec('\x1b[1mServer Status\x1b[0m\n  Server: https://127.0.0.1:17670\n  Status: Connected\n');
      if (args[0] === '--version') return exec('openshell 0.1.2\n');
      return exec('', 1, 'unexpected');
    });
    const deps: UiDeps = {
      runOpenShell: runOpenShell as unknown as UiDeps['runOpenShell'],
      dispatchPolicy: vi.fn(),
      dispatchNcl: vi.fn(async () => ({ ok: true, data: { profiles: [] } })),
      restartGroup: vi.fn(),
      runCredentialScript: vi.fn(),
      checkCredentials: () => ({ credentials: 'configured', credentialSource: 'running-service:oauth' }),
      gatewayKind: () => 'openshell',
      listGroups: async () => [],
      groupSessions: async () => [],
      sandboxName: (g, s) => `ncl-${g}-${s}`,
      changeLog: path.join(dir, 'changes.jsonl'),
      decisionLog: path.join(dir, 'decisions.jsonl'),
      staticDir: STATIC_DIR,
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

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  it('POST from the form imports the generated YAML from a temp file that is removed afterwards', async () => {
    const r = await call('POST', '/api/types', GRANOLA);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, id: 'granola' });
    expect(imported).toBe(buildProfileYaml(GRANOLA).yaml);
    const importCall = runOpenShell.mock.calls.find((c) => c[0][2] === 'import')!;
    expect(fs.existsSync(importCall[0][4])).toBe(false);
    expect(r.json.types.map((t: { id: string }) => t.id)).toEqual(['granola']);
  });

  it('POST with pasted YAML imports it as-is; an existing id is a 409; bad input is a 400 with no import', async () => {
    const yaml = 'id: acme\ndisplay_name: ACME\n';
    expect((await call('POST', '/api/types', { yaml })).status).toBe(200);
    expect(imported).toBe(yaml);
    expect((await call('POST', '/api/types', { yaml })).status).toBe(409);
    runOpenShell.mockClear();
    const bad = await call('POST', '/api/types', { ...GRANOLA, id: 'x', binaries: [] });
    expect(bad.status).toBe(400);
    expect(runOpenShell.mock.calls.some((c) => c[0][2] === 'import')).toBe(false);
  });

  it('an import OpenShell rejects is a 400 with its message', async () => {
    runOpenShell.mockImplementation(async (args: string[]) =>
      args[2] === 'import' ? exec('', 1, 'error: unknown field `bogus`') : exec('[]'),
    );
    const r = await call('POST', '/api/types', { yaml: 'id: acme\nbogus: 1\n' });
    expect(r).toMatchObject({ status: 400, json: { error: 'error: unknown field `bogus`' } });
  });

  it('DELETE runs `provider profile delete <id>`; a bad id is refused before running anything', async () => {
    expect((await call('DELETE', '/api/types?id=granola')).status).toBe(200);
    expect(runOpenShell).toHaveBeenCalledWith(['provider', 'profile', 'delete', 'granola'], {});
    runOpenShell.mockClear();
    expect((await call('DELETE', '/api/types?id=..%2Fx')).status).toBe(400);
    expect(runOpenShell).not.toHaveBeenCalled();
  });

  it('GET /api/gateway reports connection and version', async () => {
    expect((await call('GET', '/api/gateway')).json).toEqual({
      connected: true,
      version: '0.1.2',
      server: 'https://127.0.0.1:17670',
    });
  });
});
