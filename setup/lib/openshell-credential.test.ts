import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  credentialKindIn,
  inspectServiceCredential,
  renderCredentialDropIn,
  suppliedCredential,
  unitLocation,
  writeCredentialDropIn,
} from './openshell-credential.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'os-cred-'));
  dirs.push(d);
  return d;
};

describe('credential drop-in location', () => {
  it('sits next to this install’s unit: user unit for users, system unit for root', () => {
    const user = unitLocation('/srv/nanoclaw', { root: false, home: '/home/op' });
    expect(user.unit).toMatch(/^nanoclaw-v2-[0-9a-f]{8}$/);
    expect(user.dropInPath).toBe(`/home/op/.config/systemd/user/${user.unit}.service.d/credential.conf`);
    expect(user.systemctl).toEqual(['systemctl', '--user']);
    const root = unitLocation('/srv/nanoclaw', { root: true });
    expect(root.dropInPath).toBe(`/etc/systemd/system/${root.unit}.service.d/credential.conf`);
    expect(root.systemctl).toEqual(['systemctl']);
  });
});

describe('writing the credential drop-in', () => {
  it('writes a [Service] Environment= line, owner-only (0600 file, 0700 dir)', () => {
    const home = tmp();
    const loc = unitLocation('/srv/nanoclaw', { root: false, home });
    writeCredentialDropIn(loc, { kind: 'api-key', value: 'sk-ant-api03-FAKE_test-value' });
    const text = fs.readFileSync(loc.dropInPath, 'utf8');
    expect(text).toContain('[Service]\nEnvironment=ANTHROPIC_API_KEY=sk-ant-api03-FAKE_test-value\n');
    expect(fs.statSync(loc.dropInPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(loc.dropInDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(loc.dropInDir)).toEqual(['credential.conf']);
    // Replacing it keeps exactly one credential.
    writeCredentialDropIn(loc, { kind: 'oauth', value: 'sk-ant-oat01-FAKE' });
    const replaced = fs.readFileSync(loc.dropInPath, 'utf8');
    expect(replaced).toContain('Environment=CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE');
    expect(replaced).not.toContain('ANTHROPIC_API_KEY');
  });

  it('refuses values that could inject systemd directives or be reinterpreted', () => {
    for (const value of ['abc\n[Service]\nExecStartPre=/bin/sh', 'a b', 'a"b', 'a%b', 'a\\b', '']) {
      expect(() => renderCredentialDropIn({ kind: 'api-key', value })).toThrow(
        /characters a credential never contains/,
      );
    }
  });
});

describe('supplied credentials (non-interactive setup)', () => {
  it('follows the other gateways’ convention; an sk-ant-oat value is OAuth whichever variable carried it', () => {
    expect(suppliedCredential({ ANTHROPIC_API_KEY: 'sk-ant-api03-x' })).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api03-x',
    });
    expect(suppliedCredential({ ANTHROPIC_API_KEY: 'sk-ant-oat01-x' })).toEqual({
      kind: 'oauth',
      value: 'sk-ant-oat01-x',
    });
    expect(suppliedCredential({ NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' })).toEqual({
      kind: 'oauth',
      value: 't',
    });
    expect(suppliedCredential({})).toBeUndefined();
  });
});

describe('inspecting what the relay will see', () => {
  const loc = unitLocation('/srv/nanoclaw', { root: false, home: '/nonexistent-home' });

  it('prefers the running service’s own environment', () => {
    const found = inspectServiceCredential(loc, {
      exec: () => 'MainPID=4242\nEnvironment=HOME=/h PATH=/bin\n',
      readFile: (p) => {
        expect(p).toBe('/proc/4242/environ');
        return 'HOME=/h\0PATH=/bin\0ANTHROPIC_API_KEY=sk-ant-api03-x\0';
      },
    });
    expect(found).toEqual({ kind: 'api-key', source: 'running-service' });
  });

  it('a running service without the variable reads as missing, even if the drop-in exists on disk', () => {
    const found = inspectServiceCredential(loc, {
      exec: () => 'MainPID=4242\nEnvironment=HOME=/h CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n',
      readFile: () => 'HOME=/h\0PATH=/bin\0',
    });
    expect(found).toEqual({ kind: 'none', source: 'running-service' });
  });

  it('a stopped unit: its configured Environment (what the next start gets)', () => {
    expect(
      inspectServiceCredential(loc, {
        exec: () => 'MainPID=0\nEnvironment=HOME=/h CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n',
      }),
    ).toEqual({ kind: 'oauth', source: 'unit-environment' });
    expect(inspectServiceCredential(loc, { exec: () => 'MainPID=0\nEnvironment=HOME=/h PATH=/bin\n' })).toEqual({
      kind: 'none',
      source: 'unit-environment',
    });
  });

  it('no systemd manager to ask: the drop-in file, else unavailable', () => {
    const noSystemctl = () => {
      throw new Error('ENOENT');
    };
    expect(
      inspectServiceCredential(loc, {
        exec: noSystemctl,
        readFile: () => '[Service]\nEnvironment=ANTHROPIC_API_KEY=sk-x\n',
      }),
    ).toEqual({ kind: 'api-key', source: 'drop-in-file' });
    expect(inspectServiceCredential(loc, { exec: noSystemctl, readFile: noSystemctl })).toEqual({
      kind: 'none',
      source: 'unavailable',
    });
  });

  it('credentialKindIn ignores empty values and look-alike keys', () => {
    expect(credentialKindIn('X_ANTHROPIC_API_KEY=abc')).toBeUndefined();
    expect(credentialKindIn('ANTHROPIC_API_KEY= PATH=/bin')).toBeUndefined();
    expect(credentialKindIn('"ANTHROPIC_API_KEY=abc"')).toBe('api-key');
  });
});
