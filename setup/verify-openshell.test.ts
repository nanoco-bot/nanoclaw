/**
 * verify on an OpenShell copy: the gateway answers and the supervisor image it
 * pins every sandbox to is still in Docker. Every other copy is untouched.
 * The checks themselves (inspectOpenShellRuntime) are tested in
 * lib/openshell-runtime.test.ts; this covers what verify does with them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeReport } from './lib/openshell-runtime.js';

const host = vi.hoisted(() => ({
  root: '',
  env: {} as Record<string, string>,
  report: undefined as unknown,
  inspect: vi.fn(),
}));
// No service manager answers; the nohup pid file says "running" (see verify-nohup.test.ts).
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    if (command.startsWith('systemctl')) throw new Error('Failed to connect to bus');
    if (command.startsWith('ps ')) return `node ${host.root}/dist/index.js`;
    return '';
  }),
}));
vi.mock('../src/install-slug.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/install-slug.js')>()),
  getLaunchdLabel: () => 'dev.nanoclaw',
  getSystemdUnit: () => 'nanoclaw.service',
}));
vi.mock('../src/env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.filter((k) => k in host.env).map((k) => [k, host.env[k]])),
}));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  hasSystemd: () => true,
}));
vi.mock('./central-db-inspection.js', () => ({
  inspectCentralDb: async () => ({ registeredGroups: 1, derivedGroups: 0 }),
}));
vi.mock('./lib/registry-state.js', () => ({
  readImageSource: () => 'local',
  inspectAgentImage: () => ({ source: 'local', registryDigest: null }),
}));
vi.mock('./lib/openshell-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/openshell-runtime.js')>()),
  inspectOpenShellRuntime: (opts: unknown) => {
    host.inspect(opts);
    return host.report;
  },
}));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { emitStatus } from './status.js';
import { checkOpenShellRuntime, determineVerifyStatus, run } from './verify.js';

const PRESENT: RuntimeReport = {
  gateway: 'connected',
  gatewayVersion: '0.1.2',
  supervisorImageRef: 'ghcr.io/nvidia/openshell/supervisor:0.1.2',
  supervisorImage: 'present',
};

beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-verify-openshell-'));
  host.env = {};
  host.report = PRESENT;
  host.inspect.mockClear();
  fs.mkdirSync(path.join(host.root, 'data'));
  fs.writeFileSync(path.join(host.root, '.env'), 'ANTHROPIC_API_KEY=fixture-only\n');
  fs.writeFileSync(path.join(host.root, 'nanoclaw.pid'), `${process.pid}\n`);
  vi.spyOn(process, 'cwd').mockReturnValue(host.root);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('verify_exit');
  });
  vi.mocked(emitStatus).mockClear();
  for (const key of ['NANOCLAW_RUNTIME_DRIVER', 'OPENSHELL_BIN', 'OPENSHELL_GATEWAY', 'OPENSHELL_SUPERVISOR_IMAGE'])
    vi.stubEnv(key, '');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(host.root, { recursive: true, force: true });
});

const fields = () => vi.mocked(emitStatus).mock.calls.at(-1)?.[1] as Record<string, unknown>;

describe('checkOpenShellRuntime', () => {
  it('a copy without the openshell driver is not touched (null, nothing run)', () => {
    expect(checkOpenShellRuntime(host.root)).toBeNull();
    host.env = { NANOCLAW_RUNTIME_DRIVER: 'docker' };
    expect(checkOpenShellRuntime(host.root)).toBeNull();
    expect(host.inspect).not.toHaveBeenCalled();
  });

  it('an OpenShell copy is inspected with its CLI, gateway selection and supervisor override', () => {
    host.env = {
      NANOCLAW_RUNTIME_DRIVER: 'openshell',
      OPENSHELL_BIN: '/usr/bin/openshell',
      OPENSHELL_GATEWAY: 'lab',
      OPENSHELL_SUPERVISOR_IMAGE: 'registry.local/sup:1',
    };
    expect(checkOpenShellRuntime(host.root)).toEqual(PRESENT);
    expect(host.inspect).toHaveBeenCalledWith({
      bin: '/usr/bin/openshell',
      env: { OPENSHELL_GATEWAY: 'lab' },
      supervisorOverride: 'registry.local/sup:1',
    });
  });

  it('process.env wins over .env, as for the host', () => {
    host.env = { NANOCLAW_RUNTIME_DRIVER: 'openshell', OPENSHELL_BIN: '/from/file' };
    vi.stubEnv('OPENSHELL_BIN', '/from/env');
    checkOpenShellRuntime(host.root);
    expect(host.inspect).toHaveBeenCalledWith(expect.objectContaining({ bin: '/from/env' }));
  });
});

describe('determineVerifyStatus with OpenShell', () => {
  const healthy = { service: 'running' as const, credentials: 'configured', registeredGroups: 1 };
  it.each([
    [{ gateway: 'connected', supervisorImage: 'present' }, 'success'],
    [{ gateway: 'connected', supervisorImage: 'remote' }, 'success'],
    // Docker could not be asked: reported, not a failure (as with the agent image fields).
    [{ gateway: 'connected', supervisorImage: 'unknown' }, 'success'],
    [{ gateway: 'connected', supervisorImage: 'missing' }, 'failed'],
    [{ gateway: 'unreachable', supervisorImage: 'unknown' }, 'failed'],
    [{ gateway: 'not_configured', supervisorImage: 'unknown' }, 'failed'],
    [{ gateway: 'cli_missing', supervisorImage: 'unknown' }, 'failed'],
  ] as const)('%o → %s', (openshell, expected) => {
    expect(determineVerifyStatus({ ...healthy, openshell })).toBe(expected);
  });
  it('no OpenShell report (every other copy) changes nothing', () => {
    expect(determineVerifyStatus({ ...healthy, openshell: null })).toBe('success');
    expect(determineVerifyStatus(healthy)).toBe('success');
  });
});

describe('verify run() on an OpenShell copy', () => {
  it('reports the gateway and supervisor image; healthy is success', async () => {
    host.env = { NANOCLAW_RUNTIME_DRIVER: 'openshell' };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({
      OPENSHELL_GATEWAY: 'connected',
      OPENSHELL_SUPERVISOR_IMAGE: 'present',
      OPENSHELL_SUPERVISOR_IMAGE_REF: 'ghcr.io/nvidia/openshell/supervisor:0.1.2',
      STATUS: 'success',
    });
  });

  it('a pruned supervisor image fails verify', async () => {
    host.env = { NANOCLAW_RUNTIME_DRIVER: 'openshell' };
    host.report = { ...PRESENT, supervisorImage: 'missing' };
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ OPENSHELL_SUPERVISOR_IMAGE: 'missing', STATUS: 'failed' });
  });

  it('a copy without OpenShell emits no OpenShell fields at all', async () => {
    await expect(run([])).resolves.toBeUndefined();
    expect(Object.keys(fields()).filter((k) => k.startsWith('OPENSHELL'))).toEqual([]);
    expect(host.inspect).not.toHaveBeenCalled();
  });
});
