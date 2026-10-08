/**
 * Step: openshell-install — install NVIDIA OpenShell on this machine and check
 * it can run NanoClaw's sandboxes.
 *
 *   pnpm exec tsx setup/index.ts --step openshell-install
 *
 *   1. Refuses a host OpenShell is not published for (an Intel Mac) before
 *      touching anything.
 *   2. Runs setup/openshell/install.sh: NVIDIA's installer at the versions.json
 *      pin, which installs the CLI and starts OpenShell's local gateway — or
 *      does nothing when `openshell` is already on PATH.
 *   3. ensureOpenShellRuntime (setup/openshell/runtime.ts): the gateway
 *      answers, its supervisor image is in Docker (pulled if not), and it
 *      accepts NanoClaw's sandbox mounts.
 *   4. Records OPENSHELL_BIN in `.env` as an absolute path when it is unset or
 *      unusable: the background service has a fixed PATH.
 *
 * Which gateway is which. This step installs OpenShell's OWN gateway — its
 * control plane (`openshell-gateway`, 127.0.0.1:17670), which creates and
 * polices the sandboxes. NanoClaw's "openshell" gateway is something else: the
 * add-openshell credential gateway, applied by the setup
 * wizard's gateway step (`installGateway('openshell')`). Neither installs the
 * other, so nothing is installed twice.
 *
 * The setup wizard runs this after the container step (OpenShell's gateway
 * needs Docker, which that step installs) and before the gateway step.
 * `setup --step openshell -- --enable` runs the same install first unless
 * given `--no-install`.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../src/env.js';
import { log } from '../../src/log.js';
import { StatusStream } from '../lib/runner.js';
import {
  ensureOpenShellRuntime,
  openShellHostSupport,
  SUPERVISOR_IMAGE_KEY,
  type EnsureOptions,
  type EnsureResult,
  type HostSupport,
} from './runtime.js';
import { resolveBinary } from './resolve-binary.js';
import { getPlatform } from '../platform.js';
import { upsertEnvVar } from '../set-env.js';
import { emitStatus } from '../status.js';

export const INSTALL_SCRIPT = path.join('setup', 'openshell', 'install.sh');

/** The `.env` keys this step reads; process.env wins, as in src/drivers/openshell/config.ts. */
const KEYS = ['OPENSHELL_BIN', 'OPENSHELL_GATEWAY', 'OPENSHELL_GATEWAY_ENDPOINT', SUPERVISOR_IMAGE_KEY];

function settings(projectRoot: string): Record<string, string | undefined> {
  const fromFile = readEnvFile(KEYS, projectRoot);
  const out: Record<string, string | undefined> = {};
  for (const key of KEYS) out[key] = process.env[key]?.trim() || fromFile[key]?.trim() || undefined;
  return out;
}

export interface ScriptResult {
  code: number;
  /** The script's INSTALL_OPENSHELL status block. */
  fields: Record<string, string>;
}

/** Run the install script, passing its output through (the wizard tails it) and parsing its block. */
export function runInstallScript(projectRoot: string): Promise<ScriptResult> {
  return new Promise((resolve) => {
    const child = spawn('bash', [path.join(projectRoot, INSTALL_SCRIPT)], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stream = new StatusStream(() => {});
    child.stdout.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      stream.write(chunk.toString('utf-8'));
    });
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('error', (err) => resolve({ code: 127, fields: { STATUS: 'failed', ERROR: err.message } }));
    child.on('close', (code) => {
      const block = [...stream.blocks].reverse().find((b) => b.type === 'INSTALL_OPENSHELL');
      resolve({ code: code ?? 1, fields: block?.fields ?? {} });
    });
  });
}

export interface InstallDeps {
  host?: { platform: string; arch: string; appleSilicon?: boolean };
  runScript?: (projectRoot: string) => Promise<ScriptResult>;
  ensure?: (opts: EnsureOptions) => Promise<EnsureResult>;
  isExecutable?: (bin: string) => boolean;
  say?: (line: string) => void;
}

/** os.arch() of this Node process: `x64` under Rosetta. */
function getArch(): string {
  return os.arch();
}

/** Apple silicon hardware, even when this Node runs under Rosetta. */
function isAppleSilicon(): boolean {
  if (os.platform() !== 'darwin') return false;
  try {
    return (
      execSync('sysctl -n hw.optional.arm64', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === '1'
    );
  } catch {
    return false;
  }
}

/** This machine, as openShellHostSupport needs it. */
export function currentHost(): { platform: string; arch: string; appleSilicon: boolean } {
  return { platform: getPlatform(), arch: getArch(), appleSilicon: isAppleSilicon() };
}

/** Can this machine run OpenShell at all? Checked before anything is installed or written. */
export function hostSupport(
  host: { platform: string; arch: string; appleSilicon?: boolean } = currentHost(),
): HostSupport {
  return openShellHostSupport(host);
}

/** The refusal every entry point shows, so an Intel Mac reads the same everywhere. */
export function unsupportedHostHint(reason: string): string {
  return `${reason} Re-run setup without OpenShell (NANOCLAW_OPENSHELL=false) to use Docker sandboxing.`;
}

export type InstallOutcome =
  | {
      ok: true;
      cli: 'installed' | 'already-installed';
      version: string;
      bin: string;
      /** OPENSHELL_BIN was (re)written to `.env`. */
      binWritten: boolean;
      runtime: Extract<EnsureResult, { ok: true }>;
    }
  | { ok: false; error: string; message: string; hint: string };

export async function installOpenShell(projectRoot = process.cwd(), deps: InstallDeps = {}): Promise<InstallOutcome> {
  const host = deps.host ?? currentHost();
  const say = deps.say ?? ((line: string) => console.log(line));
  const support = hostSupport(host);
  if (!support.ok) {
    return {
      ok: false,
      error: 'unsupported_platform',
      message: "OpenShell sandboxing isn't available on this machine.",
      hint: unsupportedHostHint(support.reason),
    };
  }

  const script = await (deps.runScript ?? runInstallScript)(projectRoot);
  const status = script.fields.STATUS;
  if (script.code !== 0 || (status !== 'installed' && status !== 'already-installed')) {
    return {
      ok: false,
      error: 'install_failed',
      message: "Couldn't install OpenShell.",
      hint: script.fields.ERROR || 'See logs/setup-steps/ for the installer output.',
    };
  }

  // Keep an operator's working OPENSHELL_BIN; otherwise record what the script found.
  const isExecutable = deps.isExecutable ?? ((bin: string) => resolveBinary(bin) !== undefined);
  const current = settings(projectRoot);
  const configured = current.OPENSHELL_BIN;
  const found = script.fields.OPENSHELL_BIN || resolveBinary('openshell') || '';
  let bin = configured && path.isAbsolute(configured) && isExecutable(configured) ? configured : found;
  let binWritten = false;
  if (!bin) bin = configured || 'openshell';
  else if (bin !== configured && path.isAbsolute(bin)) {
    upsertEnvVar('OPENSHELL_BIN', bin, projectRoot);
    binWritten = true;
    log.info('Recorded the openshell CLI path', { OPENSHELL_BIN: bin });
  }

  const env: NodeJS.ProcessEnv = {};
  if (current.OPENSHELL_GATEWAY) env.OPENSHELL_GATEWAY = current.OPENSHELL_GATEWAY;
  if (current.OPENSHELL_GATEWAY_ENDPOINT) env.OPENSHELL_GATEWAY_ENDPOINT = current.OPENSHELL_GATEWAY_ENDPOINT;
  const runtime = await (deps.ensure ?? ensureOpenShellRuntime)({
    bin,
    env,
    platform: host.platform,
    hostDir: fs.existsSync(projectRoot) ? projectRoot : process.cwd(),
    supervisorOverride: current[SUPERVISOR_IMAGE_KEY],
    log: say,
  });
  if (!runtime.ok) return { ok: false, error: runtime.error, message: runtime.message, hint: runtime.hint };
  return {
    ok: true,
    cli: status,
    version: script.fields.OPENSHELL_VERSION || 'unknown',
    bin,
    binWritten,
    runtime,
  };
}

/** Status fields for a finished install, shared with `--step openshell`. */
export function installStatusFields(outcome: Extract<InstallOutcome, { ok: true }>): Record<string, string | number> {
  return {
    CLI: outcome.cli,
    OPENSHELL_VERSION: outcome.version,
    OPENSHELL_BIN: outcome.bin,
    GATEWAY: 'connected',
    GATEWAY_VERSION: outcome.runtime.gatewayVersion,
    SUPERVISOR_IMAGE: outcome.runtime.supervisorImageRef,
    SUPERVISOR_IMAGE_STATUS: outcome.runtime.supervisorImage,
    GATEWAY_MOUNTS: outcome.runtime.mounts,
    // Present only when setup created ~/.config/openshell/gateway.toml itself (none existed).
    ...(outcome.runtime.gatewayConfigCreated ? { GATEWAY_CONFIG_CREATED: outcome.runtime.gatewayConfigCreated } : {}),
    WARNINGS: outcome.runtime.warnings.length,
  };
}

/** One line: emitStatus values must not span lines; the full hint is printed above the block. */
export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

export async function run(args: string[]): Promise<void> {
  if (args.length > 0) throw new Error(`Unknown argument: ${args[0]}`);
  const outcome = await installOpenShell();
  if (!outcome.ok) {
    console.error(`\n${outcome.message}\n${outcome.hint}\n`);
    emitStatus('OPENSHELL_INSTALL', {
      STATUS: 'failed',
      ERROR: outcome.error,
      MESSAGE: outcome.message,
      HINT: oneLine(outcome.hint),
    });
    process.exit(1);
  }
  for (const warning of outcome.runtime.warnings) log.warn(warning);
  emitStatus('OPENSHELL_INSTALL', { STATUS: 'success', ...installStatusFields(outcome) });
}
