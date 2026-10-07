import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCredentialStore } from './credential-store.js';
import { detectInstalledOpenShell } from './detect.js';
import { preflight, resolveBinary } from './preflight.js';

const READY = {
  NANOCLAW_RUNTIME_DRIVER: 'openshell',
  OPENSHELL_BIN: '/opt/openshell/bin/openshell',
  NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '23456',
  NANOCLAW_OPENSHELL_GATEWAY_PORTS: '23456',
  NANOCLAW_OPENSHELL_GATEWAY_BINARIES: '/usr/local/bin/bun,/usr/local/bin/node',
  NANOCLAW_OPENSHELL_GATEWAY_HOST: 'host.openshell.internal',
};
const found = () => '/opt/openshell/bin/openshell';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('openshell gateway preflight', () => {
  it('passes a copy configured by the openshell setup step', () => {
    expect(preflight(READY, found)).toEqual({ errors: [], warnings: [] });
  });

  it('refuses a docker-driver copy: the relay is only reachable from a sandbox', () => {
    const { errors } = preflight({ ...READY, NANOCLAW_RUNTIME_DRIVER: '' }, found);
    expect(errors.join('\n')).toMatch(/requires NANOCLAW_RUNTIME_DRIVER=openshell.*'docker'/);
  });

  it('requires an install-specific relay port (no fixed default)', () => {
    const { NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: _unset, ...noPort } = READY;
    expect(preflight(noPort, found).errors.join()).toMatch(/NANOCLAW_OPENSHELL_MODEL_RELAY_PORT is not set/);
  });

  it('refuses an egress allow-list that drifted from the relay port', () => {
    expect(preflight({ ...READY, NANOCLAW_OPENSHELL_GATEWAY_PORTS: '9999' }, found).errors.join()).toMatch(
      /must be exactly the relay port 23456/,
    );
    expect(preflight({ ...READY, NANOCLAW_OPENSHELL_GATEWAY_PORTS: '23456,9999' }, found).errors.join()).toMatch(
      /must be exactly/,
    );
    expect(preflight({ ...READY, NANOCLAW_OPENSHELL_GATEWAY_HOST: 'elsewhere' }, found).errors.join()).toMatch(
      /does not match the relay alias/,
    );
  });

  it('fails on a relay port held by another process; accepts this install’s own relay', () => {
    expect(preflight(READY, found, 'taken').errors.join()).toMatch(/already in use by another process/);
    expect(preflight(READY, found, 'ours').errors).toEqual([]);
    expect(preflight(READY, found, 'free').errors).toEqual([]);
  });

  it('only warns about a missing or PATH-relative CLI', () => {
    expect(preflight(READY, () => undefined)).toMatchObject({
      errors: [],
      warnings: [expect.stringMatching(/not found/)],
    });
    expect(preflight({ ...READY, OPENSHELL_BIN: 'openshell' }, found).warnings.join()).toMatch(/fixed PATH/);
  });

  it('resolves binaries by path or PATH search', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-bin-'));
    roots.push(dir);
    const bin = path.join(dir, 'openshell');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveBinary(bin)).toBe(bin);
    expect(resolveBinary('openshell', dir)).toBe(bin);
    expect(resolveBinary('openshell', '/nonexistent')).toBeUndefined();
  });
});

describe('openshell gateway detection and credential store', () => {
  it('detects an openshell-driver copy from .env only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-detect-'));
    roots.push(root);
    expect(detectInstalledOpenShell(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=docker\n');
    expect(detectInstalledOpenShell(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER="openshell"\n');
    expect(detectInstalledOpenShell(root)).toBe(true);
  });

  it('refuses to store credentials', async () => {
    const store = createCredentialStore();
    await expect(store.save('codex', { kind: 'api-key', value: 'x' })).rejects.toThrow(/does not store credentials/);
    expect(await store.has('codex')).toBe(false);
  });
});
