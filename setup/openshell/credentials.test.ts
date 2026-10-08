import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openShellCredentials } from './verify.js';

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function install(env: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cred-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, '.env'), env);
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
  return dir;
}

describe('verify: credentials for the OpenShell gateway', () => {
  it('a gateway name in .env is NOT a credential: missing until OpenShell holds the provider', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    expect(openShellCredentials(root, () => null)).toEqual({
      credentials: 'missing',
      credentialSource: 'openshell-provider:none',
    });
  });

  it('configured when OpenShell holds the provider', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    expect(openShellCredentials(root, () => 'oauth')).toEqual({
      credentials: 'configured',
      credentialSource: 'openshell-provider:oauth',
    });
  });

  it('a key left in .env does not count for OpenShell', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\nANTHROPIC_API_KEY=sk-ant-api03-x\n');
    expect(openShellCredentials(root, () => null)?.credentials).toBe('missing');
  });

  it('is null on another gateway, without asking OpenShell', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=onecli\n');
    const inspect = vi.fn(() => null);
    expect(openShellCredentials(root, inspect)).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
  });
});
