/**
 * The openshell-install step's glue (installOpenShell): host refusal before
 * anything runs, the install script's verdict, OPENSHELL_BIN recorded as an
 * absolute path, and the runtime checks handed the right CLI and gateway.
 * The script and the runtime checks have their own tests
 * (install-openshell.test.ts, lib/openshell-runtime.test.ts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import type { EnsureOptions, EnsureResult } from './lib/openshell-runtime.js';
import { installOpenShell, installStatusFields, oneLine, type ScriptResult } from './openshell-install.js';

const LINUX = { platform: 'linux', arch: 'x64' };
const HEALTHY: EnsureResult = {
  ok: true,
  gatewayVersion: '0.1.2',
  server: 'https://127.0.0.1:17670',
  supervisorImageRef: 'ghcr.io/nvidia/openshell/supervisor:0.1.2',
  supervisorImage: 'present',
  mounts: 'ok',
  warnings: [],
};

let root: string;
const envValue = (key: string) =>
  (fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '').match(
    new RegExp(`^${key}=(.*)$`, 'm'),
  )?.[1];

function deps(script: ScriptResult, ensure: (o: EnsureOptions) => Promise<EnsureResult> = async () => HEALTHY) {
  return {
    host: LINUX,
    runScript: vi.fn(async () => script),
    ensure: vi.fn(ensure),
    isExecutable: (bin: string) => bin.startsWith('/usr/bin/') || bin.startsWith('/opt/custom/'),
    say: () => {},
  };
}

const INSTALLED: ScriptResult = {
  code: 0,
  fields: { STATUS: 'installed', OPENSHELL_VERSION: 'openshell 0.1.2', OPENSHELL_BIN: '/usr/bin/openshell' },
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-install-'));
  vi.stubEnv('OPENSHELL_BIN', '');
  vi.stubEnv('OPENSHELL_GATEWAY', '');
  vi.stubEnv('OPENSHELL_GATEWAY_ENDPOINT', '');
  vi.stubEnv('OPENSHELL_SUPERVISOR_IMAGE', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('installOpenShell', () => {
  it('an Intel Mac is refused before the install script runs', async () => {
    const d = { ...deps(INSTALLED), host: { platform: 'macos', arch: 'x64', appleSilicon: false } };
    const r = await installOpenShell(root, d);
    expect(r).toMatchObject({ ok: false, error: 'unsupported_platform' });
    expect(!r.ok && r.hint).toMatch(/Intel Macs.*NANOCLAW_OPENSHELL=false/s);
    expect(d.runScript).not.toHaveBeenCalled();
    expect(d.ensure).not.toHaveBeenCalled();
  });

  it('installs, records the absolute CLI path, and checks the runtime with it', async () => {
    const d = deps(INSTALLED);
    const r = await installOpenShell(root, d);
    expect(r).toMatchObject({ ok: true, cli: 'installed', version: 'openshell 0.1.2', bin: '/usr/bin/openshell' });
    expect(r.ok && r.binWritten).toBe(true);
    expect(envValue('OPENSHELL_BIN')).toBe('/usr/bin/openshell');
    expect(d.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ bin: '/usr/bin/openshell', platform: 'linux', hostDir: root, env: {} }),
    );
  });

  it('already installed: replaces a bare `openshell` (written before the install) with the absolute path', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'OPENSHELL_BIN=openshell\n');
    const r = await installOpenShell(
      root,
      deps({ code: 0, fields: { ...INSTALLED.fields, STATUS: 'already-installed' } }),
    );
    expect(r).toMatchObject({ ok: true, cli: 'already-installed', bin: '/usr/bin/openshell' });
    expect(envValue('OPENSHELL_BIN')).toBe('/usr/bin/openshell');
  });

  it('keeps an operator’s own working OPENSHELL_BIN', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'OPENSHELL_BIN=/opt/custom/openshell\n');
    const d = deps({ code: 0, fields: { ...INSTALLED.fields, STATUS: 'already-installed' } });
    const r = await installOpenShell(root, d);
    expect(r).toMatchObject({ ok: true, bin: '/opt/custom/openshell', binWritten: false });
    expect(envValue('OPENSHELL_BIN')).toBe('/opt/custom/openshell');
    expect(d.ensure).toHaveBeenCalledWith(expect.objectContaining({ bin: '/opt/custom/openshell' }));
  });

  it('hands the configured gateway selection and supervisor override to the checks', async () => {
    fs.writeFileSync(
      path.join(root, '.env'),
      'OPENSHELL_GATEWAY=lab\nOPENSHELL_SUPERVISOR_IMAGE=registry.local/sup:1\n',
    );
    const d = deps(INSTALLED);
    await installOpenShell(root, d);
    expect(d.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OPENSHELL_GATEWAY: 'lab' }, supervisorOverride: 'registry.local/sup:1' }),
    );
  });

  it('a failed install script is install_failed, with the script’s ERROR as the hint; nothing checked or written', async () => {
    const d = deps({
      code: 1,
      fields: { STATUS: 'failed', ERROR: "OpenShell's installer failed; its output is above." },
    });
    const r = await installOpenShell(root, d);
    expect(r).toEqual({
      ok: false,
      error: 'install_failed',
      message: "Couldn't install OpenShell.",
      hint: "OpenShell's installer failed; its output is above.",
    });
    expect(d.ensure).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
  });

  it('passes a runtime check failure through unchanged', async () => {
    const r = await installOpenShell(
      root,
      deps(INSTALLED, async () => ({
        ok: false,
        error: 'gateway_config',
        message: 'refuses mounts',
        hint: 'add\nthese',
      })),
    );
    expect(r).toEqual({ ok: false, error: 'gateway_config', message: 'refuses mounts', hint: 'add\nthese' });
  });
});

describe('oneLine', () => {
  it('folds a multi-line hint for a status block field', () => {
    expect(oneLine('a\n\n  b\nc ')).toBe('a b c');
  });
});

describe('installStatusFields', () => {
  const outcome = {
    ok: true as const,
    cli: 'installed' as const,
    version: 'openshell 0.1.2',
    bin: '/usr/bin/openshell',
    binWritten: true,
    runtime: HEALTHY as Extract<EnsureResult, { ok: true }>,
  };
  it('no GATEWAY_CONFIG_CREATED unless setup created the gateway config', () => {
    expect(installStatusFields(outcome)).not.toHaveProperty('GATEWAY_CONFIG_CREATED');
    expect(installStatusFields(outcome).WARNINGS).toBe(0);
  });
  it('reports the created file and counts its warning', () => {
    const fields = installStatusFields({
      ...outcome,
      runtime: {
        ...outcome.runtime,
        gatewayConfigCreated: '/home/u/.config/openshell/gateway.toml',
        warnings: ['NanoClaw created /home/u/.config/openshell/gateway.toml …'],
      },
    });
    expect(fields.GATEWAY_CONFIG_CREATED).toBe('/home/u/.config/openshell/gateway.toml');
    expect(fields.WARNINGS).toBe(1);
  });
});
