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
  // launchd ⇔ macOS, as setup/platform.ts derives it.
  getPlatform: () => (manager.value === 'launchd' ? 'macos' : 'linux'),
}));
const reloads = vi.hoisted(() => ({ calls: [] as [string, string][] }));
vi.mock('../../../../setup/service.js', async (original) => ({
  ...(await original<typeof import('../../../../setup/service.js')>()),
  reloadLaunchAgent: (plistPath: string, label: string) => {
    reloads.calls.push([plistPath, label]);
  },
}));
vi.mock('@clack/prompts', () => ({ log: { success: vi.fn(), warn: vi.fn() }, isCancel: () => false }));

import { launchdLocation, unitLocation } from '../../../../setup/lib/openshell-credential.js';
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
  reloads.calls = [];
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
    // (Before that, the rotation check asked systemd what the service has.)
    expect(systemctl.calls.find((c) => c[2] !== 'show')).toEqual(['systemctl', '--user', 'daemon-reload']);
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

  it('refuses other providers, and hosts with neither systemd nor launchd (WSL / nohup)', async () => {
    await expect(run('codex', root)).rejects.toThrow(/Anthropic model credentials only/);
    manager.value = 'none';
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE');
    await expect(run('claude', root)).rejects.toThrow(/neither systemd nor launchd/);
    expect(fs.existsSync(dropIn())).toBe(false);
  });

  it('macOS: accepted — writes the key into the NanoClaw LaunchAgent plist and reloads that service', async () => {
    manager.value = 'launchd';
    const loc = launchdLocation(root, { home });
    fs.mkdirSync(path.dirname(loc.plistPath), { recursive: true });
    fs.writeFileSync(
      loc.plistPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n    <key>Label</key>\n    <string>' +
        loc.label +
        '</string>\n    <key>EnvironmentVariables</key>\n    <dict>\n        <key>HOME</key>\n        <string>/Users/a</string>\n    </dict>\n</dict>\n</plist>',
    );
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-FAKE');
    await run('claude', root);
    expect(fs.readFileSync(loc.plistPath, 'utf8')).toContain(
      '<key>HOME</key>\n        <string>/Users/a</string>\n        <key>CLAUDE_CODE_OAUTH_TOKEN</key>\n        <string>sk-ant-oat01-FAKE</string>\n    </dict>',
    );
    expect(reloads.calls).toEqual([[loc.plistPath, loc.label]]);
    expect(systemctl.calls).toEqual([]); // no systemd on macOS
    expect(fs.existsSync(dropIn())).toBe(false);
  });

  it('macOS without the NanoClaw LaunchAgent: clear error before any prompt, nothing written', async () => {
    manager.value = 'launchd';
    const loc = launchdLocation(root, { home });
    await expect(run('claude', root)).rejects.toThrow(/No NanoClaw LaunchAgent at .*--step service/);
    expect(fs.existsSync(loc.plistPath)).toBe(false);
    expect(reloads.calls).toEqual([]);
  });

  it('refuses two legacy credentials rather than guessing', () => {
    fs.writeFileSync(path.join(root, '.env'), 'ANTHROPIC_API_KEY=a\nCLAUDE_CODE_OAUTH_TOKEN=b\n');
    expect(() => takeLegacyEnvCredential(root)).toThrow(/keep one/);
  });
});
