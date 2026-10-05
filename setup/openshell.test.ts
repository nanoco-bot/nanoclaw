import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installGateway = vi.hoisted(() => vi.fn(async (kind: string) => ({ kind, label: kind })));
vi.mock('./gateways/install.js', () => ({ installGateway }));
vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { OPENSHELL_POLICY_DEFAULTS, parseOpenShellArgs, planOpenShellEnv, run } from './openshell.js';

let root: string;
let previous: string;
const envFile = () => path.join(root, '.env');
const readEnv = () => (fs.existsSync(envFile()) ? fs.readFileSync(envFile(), 'utf8') : '');

beforeEach(() => {
  previous = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-openshell-'));
  process.chdir(root);
  installGateway.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(previous);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('planOpenShellEnv', () => {
  it('selects the openshell driver, resolves the CLI, and fills policy defaults', () => {
    const plan = planOpenShellEnv(
      { enable: true, bin: 'openshell', gateway: 'lab' },
      {},
      () => '/usr/local/bin/openshell',
    );
    expect(plan).toEqual({
      writes: {
        NANOCLAW_RUNTIME_DRIVER: 'openshell',
        OPENSHELL_BIN: '/usr/local/bin/openshell',
        OPENSHELL_GATEWAY: 'lab',
        ...OPENSHELL_POLICY_DEFAULTS,
      },
      warnings: [],
    });
  });

  it('never overwrites policy settings the operator already chose', () => {
    const plan = planOpenShellEnv({ enable: true }, { NANOCLAW_OPENSHELL_BASE_RW: '/tmp' }, () => '/x/openshell');
    expect(plan.writes.NANOCLAW_OPENSHELL_BASE_RW).toBeUndefined();
    expect(plan.writes.NANOCLAW_OPENSHELL_BASE_RO).toBe(OPENSHELL_POLICY_DEFAULTS.NANOCLAW_OPENSHELL_BASE_RO);
  });

  it('keeps an unresolvable CLI path as entered, with a warning', () => {
    const plan = planOpenShellEnv({ enable: true, bin: '/opt/missing/openshell' }, {}, () => undefined);
    expect(plan.writes.OPENSHELL_BIN).toBe('/opt/missing/openshell');
    expect(plan.warnings.join()).toMatch(/not found/);
  });
});

describe('parseOpenShellArgs', () => {
  it('parses enable/disable, bin, gateway and --no-gateway', () => {
    expect(parseOpenShellArgs(['--enable', '--bin', '/b', '--gateway', 'g', '--no-gateway'])).toEqual({
      enable: true,
      bin: '/b',
      gateway: 'g',
      installGateway: false,
    });
    expect(parseOpenShellArgs([])).toEqual({ installGateway: true });
    expect(() => parseOpenShellArgs(['--bin'])).toThrow(/incomplete/);
  });
});

describe('setup --step openshell', () => {
  it('unanswered and non-interactive: declines and writes nothing (Docker unchanged)', async () => {
    fs.writeFileSync(envFile(), 'TZ=UTC\n');
    await run([]);
    expect(readEnv()).toBe('TZ=UTC\n');
    expect(installGateway).not.toHaveBeenCalled();
  });

  it('--enable writes the driver settings and installs the openshell gateway', async () => {
    await run(['--enable', '--bin', '/opt/openshell/bin/openshell']);
    const env = readEnv();
    expect(env).toMatch(/^NANOCLAW_RUNTIME_DRIVER=openshell$/m);
    expect(env).toMatch(/^OPENSHELL_BIN=\/opt\/openshell\/bin\/openshell$/m);
    expect(env).toMatch(/^NANOCLAW_OPENSHELL_GATEWAY_PORTS=18790$/m);
    expect(installGateway).toHaveBeenCalledWith('openshell');
  });

  it('--no-gateway leaves the gateway to the caller', async () => {
    await run(['--enable', '--no-gateway']);
    expect(readEnv()).toMatch(/^NANOCLAW_RUNTIME_DRIVER=openshell$/m);
    expect(installGateway).not.toHaveBeenCalled();
  });

  it('--disable returns to the Docker default and clears an openshell gateway stamp', async () => {
    fs.writeFileSync(
      envFile(),
      'NANOCLAW_RUNTIME_DRIVER=openshell\nNANOCLAW_GATEWAY_PROVIDER=openshell\nOPENSHELL_BIN=/b\n',
    );
    await run(['--disable']);
    expect(readEnv()).toBe('OPENSHELL_BIN=/b\n');
  });
});
