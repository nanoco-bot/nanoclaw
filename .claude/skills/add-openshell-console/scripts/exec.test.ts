import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { credentialScriptEnv } from './openshell-ops.js';
import {
  PROJECT_ROOT,
  execCapture,
  openShellChildEnv,
  realDeps,
  tsxLoaderUrl,
  type ExecFileLike,
} from './exec.js';

type Call = { file: string; args: string[]; options: { env: NodeJS.ProcessEnv; cwd?: string; timeout?: number } };

function fakeExecFile(
  result: {
    error?: { code?: number | string; message?: string };
    stdout?: string;
    stderr?: string;
  } = {},
) {
  const calls: Call[] = [];
  const run = ((
    file: string,
    args: string[],
    options: Call['options'],
    cb: (e: unknown, out: string, err: string) => void,
  ) => {
    calls.push({ file, args, options });
    const error = result.error ? Object.assign(new Error(result.error.message ?? 'failed'), result.error) : null;
    setImmediate(() => cb(error, result.stdout ?? '', result.stderr ?? ''));
  }) as unknown as ExecFileLike;
  return { run, calls };
}

const tmp: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('execCapture', () => {
  it('returns exit code and BOTH streams; passes env, cwd and a timeout', async () => {
    const f = fakeExecFile({ stdout: 'out', stderr: 'warn' });
    expect(await execCapture(f.run, '/bin/openshell', ['provider', 'list'], { env: { A: '1' }, cwd: '/r' })).toEqual({
      code: 0,
      stdout: 'out',
      stderr: 'warn',
    });
    expect(f.calls[0]).toMatchObject({
      file: '/bin/openshell',
      args: ['provider', 'list'],
      options: { env: { A: '1' }, cwd: '/r' },
    });
    expect(f.calls[0].options.timeout).toBeGreaterThan(0);
  });

  it('a non-zero exit keeps the child’s own stderr; a spawn failure has code null and says why', async () => {
    expect(
      await execCapture(fakeExecFile({ error: { code: 2 }, stderr: 'error: bad flag\n' }).run, 'x', [], { env: {} }),
    ).toEqual({
      code: 2,
      stdout: '',
      stderr: 'error: bad flag\n',
    });
    const enoent = await execCapture(
      fakeExecFile({ error: { code: 'ENOENT', message: 'spawn /nope ENOENT' } }).run,
      '/nope',
      [],
      { env: {} },
    );
    expect(enoent.code).toBeNull();
    expect(enoent.stderr).toContain('ENOENT');
  });
});

describe('openshell child environment', () => {
  it('adds the configured gateway selection and the caller’s extras, and never colours output', () => {
    const env = openShellChildEnv(
      { PIP_INDEX_TOKEN: 't' },
      { PATH: '/bin', NO_COLOR: '0' },
      { OPENSHELL_GATEWAY: 'lab' },
    );
    expect(env).toEqual({
      PATH: '/bin',
      OPENSHELL_GATEWAY: 'lab',
      PIP_INDEX_TOKEN: 't',
      OPENSHELL_COLOR: 'never',
      NO_COLOR: '1',
    });
  });
});

describe('realDeps (execFile mocked)', () => {
  beforeEach(() => {
    vi.stubEnv('OPENSHELL_BIN', '/opt/openshell/bin/openshell');
    vi.stubEnv('OPENSHELL_GATEWAY', 'lab-gw');
  });

  it('runOpenShell runs the configured binary with the credential values in its environment only', async () => {
    const f = fakeExecFile({ stdout: 'Created' });
    const deps = realDeps(PROJECT_ROOT, f.run);
    expect(
      await deps.runOpenShell(['provider', 'create', '--name', 'p', '--type', 'pypi', '--credential', 'TOK'], {
        TOK: 'secret',
      }),
    ).toEqual({
      code: 0,
      stdout: 'Created',
      stderr: '',
    });
    const call = f.calls[0];
    expect(call.file).toBe('/opt/openshell/bin/openshell');
    expect(call.args).toEqual(['provider', 'create', '--name', 'p', '--type', 'pypi', '--credential', 'TOK']);
    expect(call.options.env).toMatchObject({
      TOK: 'secret',
      OPENSHELL_GATEWAY: 'lab-gw',
      OPENSHELL_COLOR: 'never',
      NO_COLOR: '1',
    });
    expect(call.options.cwd).toBe(PROJECT_ROOT);
  });

  it('runCredentialScript runs setup\'s gateway-auth step under this node with the tsx loader and the given env', async () => {
    const f = fakeExecFile({ stdout: 'stored' });
    const env = credentialScriptEnv({ kind: 'api-key', value: 'sk-ant-api03-FAKE' }, { PATH: '/bin' });
    await realDeps(PROJECT_ROOT, f.run).runCredentialScript(env);
    expect(f.calls[0].file).toBe(process.execPath);
    expect(f.calls[0].args).toEqual([
      '--import',
      tsxLoaderUrl(PROJECT_ROOT),
      path.join(PROJECT_ROOT, 'setup', 'index.ts'),
      '--step',
      'gateway-auth',
    ]);
    expect(f.calls[0].options.env).toBe(env);
    expect(fs.existsSync(new URL(tsxLoaderUrl(PROJECT_ROOT)))).toBe(true);
    expect(fs.existsSync(path.join(PROJECT_ROOT, 'setup', 'index.ts'))).toBe(true);
  });
});

describe('real wiring without OpenShell', () => {
  function stubOpenShell(script: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-stub-'));
    tmp.push(dir);
    const stub = path.join(dir, 'openshell');
    fs.writeFileSync(stub, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return stub;
  }

  it('runOpenShell reaches the configured binary with colour off (stub, not OpenShell)', async () => {
    vi.stubEnv(
      'OPENSHELL_BIN',
      stubOpenShell('echo "argv: $*"; echo "env: NO_COLOR=$NO_COLOR OPENSHELL_COLOR=$OPENSHELL_COLOR"'),
    );
    const r = await realDeps().runOpenShell(['rule', 'get', 'ncl-0123abcd', '--status', 'pending'], {});
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('argv: rule get ncl-0123abcd --status pending');
    expect(r.stdout).toContain('env: NO_COLOR=1 OPENSHELL_COLOR=never');
  });

  it('the credential script really runs (node + tsx + auth.ts) and fails loudly when OpenShell refuses, never echoing the key', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-home-'));
    tmp.push(home);
    const stub = stubOpenShell('echo "gateway unreachable" >&2; exit 1');
    const env = credentialScriptEnv(
      { kind: 'api-key', value: 'sk-ant-api03-FAKE-NOT-REAL' },
      { PATH: process.env.PATH, HOME: home, OPENSHELL_BIN: stub },
    );
    const r = await realDeps().runCredentialScript(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/gateway unreachable/);
    expect(r.stdout + r.stderr).not.toContain('sk-ant-api03-FAKE-NOT-REAL');
  }, 30_000);
});
