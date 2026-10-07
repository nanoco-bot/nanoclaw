/**
 * Credential rotation hash-diff: inspectServiceCredential reports a hash of
 * the value the relay sees (never the value), and credentialMatchesLive
 * compares a supplied credential against it. Every read path is covered: the
 * running service's /proc environ, the unit's Environment=, the drop-in file,
 * and the macOS LaunchAgent plist.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  credentialHash,
  credentialMatchesLive,
  inspectServiceCredential,
  launchdLocation,
  suppliedCredential,
  unitLocation,
} from './openshell-credential.js';

// Fixture-only values: shaped like real keys so the parsing paths are the real ones.
const SECRET = 'sk-ant-api03-FIXTURE-hashdiff-0123456789abcdef';
const OTHER = 'sk-ant-api03-FIXTURE-rotated-fedcba9876543210';
const OAUTH = 'sk-ant-oat01-FIXTURE-hashdiff-0123456789abcdef';

const loc = unitLocation('/srv/nanoclaw', { root: false, home: '/nonexistent-home' });
const noSystemctl = (): string => {
  throw new Error('ENOENT');
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('credentialHash', () => {
  it('is a stable hex HMAC that is not the value and does not contain it', () => {
    const h = credentialHash(SECRET);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(credentialHash(SECRET));
    expect(h).not.toContain(SECRET);
  });

  it('normalizes whitespace the way the paste prompt does', () => {
    expect(credentialHash(`  ${SECRET}\n`)).toBe(credentialHash(SECRET));
    expect(credentialHash(`${SECRET.slice(0, 10)}\n${SECRET.slice(10)}`)).toBe(credentialHash(SECRET));
  });

  it('differs for a different key', () => {
    expect(credentialHash(OTHER)).not.toBe(credentialHash(SECRET));
  });
});

type Deps = { exec?: () => string; readFile?: () => string };

describe('inspectServiceCredential carries the hash, never the value', () => {
  it.each<[string, Deps, string]>([
    [
      'running service (/proc environ)',
      {
        exec: () => 'MainPID=4242\nEnvironment=\n',
        readFile: () => `HOME=/h\0ANTHROPIC_API_KEY=${SECRET}\0`,
      },
      'running-service',
    ],
    [
      'unit Environment=',
      { exec: () => `MainPID=0\nEnvironment=HOME=/h ANTHROPIC_API_KEY=${SECRET}\n` },
      'unit-environment',
    ],
    [
      'drop-in file',
      { exec: noSystemctl, readFile: () => `[Service]\nEnvironment=ANTHROPIC_API_KEY=${SECRET}\n` },
      'drop-in-file',
    ],
  ])('%s', (_name, deps, source) => {
    const found = inspectServiceCredential(loc, deps);
    expect(found).toEqual({ kind: 'api-key', source, hash: credentialHash(SECRET) });
    expect(JSON.stringify(found)).not.toContain(SECRET);
  });

  it('no credential: no hash', () => {
    expect(inspectServiceCredential(loc, { exec: () => 'MainPID=0\nEnvironment=HOME=/h\n' })).toEqual({
      kind: 'none',
      source: 'unit-environment',
    });
  });

  it('macOS LaunchAgent plist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-cred-hash-'));
    dirs.push(home);
    const l = launchdLocation('/srv/nanoclaw', { home });
    fs.mkdirSync(path.dirname(l.plistPath), { recursive: true });
    fs.writeFileSync(
      l.plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>EnvironmentVariables</key><dict>` +
        `<key>CLAUDE_CODE_OAUTH_TOKEN</key><string>${OAUTH}</string></dict></dict></plist>\n`,
    );
    expect(inspectServiceCredential(l)).toEqual({
      kind: 'oauth',
      source: 'unit-environment',
      hash: credentialHash(OAUTH),
    });
    expect(credentialMatchesLive({ kind: 'oauth', value: OAUTH }, l)).toBe(true);
    expect(credentialMatchesLive({ kind: 'oauth', value: OAUTH.replace('FIXTURE', 'CHANGED') }, l)).toBe(false);
  });
});

describe('credentialMatchesLive', () => {
  const dropIn = { exec: noSystemctl, readFile: () => `[Service]\nEnvironment=ANTHROPIC_API_KEY=${SECRET}\n` };

  it('the same key, supplied through the NANOCLAW_-prefixed variable with stray whitespace, matches', () => {
    const cred = suppliedCredential({ NANOCLAW_ANTHROPIC_API_KEY: `\n  ${SECRET}  \n` })!;
    expect(credentialMatchesLive(cred, loc, dropIn)).toBe(true);
    const plain = suppliedCredential({ ANTHROPIC_API_KEY: SECRET })!;
    expect(credentialMatchesLive(plain, loc, dropIn)).toBe(true);
  });

  it('a changed key does not match', () => {
    expect(credentialMatchesLive({ kind: 'api-key', value: OTHER }, loc, dropIn)).toBe(false);
  });

  it('the same bytes under a different kind do not match (the variable the relay reads would change)', () => {
    expect(credentialMatchesLive({ kind: 'oauth', value: SECRET }, loc, dropIn)).toBe(false);
  });

  it('compares with what the RUNNING service has: a fresh drop-in it has not restarted onto is "different"', () => {
    const deps = {
      exec: () => 'MainPID=4242\nEnvironment=\n',
      readFile: (p: string) =>
        p.startsWith('/proc/') ? `ANTHROPIC_API_KEY=${OTHER}\0` : `Environment=ANTHROPIC_API_KEY=${SECRET}\n`,
    };
    expect(credentialMatchesLive({ kind: 'api-key', value: SECRET }, loc, deps)).toBe(false);
  });

  it('nothing configured never matches', () => {
    expect(
      credentialMatchesLive({ kind: 'api-key', value: SECRET }, loc, { exec: noSystemctl, readFile: noSystemctl }),
    ).toBe(false);
  });
});
