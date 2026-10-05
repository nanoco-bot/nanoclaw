import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const systemctl = vi.hoisted(() => ({ calls: [] as string[][] }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: (cmd: string, args: string[]) => {
    systemctl.calls.push([cmd, ...args]);
    throw new Error('no systemd manager in this test');
  },
}));
const manager = vi.hoisted(() => ({ value: 'systemd' as 'systemd' | 'launchd' | 'none' }));
vi.mock('../../../../setup/platform.js', async (original) => ({
  ...(await original<typeof import('../../../../setup/platform.js')>()),
  getServiceManager: () => manager.value,
}));
vi.mock('@clack/prompts', () => ({ log: { success: vi.fn(), warn: vi.fn() }, isCancel: () => false }));

import { unitLocation } from '../../../../setup/lib/openshell-credential.js';
import { run, takeLegacyEnvCredential } from './auth.js';

let home: string;
let root: string;
const dropIn = () => unitLocation(root, { root: false, home }).dropInPath;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-auth-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-auth-root-'));
  vi.stubEnv('HOME', home);
  for (const k of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'NANOCLAW_ANTHROPIC_API_KEY',
    'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    vi.stubEnv(k, '');
  }
  vi.spyOn(process, 'getuid').mockReturnValue(1000); // user unit, never /etc/systemd
  systemctl.calls = [];
  manager.value = 'systemd';
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenShell gateway auth step', () => {
  it('writes a supplied key to the unit’s 0600 drop-in, never to .env', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE');
    await run('claude', root);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain('Environment=ANTHROPIC_API_KEY=sk-ant-api03-FAKE');
    expect(fs.statSync(dropIn()).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('NANOCLAW_GATEWAY_PROVIDER=openshell\n');
    // Tells systemd about it (here: no manager reachable, so only the attempt).
    expect(systemctl.calls[0]).toEqual(['systemctl', '--user', 'daemon-reload']);
  });

  it('moves a credential an older setup left in .env into the drop-in and out of .env', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'TZ=UTC\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE\n');
    await run('claude', root);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain('Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE');
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('TZ=UTC\n');
  });

  it('non-interactive with nothing supplied fails loudly instead of leaving the relay without a key', async () => {
    await expect(run('claude', root)).rejects.toThrow(/No Claude credential for the OpenShell gateway/);
    expect(fs.existsSync(dropIn())).toBe(false);
  });

  it('keeps an existing drop-in credential when nothing new is supplied', async () => {
    fs.mkdirSync(path.dirname(dropIn()), { recursive: true });
    fs.writeFileSync(dropIn(), '[Service]\nEnvironment=ANTHROPIC_API_KEY=sk-ant-api03-OLD\n', { mode: 0o600 });
    await run('claude', root);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain('sk-ant-api03-OLD');
  });

  it('refuses other providers and hosts without systemd', async () => {
    await expect(run('codex', root)).rejects.toThrow(/Anthropic model credentials only/);
    manager.value = 'launchd';
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE');
    await expect(run('claude', root)).rejects.toThrow(/systemd only/);
  });

  it('refuses two legacy credentials rather than guessing', () => {
    fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=a\nCLAUDE_CODE_OAUTH_TOKEN=b\n');
    expect(() => takeLegacyEnvCredential(root)).toThrow(/keep one/);
  });
});
