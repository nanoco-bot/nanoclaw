import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installGateway = vi.hoisted(() => vi.fn(async (kind: string) => ({ kind, label: kind })));
vi.mock('./gateways/install.js', () => ({ installGateway }));
vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// No Docker here: a fake runner that reports "no base image" unless a test says otherwise.
const docker = vi.hoisted(() => ({ hasBase: false, builds: [] as string[] }));
vi.mock('./lib/openshell-image.js', async (original) => {
  const real = await original<typeof import('./lib/openshell-image.js')>();
  const fake: import('./lib/openshell-image.js').DockerRunner = (args, input) => {
    if (args[0] === 'image' && args.includes('{{.Id}}'))
      return { status: docker.hasBase ? 0 : 1, stdout: 'sha256:base', stderr: '' };
    if (args[0] === 'build') {
      docker.builds.push(input ?? '');
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '/sandbox\n', stderr: '' };
  };
  return { ...real, realDocker: fake };
});
// Deterministic ports: everything is free.
vi.mock('./lib/openshell-relay-port.js', async (original) => {
  const real = await original<typeof import('./lib/openshell-relay-port.js')>();
  return {
    ...real,
    selectRelayPort: (existing: Record<string, string | undefined>, slug: string) =>
      real.selectRelayPort(existing, slug, async () => 'free'),
  };
});

import { candidateRelayPort } from './lib/openshell-relay-port.js';
import { OPENSHELL_POLICY_DEFAULTS, parseOpenShellArgs, planOpenShellEnv, run } from './openshell.js';
import { getInstallSlug } from '../src/install-slug.js';

let root: string;
let previous: string;
const envFile = () => path.join(root, '.env');
const readEnv = () => (fs.existsSync(envFile()) ? fs.readFileSync(envFile(), 'utf8') : '');
const envValue = (key: string) => readEnv().match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1];

beforeEach(() => {
  previous = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-openshell-'));
  process.chdir(root);
  installGateway.mockClear();
  docker.hasBase = false;
  docker.builds = [];
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(previous);
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('planOpenShellEnv', () => {
  it('selects the openshell driver, resolves the CLI, fills policy defaults, and writes the port pair', () => {
    const plan = planOpenShellEnv(
      { enable: true, bin: 'openshell', gateway: 'lab' },
      {},
      23456,
      () => '/usr/local/bin/openshell',
    );
    expect(plan).toEqual({
      writes: {
        NANOCLAW_RUNTIME_DRIVER: 'openshell',
        OPENSHELL_BIN: '/usr/local/bin/openshell',
        OPENSHELL_GATEWAY: 'lab',
        ...OPENSHELL_POLICY_DEFAULTS,
        NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '23456',
        NANOCLAW_OPENSHELL_GATEWAY_PORTS: '23456',
      },
      warnings: [],
    });
  });

  it('always rewrites both port keys together, even over operator values', () => {
    const plan = planOpenShellEnv(
      { enable: true },
      { NANOCLAW_OPENSHELL_GATEWAY_PORTS: '18790,9999', NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '18790' },
      24000,
      () => '/x/openshell',
    );
    expect(plan.writes.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT).toBe('24000');
    expect(plan.writes.NANOCLAW_OPENSHELL_GATEWAY_PORTS).toBe('24000');
  });

  it('never overwrites non-port policy settings the operator already chose', () => {
    const plan = planOpenShellEnv(
      { enable: true },
      { NANOCLAW_OPENSHELL_BASE_RW: '/tmp' },
      24000,
      () => '/x/openshell',
    );
    expect(plan.writes.NANOCLAW_OPENSHELL_BASE_RW).toBeUndefined();
    expect(plan.writes.NANOCLAW_OPENSHELL_BASE_RO).toBe(OPENSHELL_POLICY_DEFAULTS.NANOCLAW_OPENSHELL_BASE_RO);
  });

  it('keeps an unresolvable CLI path as entered, with a warning', () => {
    const plan = planOpenShellEnv({ enable: true, bin: '/opt/missing/openshell' }, {}, 24000, () => undefined);
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
    expect(docker.builds).toEqual([]);
  });

  it('--enable writes the driver settings, an install-specific relay port pair, and installs the gateway', async () => {
    await run(['--enable', '--bin', '/opt/openshell/bin/openshell']);
    expect(envValue('NANOCLAW_RUNTIME_DRIVER')).toBe('openshell');
    expect(envValue('OPENSHELL_BIN')).toBe('/opt/openshell/bin/openshell');
    const port = envValue('NANOCLAW_OPENSHELL_MODEL_RELAY_PORT');
    expect(port).toBe(String(candidateRelayPort(getInstallSlug(root))));
    expect(envValue('NANOCLAW_OPENSHELL_GATEWAY_PORTS')).toBe(port);
    expect(port).not.toBe('18790');
    expect(installGateway).toHaveBeenCalledWith('openshell');
  });

  it('migrates a legacy fixed 18790 egress setting to this install’s own port pair', async () => {
    fs.writeFileSync(envFile(), 'NANOCLAW_OPENSHELL_GATEWAY_PORTS=18790\n');
    await run(['--enable', '--no-gateway']);
    expect(envValue('NANOCLAW_OPENSHELL_GATEWAY_PORTS')).toBe(envValue('NANOCLAW_OPENSHELL_MODEL_RELAY_PORT'));
    expect(envValue('NANOCLAW_OPENSHELL_GATEWAY_PORTS')).not.toBe('18790');
  });

  it('derives the :openshell image right away when the base image already exists', async () => {
    docker.hasBase = true;
    await run(['--enable', '--no-gateway']);
    expect(docker.builds).toHaveLength(1);
    expect(docker.builds[0]).toMatch(/^FROM nanoclaw-agent-v2-[0-9a-f]{8}:latest\n[\s\S]*WORKDIR \/sandbox/);
  });

  it('without a base image, leaves derivation to the container step (no failure)', async () => {
    await run(['--enable', '--no-gateway']);
    expect(docker.builds).toEqual([]);
    expect(envValue('NANOCLAW_RUNTIME_DRIVER')).toBe('openshell');
  });

  it('--no-gateway leaves the gateway to the caller', async () => {
    await run(['--enable', '--no-gateway']);
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
