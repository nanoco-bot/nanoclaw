import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { checkCredentials } from './verify.js';

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
  it('a gateway name in .env is NOT a credential: missing when the service environment has none', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    expect(checkCredentials(root, () => ({ kind: 'none', source: 'running-service' }))).toEqual({
      credentials: 'missing',
      credentialSource: 'running-service:none',
    });
  });

  it('configured only when the place the relay reads has one', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    expect(checkCredentials(root, () => ({ kind: 'oauth', source: 'unit-environment' }))).toEqual({
      credentials: 'configured',
      credentialSource: 'unit-environment:oauth',
    });
  });

  it('a key left in .env does not count for OpenShell (the relay never reads .env)', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=openshell\nANTHROPIC_API_KEY=sk-ant-api03-x\n');
    expect(checkCredentials(root, () => ({ kind: 'none', source: 'drop-in-file' })).credentials).toBe('missing');
  });

  it('other gateways keep the existing .env check', () => {
    const root = install('NANOCLAW_GATEWAY_PROVIDER=onecli\n');
    const inspect = vi.fn();
    expect(checkCredentials(root, inspect)).toEqual({ credentials: 'configured', credentialSource: '' });
    expect(inspect).not.toHaveBeenCalled();
  });
});
