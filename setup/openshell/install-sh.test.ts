/**
 * setup/openshell/install.sh, run for real under bash with a PATH of fakes:
 * `curl` serves a stand-in for NVIDIA's installer, so nothing is downloaded and
 * the real OpenShell (if this machine has one) is never seen.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { StatusStream } from '../lib/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, 'install.sh');
const PIN = (
  JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'versions.json'), 'utf8')) as Record<string, string>
).openshell;

/** Real tools the script (and the fake installer) use, linked into the fake PATH. */
const TOOLS = ['bash', 'tr', 'grep', 'sed', 'head', 'cat', 'dirname', 'chmod'];

let tmp: string;
let bin: string;
let logs: { curl: string; installer: string };

function which(tool: string): string {
  const r = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
  const found = r.stdout.trim();
  if (!found) throw new Error(`test needs ${tool}`);
  return found;
}

function fake(name: string, body: string): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

/** NVIDIA's installer, as far as this script can tell: it puts `openshell` on PATH (or fails). */
function installerWill(outcome: 'install' | 'fail' | 'install-nothing'): void {
  const installer = path.join(tmp, 'installer.sh');
  const lines = [
    `echo "OPENSHELL_VERSION=$OPENSHELL_VERSION TIMEOUT=$OPENSHELL_INSTALL_GATEWAY_TIMEOUT" >> "${logs.installer}"`,
    'echo "openshell: installing (fake)"',
  ];
  if (outcome === 'fail') lines.push('echo "openshell: error: something broke" >&2', 'exit 1');
  if (outcome === 'install') {
    lines.push(`printf '#!/bin/sh\\necho "openshell 0.1.2"\\n' > "${bin}/openshell"`, `chmod 755 "${bin}/openshell"`);
  }
  fs.writeFileSync(installer, lines.join('\n') + '\n');
  fake('curl', `echo "$@" >> "${logs.curl}"\ncat "${installer}"`);
}

function host(opts: { os?: string; arch?: string; uid?: number; sudo?: boolean; brew?: boolean } = {}): void {
  fake('uname', `case "$1" in -s) echo ${opts.os ?? 'Linux'};; -m) echo ${opts.arch ?? 'x86_64'};; esac`);
  fake('id', `[ "$1" = "-u" ] && echo ${opts.uid ?? 0}`);
  fake('sudo', opts.sudo === false ? 'exit 1' : 'exit 0');
  if (opts.brew) fake('brew', `[ "$1" = "--prefix" ] && echo "${tmp}/brew"; exit 0`);
}

function runScript(env: Record<string, string> = {}, script = SCRIPT) {
  const r = spawnSync(path.join(bin, 'bash'), [script], {
    encoding: 'utf8',
    env: { PATH: bin, HOME: tmp, ...env },
  });
  const blocks = new StatusStream(() => {});
  blocks.write(r.stdout);
  const block = blocks.blocks.find((b) => b.type === 'INSTALL_OPENSHELL');
  const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    code: r.status,
    stdout: r.stdout,
    fields: block?.fields ?? {},
    curl: read(logs.curl),
    installer: read(logs.installer),
  };
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'install-openshell-'));
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  for (const tool of TOOLS) fs.symlinkSync(which(tool), path.join(bin, tool));
  logs = { curl: path.join(tmp, 'curl.log'), installer: path.join(tmp, 'installer.log') };
  host();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('setup/openshell/install.sh', () => {
  it('pins a release in versions.json', () => {
    expect(PIN).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('is a no-op when openshell is already on PATH: already-installed, nothing downloaded', () => {
    fake('openshell', 'echo "openshell 0.1.2"');
    installerWill('install');
    const r = runScript();
    expect(r.code).toBe(0);
    expect(r.stdout.split('\n')[0]).toBe('=== NANOCLAW SETUP: INSTALL_OPENSHELL ===');
    expect(r.fields).toEqual({
      STATUS: 'already-installed',
      OPENSHELL_VERSION: 'openshell 0.1.2',
      OPENSHELL_BIN: path.join(bin, 'openshell'),
    });
    expect(r.curl).toBe('');
  });

  it('refuses an install older than the pin (an early pip/uv CLI) and says how to remove it; nothing downloaded', () => {
    fake('openshell', 'echo "openshell 0.0.68"');
    installerWill('install');
    const r = runScript();
    expect(r.code).toBe(1);
    expect(r.fields.STATUS).toBe('failed');
    expect(r.fields.OPENSHELL_VERSION).toBe('openshell 0.0.68');
    expect(r.fields.ERROR).toContain(`is older than ${PIN}`);
    expect(r.fields.ERROR).toContain('uv tool uninstall openshell');
    expect(r.curl).toBe('');
  });

  it('accepts an install newer than the pin, with a NOTE', () => {
    fake('openshell', 'echo "openshell 99.0.0"');
    const r = runScript();
    expect(r.code).toBe(0);
    expect(r.fields.STATUS).toBe('already-installed');
    expect(r.stdout).toContain(`newer than the pinned ${PIN}`);
  });

  it('OPENSHELL_VERSION=dev skips the version check', () => {
    fake('openshell', 'echo "openshell 0.0.68"');
    const r = runScript({ OPENSHELL_VERSION: 'dev' });
    expect(r.code).toBe(0);
    expect(r.fields.STATUS).toBe('already-installed');
  });

  it('installs the versions.json pin with NVIDIA’s installer from that release tag', () => {
    installerWill('install');
    const r = runScript();
    expect(r.code).toBe(0);
    expect(r.curl.trim()).toBe(`-fsSL https://raw.githubusercontent.com/NVIDIA/OpenShell/${PIN}/install.sh`);
    // The gateway pulls its images before it listens: a longer wait than the installer's 30s.
    expect(r.installer.trim()).toBe(`OPENSHELL_VERSION=${PIN} TIMEOUT=180`);
    expect(r.fields.STATUS).toBe('installed');
    expect(r.fields.OPENSHELL_VERSION).toBe('openshell 0.1.2');
    expect(r.fields.OPENSHELL_BIN).toBe(path.join(bin, 'openshell'));
  });

  it('passes OPENSHELL_VERSION (and a custom gateway timeout) straight through', () => {
    installerWill('install');
    const r = runScript({ OPENSHELL_VERSION: 'v0.1.1', OPENSHELL_INSTALL_GATEWAY_TIMEOUT: '45' });
    expect(r.curl).toContain('/NVIDIA/OpenShell/v0.1.1/install.sh');
    expect(r.installer.trim()).toBe('OPENSHELL_VERSION=v0.1.1 TIMEOUT=45');
    expect(r.fields.STATUS).toBe('installed');
  });

  it('OPENSHELL_VERSION=dev has no release tag: the installer comes from main', () => {
    installerWill('install');
    const r = runScript({ OPENSHELL_VERSION: 'dev' });
    expect(r.curl).toContain('/NVIDIA/OpenShell/main/install.sh');
    expect(r.installer).toContain('OPENSHELL_VERSION=dev ');
  });

  it('reports the installer failing as failed, with an ERROR line', () => {
    installerWill('fail');
    const r = runScript();
    expect(r.code).toBe(1);
    expect(r.fields.STATUS).toBe('failed');
    expect(r.fields.ERROR).toMatch(/installer failed/);
  });

  it('fails when the installer exits 0 but leaves no openshell on PATH', () => {
    installerWill('install-nothing');
    const r = runScript();
    expect(r.code).toBe(1);
    expect(r.fields).toMatchObject({ STATUS: 'failed', ERROR: 'openshell not found on PATH after install.' });
  });

  it('refuses an Intel Mac before downloading anything', () => {
    host({ os: 'Darwin', arch: 'x86_64', brew: true });
    installerWill('install');
    const r = runScript();
    expect(r.code).toBe(1);
    expect(r.fields.STATUS).toBe('failed');
    expect(r.fields.ERROR).toMatch(/does not support Intel Macs/);
    expect(r.curl).toBe('');
  });

  it('needs Homebrew on an Apple silicon Mac', () => {
    host({ os: 'Darwin', arch: 'arm64' });
    installerWill('install');
    const r = runScript();
    expect(r.fields.STATUS).toBe('failed');
    expect(r.fields.ERROR).toMatch(/Homebrew is required/);
    expect(r.curl).toBe('');
  });

  it('installs on an Apple silicon Mac with Homebrew', () => {
    host({ os: 'Darwin', arch: 'arm64', brew: true });
    installerWill('install');
    expect(runScript().fields.STATUS).toBe('installed');
  });

  it('on Linux without root, needs passwordless sudo (it never prompts)', () => {
    host({ uid: 1000, sudo: false });
    installerWill('install');
    const r = runScript();
    expect(r.code).toBe(1);
    expect(r.fields.ERROR).toMatch(/root or passwordless sudo/);
    expect(r.curl).toBe('');
  });

  it('on Linux without root but with passwordless sudo, installs', () => {
    host({ uid: 1000, sudo: true });
    installerWill('install');
    expect(runScript().fields.STATUS).toBe('installed');
  });

  it('fails clearly when versions.json has no pin and OPENSHELL_VERSION is unset', () => {
    const copy = path.join(tmp, 'tree');
    fs.mkdirSync(path.join(copy, 'setup', 'openshell'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(copy, 'setup', 'openshell', 'install.sh'));
    fs.writeFileSync(path.join(copy, 'versions.json'), '{\n  "agent-image": "x@sha256:0"\n}\n');
    installerWill('install');
    const r = runScript({}, path.join(copy, 'setup', 'openshell', 'install.sh'));
    expect(r.fields.STATUS).toBe('failed');
    expect(r.fields.ERROR).toMatch(/no "openshell" pin/);
    expect(r.curl).toBe('');
  });
});
