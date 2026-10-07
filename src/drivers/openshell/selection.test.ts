/**
 * In-tree wiring: the production selection entry point (`drivers/index.ts`)
 * reaches the OpenShell driver through the `installed.ts` barrel, and the
 * driver reads its settings from `.env` with `process.env` winning — the same
 * precedence the selection itself uses. No OpenShell binary or gateway is
 * needed: selecting the driver only constructs it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { configuredDriverKind, createSessionDriver, listSessionDriverKinds } from '../index.js';
import { openShellGatewayEnv, openShellSettingsEnv } from './config.js';
import { settingsFromEnv } from './settings.js';

let cwd: string;
let previous: string;

beforeEach(() => {
  previous = process.cwd();
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-selection-'));
  process.chdir(cwd);
});

afterEach(() => {
  process.chdir(previous);
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe('openshell selection through the real driver barrel', () => {
  it('is registered alongside docker, and docker stays the default', () => {
    expect(listSessionDriverKinds()).toEqual(expect.arrayContaining(['docker', 'openshell']));
    expect(configuredDriverKind({})).toBe('docker');
  });

  it('NANOCLAW_RUNTIME_DRIVER=openshell in .env resolves the openshell factory', () => {
    fs.writeFileSync(
      path.join(cwd, '.env'),
      'NANOCLAW_RUNTIME_DRIVER=openshell\nOPENSHELL_BIN=/opt/os/bin/openshell\n',
    );
    const kind = configuredDriverKind({});
    expect(kind).toBe('openshell');
    const driver = createSessionDriver(kind);
    expect(driver.kind).toBe('openshell');
    expect(driver.capabilities()).toMatchObject({ networkPolicy: 'declarative', auxiliaryContainers: false });
  });

  it('a bad OpenShell setting fails selection loudly instead of falling back to docker', () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCLAW_OPENSHELL_LANDLOCK=strict\n');
    expect(() => createSessionDriver('openshell')).toThrow(/best_effort or hard_requirement/);
  });
});

describe('openShellSettingsEnv', () => {
  it('reads .env, with process.env winning per key', () => {
    const merged = openShellSettingsEnv(
      { OPENSHELL_BIN: '/from/process', OPENSHELL_GATEWAY: '' },
      { OPENSHELL_BIN: '/from/file', NANOCLAW_OPENSHELL_BASE_RW: '/tmp', OPENSHELL_GATEWAY: 'lab' },
    );
    expect(settingsFromEnv(merged)).toMatchObject({ bin: '/from/process', policy: { baseReadWrite: ['/tmp'] } });
    // An empty process value does not blank out the file's.
    expect(openShellGatewayEnv(merged)).toEqual({ OPENSHELL_GATEWAY: 'lab' });
  });

  it('ignores unrelated keys from the process environment', () => {
    const merged = openShellSettingsEnv({ ANTHROPIC_API_KEY: 'not-forwarded', PATH: '/bin' }, {});
    expect(merged).toEqual({});
  });
});
