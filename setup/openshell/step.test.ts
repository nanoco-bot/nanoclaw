import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installGateway = vi.hoisted(() => vi.fn(async (kind: string) => ({ kind, label: kind })));
vi.mock('../gateways/install.js', () => ({ installGateway }));
vi.mock('../../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// No Docker here: a fake runner that reports "no base image" unless a test says otherwise.
const docker = vi.hoisted(() => ({ hasBase: false, builds: [] as string[] }));
vi.mock('./image.js', async (original) => {
  const real = await original<typeof import('./image.js')>();
  const fake: import('./image.js').DockerRunner = (args, input) => {
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
// OpenShell itself (install + runtime checks) is setup/openshell/install-step.ts's, tested there.
const install = vi.hoisted(() => ({
  support: { ok: true } as { ok: true } | { ok: false; reason: string },
  outcome: undefined as unknown,
  calls: 0,
}));
vi.mock('./install-step.js', async (original) => {
  const real = await original<typeof import('./install-step.js')>();
  return {
    ...real,
    hostSupport: () => install.support,
    installOpenShell: async () => {
      install.calls++;
      return (
        install.outcome ?? {
          ok: true,
          cli: 'installed',
          version: 'openshell 0.1.2',
          bin: '/usr/bin/openshell',
          binWritten: true,
          runtime: {
            ok: true,
            gatewayVersion: '0.1.2',
            server: 'https://127.0.0.1:17670',
            supervisorImageRef: 'ghcr.io/nvidia/openshell/supervisor:0.1.2',
            supervisorImage: 'pulled',
            mounts: 'ok',
            warnings: [],
          },
        }
      );
    },
  };
});
import { OPENSHELL_POLICY_DEFAULTS, parseOpenShellArgs, planOpenShellEnv, run } from './step.js';

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
  install.support = { ok: true };
  install.outcome = undefined;
  install.calls = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
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
  it('parses enable/disable, bin, gateway, --no-gateway and --no-install', () => {
    expect(parseOpenShellArgs(['--enable', '--bin', '/b', '--gateway', 'g', '--no-gateway', '--no-install'])).toEqual({
      enable: true,
      bin: '/b',
      gateway: 'g',
      installGateway: false,
      installOpenShell: false,
    });
    expect(parseOpenShellArgs([])).toEqual({ installGateway: true, installOpenShell: true });
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

  it('--enable writes the driver settings and installs the gateway', async () => {
    await run(['--enable', '--bin', '/opt/openshell/bin/openshell']);
    expect(envValue('NANOCLAW_RUNTIME_DRIVER')).toBe('openshell');
    expect(envValue('OPENSHELL_BIN')).toBe('/opt/openshell/bin/openshell');
    expect(installGateway).toHaveBeenCalledWith('openshell');
  });

  it('removes the former model relay settings from .env', async () => {
    fs.writeFileSync(
      envFile(),
      'KEEP=1\nNANOCLAW_OPENSHELL_MODEL_RELAY_PORT=23456\nNANOCLAW_OPENSHELL_GATEWAY_PORTS=23456\nNANOCLAW_OPENSHELL_GATEWAY_HOST=h\n',
    );
    await run(['--enable', '--no-gateway']);
    expect(readEnv()).not.toMatch(/MODEL_RELAY_PORT|GATEWAY_PORTS|GATEWAY_HOST/);
    expect(envValue('KEEP')).toBe('1');
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

  it('--enable installs OpenShell first and records the CLI it installed', async () => {
    const out: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void out.push(line));
    await run(['--enable', '--no-gateway']);
    expect(install.calls).toBe(1);
    expect(envValue('OPENSHELL_BIN')).toBe('/usr/bin/openshell');
    const block = out.find((l) => l.startsWith('=== NANOCLAW SETUP: OPENSHELL ===')) ?? '';
    expect(block).toMatch(/^INSTALL: done$/m);
    expect(block).toMatch(/^INSTALL_SUPERVISOR_IMAGE_STATUS: pulled$/m);
  });

  it('--no-install (the wizard: it installs after the container step) skips the install', async () => {
    const out: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void out.push(line));
    await run(['--enable', '--no-gateway', '--no-install']);
    expect(install.calls).toBe(0);
    expect(envValue('NANOCLAW_RUNTIME_DRIVER')).toBe('openshell');
    expect(out.join('\n')).toMatch(/^INSTALL: skipped$/m);
  });

  it('a failed install writes nothing and installs no gateway', async () => {
    install.outcome = { ok: false, error: 'gateway_config', message: 'refuses mounts', hint: 'add\nthese' };
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const out: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void out.push(line));
    await expect(run(['--enable'])).rejects.toThrow('exit:1');
    expect(readEnv()).toBe('');
    expect(installGateway).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/^ERROR: gateway_config$/m);
    expect(out.join('\n')).toMatch(/^HINT: add these$/m);
  });

  it('an unsupported machine (Intel Mac) is refused before anything is installed or written', async () => {
    install.support = { ok: false, reason: "OpenShell doesn't support Intel Macs." };
    vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit);
    const out: string[] = [];
    vi.mocked(console.log).mockImplementation((line: string) => void out.push(line));
    await expect(run(['--enable', '--no-install'])).rejects.toThrow('exit:1');
    expect(install.calls).toBe(0);
    expect(readEnv()).toBe('');
    expect(out.join('\n')).toMatch(/^ERROR: unsupported_platform$/m);
    expect(out.join('\n')).toMatch(/Intel Macs.*NANOCLAW_OPENSHELL=false/);
  });

  it('--disable still works on an unsupported machine', async () => {
    install.support = { ok: false, reason: 'no' };
    fs.writeFileSync(envFile(), 'NANOCLAW_RUNTIME_DRIVER=openshell\n');
    await run(['--disable']);
    expect(readEnv()).toBe('');
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
