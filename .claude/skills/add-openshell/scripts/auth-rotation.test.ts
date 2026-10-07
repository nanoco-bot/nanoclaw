/**
 * Re-running the OpenShell auth step to rotate the Claude credential: an
 * unchanged key writes nothing and restarts nothing; a changed key is written
 * and the service restarted exactly as before. The live key is compared by
 * hash only, and neither it nor its hash ever reaches a log line.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A reachable systemd that answers daemon-reload/try-restart; `show` fails, so
// the live credential is read from the drop-in (inspectServiceCredential's fallback).
const systemctl = vi.hoisted(() => ({ calls: [] as string[][] }));
const fakeExecFileSync = vi.hoisted(() => (cmd: string, args: string[]) => {
  systemctl.calls.push([cmd, ...args]);
  if (args.includes('show')) throw new Error('show unavailable in this test');
  return '';
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: fakeExecFileSync,
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: fakeExecFileSync,
}));
const manager = vi.hoisted(() => ({ value: 'systemd' as 'systemd' | 'launchd' }));
vi.mock('../../../../setup/platform.js', async (original) => ({
  ...(await original<typeof import('../../../../setup/platform.js')>()),
  getServiceManager: () => manager.value,
  getPlatform: () => (manager.value === 'launchd' ? 'macos' : 'linux'),
}));
const reloads = vi.hoisted(() => ({ calls: [] as [string, string][] }));
vi.mock('../../../../setup/service.js', async (original) => ({
  ...(await original<typeof import('../../../../setup/service.js')>()),
  reloadLaunchAgent: (plistPath: string, label: string) => {
    reloads.calls.push([plistPath, label]);
  },
}));
const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@clack/prompts', () => ({
  log: {
    success: (m: string) => void logged.lines.push(m),
    warn: (m: string) => void logged.lines.push(m),
    info: (m: string) => void logged.lines.push(m),
  },
  isCancel: () => false,
}));

import { credentialHash, launchdLocation, unitLocation } from '../../../../setup/lib/openshell-credential.js';
import { run } from './auth.js';

const KEY_A = 'sk-ant-api03-FIXTURE-rotation-AAAAAAAAAAAAAAAA';
const KEY_B = 'sk-ant-api03-FIXTURE-rotation-BBBBBBBBBBBBBBBB';

let home: string;
let root: string;
const restarts = () => systemctl.calls.filter((c) => c.includes('try-restart')).length;
const reloadsOfUnit = () => systemctl.calls.filter((c) => c.includes('daemon-reload')).length;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-rot-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-rot-root-'));
  vi.stubEnv('HOME', home);
  for (const k of [
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'NANOCLAW_ANTHROPIC_API_KEY',
    'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN',
  ])
    vi.stubEnv(k, '');
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.lines.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void logged.lines.push(a.join(' ')));
  systemctl.calls = [];
  reloads.calls = [];
  logged.lines = [];
  manager.value = 'systemd';
});
afterEach(() => {
  // Neither the key nor its hash may appear in anything this step printed.
  const out = logged.lines.join('\n');
  for (const secret of [KEY_A, KEY_B]) {
    expect(out).not.toContain(secret);
    expect(out).not.toContain(credentialHash(secret));
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('rotating the OpenShell relay credential (systemd)', () => {
  const dropIn = () => unitLocation(root, { root: false, home }).dropInPath;

  it('the same key twice: the second run writes nothing and restarts the service zero times', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY_A);
    await run('claude', root);
    expect(restarts()).toBe(1);
    const firstWrite = fs.statSync(dropIn()).mtimeMs;

    systemctl.calls = [];
    logged.lines = [];
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('NANOCLAW_ANTHROPIC_API_KEY', ` ${KEY_A}\n`); // other variable, stray whitespace: same key
    await run('claude', root);

    expect(restarts()).toBe(0);
    expect(reloadsOfUnit()).toBe(0);
    expect(fs.statSync(dropIn()).mtimeMs).toBe(firstWrite);
    expect(logged.lines).toEqual([
      'Claude credential unchanged for the OpenShell relay (api-key, drop-in-file) — nothing to restart.',
    ]);
  });

  it('a changed key is written and the service restarted, exactly as before', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY_A);
    await run('claude', root);
    systemctl.calls = [];

    vi.stubEnv('ANTHROPIC_API_KEY', KEY_B);
    await run('claude', root);

    expect(reloadsOfUnit()).toBe(1);
    expect(restarts()).toBe(1);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain(`Environment=ANTHROPIC_API_KEY=${KEY_B}`);
  });

  it('the same value switching kind (API key → OAuth variable) is a change', async () => {
    const oauth = 'sk-ant-oat01-FIXTURE-rotation-CCCCCCCCCCCCCCCC';
    vi.stubEnv('ANTHROPIC_API_KEY', KEY_A);
    await run('claude', root);
    systemctl.calls = [];
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', oauth);
    await run('claude', root);
    expect(restarts()).toBe(1);
    expect(fs.readFileSync(dropIn(), 'utf8')).toContain(`Environment=CLAUDE_CODE_OAUTH_TOKEN=${oauth}`);
  });
});

describe('rotating the OpenShell relay credential (macOS LaunchAgent)', () => {
  function plist(): string {
    const loc = launchdLocation(root, { home });
    fs.mkdirSync(path.dirname(loc.plistPath), { recursive: true });
    fs.writeFileSync(
      loc.plistPath,
      '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>x</string>' +
        '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict></dict></plist>\n',
    );
    return loc.plistPath;
  }

  it('the same key twice reloads the LaunchAgent once; a changed key reloads it again', async () => {
    manager.value = 'launchd';
    const plistPath = plist();
    vi.stubEnv('ANTHROPIC_API_KEY', KEY_A);
    await run('claude', root);
    expect(reloads.calls).toHaveLength(1);

    await run('claude', root);
    expect(reloads.calls).toHaveLength(1);
    expect(logged.lines.at(-1)).toBe(
      'Claude credential unchanged for the OpenShell relay (api-key, unit-environment) — nothing to restart.',
    );

    vi.stubEnv('ANTHROPIC_API_KEY', KEY_B);
    await run('claude', root);
    expect(reloads.calls).toHaveLength(2);
    expect(fs.readFileSync(plistPath, 'utf8')).toContain(KEY_B);
  });
});
