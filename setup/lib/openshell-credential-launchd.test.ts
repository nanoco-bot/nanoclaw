/**
 * macOS: the OpenShell relay credential in the NanoClaw LaunchAgent plist.
 * (The Linux systemd drop-in tests live in openshell-credential.test.ts and
 * are unchanged.)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { getLaunchdLabel } from '../../src/install-slug.js';
import { carriedRelayCredential, reloadLaunchAgent } from '../service.js';
import { RELAY_CREDENTIAL_KEYS, editPlistEnvironment, readPlistEnvironment } from './launchd-plist.js';
import {
  CREDENTIAL_ENV,
  UNSUPPORTED_SERVICE_MANAGER,
  assertServiceReady,
  credentialLocation,
  inspectServiceCredential,
  launchdLocation,
  unitLocation,
  writeLaunchdCredential,
  writeServiceCredential,
} from './openshell-credential.js';

/** Exactly what setup/service.ts setupLaunchd writes (with one proxy variable). */
function servicePlist(label: string, extraEnv = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/asaf/nanoclaw/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/asaf/nanoclaw</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/Users/asaf/.local/bin</string>
        <key>HOME</key>
        <string>/Users/asaf</string>
        <key>HTTPS_PROXY</key>
        <string>http://user:p&amp;ss@proxy.example.invalid:3128</string>${extraEnv}
    </dict>
    <key>StandardOutPath</key>
    <string>/Users/asaf/nanoclaw/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/asaf/nanoclaw/logs/nanoclaw.error.log</string>
</dict>
</plist>`;
}

const entry = (key: string, value: string) => `\n        <key>${key}</key>\n        <string>${value}</string>`;

let home: string;
let root: string;
let reloads: [string, string][];
const reload = (plistPath: string, label: string) => {
  reloads.push([plistPath, label]);
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-cred-mac-'));
  root = '/Users/asaf/nanoclaw';
  reloads = [];
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

function installPlist(extraEnv = ''): { loc: ReturnType<typeof launchdLocation>; before: string } {
  const loc = launchdLocation(root, { home });
  fs.mkdirSync(path.dirname(loc.plistPath), { recursive: true });
  const before = servicePlist(loc.label, extraEnv);
  fs.writeFileSync(loc.plistPath, before, { mode: 0o644 });
  return { loc, before };
}

describe('where the credential goes, per platform', () => {
  it('macOS → the host service’s LaunchAgent plist; Linux+systemd → the drop-in; anything else → refused', () => {
    expect(credentialLocation(root, { platform: 'macos', home })).toEqual({
      kind: 'launchd',
      label: getLaunchdLabel(root),
      plistPath: path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(root)}.plist`),
    });
    expect(credentialLocation(root, { platform: 'linux', serviceManager: 'systemd', root: false, home })).toEqual(
      unitLocation(root, { root: false, home }),
    );
    expect(() => credentialLocation(root, { platform: 'linux', serviceManager: 'none' })).toThrow(
      UNSUPPORTED_SERVICE_MANAGER,
    );
    expect(() => credentialLocation(root, { platform: 'unknown' })).toThrow(/neither systemd nor launchd/);
  });

  it('the plist edit and the relay agree on the credential variable names', () => {
    expect([...RELAY_CREDENTIAL_KEYS].sort()).toEqual(Object.values(CREDENTIAL_ENV).sort());
  });
});

describe('writing the credential into the LaunchAgent plist', () => {
  it('adds the key when absent: the only change is the new pair at the end of EnvironmentVariables', () => {
    const { loc, before } = installPlist();
    writeLaunchdCredential(loc, { kind: 'api-key', value: 'sk-ant-api03-FAKE' }, { reload });
    const after = fs.readFileSync(loc.plistPath, 'utf8');
    const added = entry('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE');
    expect(after).toBe(
      before.replace('ss@proxy.example.invalid:3128</string>', `ss@proxy.example.invalid:3128</string>${added}`),
    );
    expect(after.split(added).join('')).toBe(before); // every other byte unchanged
    expect(reloads).toEqual([[loc.plistPath, loc.label]]);
  });

  it('replaces an existing value in place (re-running auth updates it, like the drop-in)', () => {
    const { loc, before } = installPlist(entry('ANTHROPIC_API_KEY', 'sk-ant-api03-OLD'));
    writeLaunchdCredential(loc, { kind: 'api-key', value: 'sk-ant-api03-NEW' }, { reload });
    expect(fs.readFileSync(loc.plistPath, 'utf8')).toBe(before.replace('sk-ant-api03-OLD', 'sk-ant-api03-NEW'));
  });

  it('switching kind leaves exactly one credential (an old API key would otherwise win over a new OAuth token)', () => {
    const { loc, before } = installPlist(entry('ANTHROPIC_API_KEY', 'sk-ant-api03-OLD'));
    writeLaunchdCredential(loc, { kind: 'oauth', value: 'sk-ant-oat01-NEW' }, { reload });
    const after = fs.readFileSync(loc.plistPath, 'utf8');
    expect(after).toBe(
      before.replace(
        entry('ANTHROPIC_API_KEY', 'sk-ant-api03-OLD'),
        entry('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-NEW'),
      ),
    );
    expect(readPlistEnvironment(after)?.has('ANTHROPIC_API_KEY')).toBe(false);
  });

  it('preserves every other key and value, including the escaped proxy password', () => {
    const { loc, before } = installPlist();
    writeLaunchdCredential(loc, { kind: 'oauth', value: 'sk-ant-oat01-FAKE' }, { reload });
    const envBefore = readPlistEnvironment(before)!;
    const envAfter = readPlistEnvironment(fs.readFileSync(loc.plistPath, 'utf8'))!;
    expect(envBefore.get('HTTPS_PROXY')).toBe('http://user:p&ss@proxy.example.invalid:3128');
    for (const [k, v] of envBefore) expect(envAfter.get(k)).toBe(v);
    expect([...envAfter.keys()]).toEqual([...envBefore.keys(), 'CLAUDE_CODE_OAUTH_TOKEN']);
    // Outside EnvironmentVariables: identical bytes.
    const outside = (text: string) => text.replace(/<key>EnvironmentVariables<\/key>[\s\S]*?<\/dict>/, '');
    expect(outside(fs.readFileSync(loc.plistPath, 'utf8'))).toBe(outside(before));
  });

  it('writes owner-only (0600) via rename, leaving no temp file', () => {
    const { loc } = installPlist();
    writeLaunchdCredential(loc, { kind: 'api-key', value: 'sk-ant-api03-FAKE' }, { reload });
    expect(fs.statSync(loc.plistPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(loc.plistPath))).toEqual([path.basename(loc.plistPath)]);
  });

  it('missing plist: clear error, never creates one, never reloads', () => {
    const loc = launchdLocation(root, { home });
    expect(() => assertServiceReady(loc)).toThrow(/No NanoClaw LaunchAgent at .*--step service.*--step gateway-auth/);
    expect(() => writeLaunchdCredential(loc, { kind: 'api-key', value: 'sk-ant-api03-FAKE' }, { reload })).toThrow(
      /No NanoClaw LaunchAgent/,
    );
    expect(fs.existsSync(loc.plistPath)).toBe(false);
    expect(reloads).toEqual([]);
    // The systemd drop-in has no such precondition (it may precede its unit).
    expect(() => assertServiceReady(unitLocation(root, { root: false, home }))).not.toThrow();
  });

  it('refuses unsafe values before touching the file', () => {
    const { loc, before } = installPlist();
    expect(() => writeLaunchdCredential(loc, { kind: 'api-key', value: 'x</string><key>EVIL' }, { reload })).toThrow(
      /characters/,
    );
    expect(fs.readFileSync(loc.plistPath, 'utf8')).toBe(before);
  });

  it('writeServiceCredential dispatches: launchd → plist, systemd → drop-in', () => {
    const { loc } = installPlist();
    writeServiceCredential(loc, { kind: 'api-key', value: 'sk-ant-api03-FAKE' }, { reload });
    expect(readPlistEnvironment(fs.readFileSync(loc.plistPath, 'utf8'))?.get('ANTHROPIC_API_KEY')).toBe(
      'sk-ant-api03-FAKE',
    );
    const unit = unitLocation(root, { root: false, home });
    writeServiceCredential(unit, { kind: 'oauth', value: 'sk-ant-oat01-FAKE' });
    expect(fs.readFileSync(unit.dropInPath, 'utf8')).toContain('Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE');
  });
});

describe('reading it back on macOS', () => {
  it('reports the kind from the plist’s EnvironmentVariables as unit-environment (no /proc, no drop-in)', () => {
    const { loc } = installPlist();
    const readFile = vi.fn((p: string) => fs.readFileSync(p, 'utf8'));
    const exec = vi.fn(() => {
      throw new Error('systemctl must not be used on macOS');
    });
    expect(inspectServiceCredential(loc, { readFile, exec })).toEqual({ kind: 'none', source: 'unit-environment' });
    writeLaunchdCredential(loc, { kind: 'oauth', value: 'sk-ant-oat01-FAKE' }, { reload });
    expect(inspectServiceCredential(loc, { readFile, exec })).toEqual({ kind: 'oauth', source: 'unit-environment' });
    expect(readFile.mock.calls.every(([p]) => p === loc.plistPath)).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('no plist → unavailable', () => {
    expect(inspectServiceCredential(launchdLocation(root, { home }))).toEqual({ kind: 'none', source: 'unavailable' });
  });
});

describe('plist editing edge cases', () => {
  it('a plist without EnvironmentVariables gets one, appended to the top-level dict', () => {
    const plist =
      '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n    <key>Label</key>\n    <string>x</string>\n</dict>\n</plist>\n';
    const out = editPlistEnvironment(plist, { ANTHROPIC_API_KEY: 'k' });
    expect(out).toBe(
      '<?xml version="1.0"?>\n<plist version="1.0">\n<dict>\n    <key>Label</key>\n    <string>x</string>\n' +
        '    <key>EnvironmentVariables</key>\n    <dict>\n        <key>ANTHROPIC_API_KEY</key>\n        <string>k</string>\n    </dict>\n' +
        '</dict>\n</plist>\n',
    );
    expect(readPlistEnvironment(out)?.get('ANTHROPIC_API_KEY')).toBe('k');
  });
});

describe('setup/service.ts keeps the credential across its own plist rewrites', () => {
  it('carries an existing relay credential into the regenerated plist', () => {
    const { loc } = installPlist(entry('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-KEEP'));
    expect(carriedRelayCredential(loc.plistPath)).toEqual([['CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-KEEP']]);
    expect(carriedRelayCredential(path.join(home, 'nope.plist'))).toEqual([]);
  });

  it('reloadLaunchAgent: unload (failure tolerated) → load → kickstart gui/<uid>/<label>', () => {
    const cmds: string[] = [];
    vi.spyOn(process, 'getuid').mockReturnValue(501);
    reloadLaunchAgent('/Users/a/Library/LaunchAgents/com.nanoclaw-v2-x.plist', 'com.nanoclaw-v2-x', (c) => {
      cmds.push(c);
      if (c.startsWith('launchctl unload')) throw new Error('Could not find specified service');
    });
    expect(cmds).toEqual([
      'launchctl unload "/Users/a/Library/LaunchAgents/com.nanoclaw-v2-x.plist"',
      'launchctl load "/Users/a/Library/LaunchAgents/com.nanoclaw-v2-x.plist"',
      'launchctl kickstart gui/501/com.nanoclaw-v2-x',
    ]);
  });
});
