/**
 * OpenShell runtime checks, shared by the install step
 * (setup/openshell/install-step.ts) and verify (setup/verify.ts). Every process call
 * goes through an injectable `Run`, so all of this is tested without OpenShell
 * or Docker.
 *
 * What these checks rely on, each observed on OpenShell v0.1.2 (the release
 * pinned in versions.json):
 *
 *  - `openshell status -o json` exits 0 with `{"status":"connected",
 *    "version":"0.1.2","server":"https://127.0.0.1:17670",…}` when the gateway
 *    answers, exits 0 with `{"status":"not_configured"}` when no gateway is
 *    registered, and exits non-zero (connection refused) when it is down.
 *  - The Docker compute driver resolves its supervisor image when the gateway
 *    STARTS: `ghcr.io/nvidia/openshell/supervisor:<gateway version>` unless
 *    the gateway config sets `[openshell.drivers.docker] supervisor_image`. It
 *    pulls the image if it is missing, then pins every sandbox to that image's
 *    ID, and only then accepts connections. Remove the image later (an
 *    `image prune -a`) and every sandbox create fails with
 *    `ControlSupervisorStartFailed … No such image` until it is pulled again.
 *    `docker pull` of the same tag restores the same ID, so no gateway
 *    restart is needed. Nothing in the `openshell` CLI pulls or checks the
 *    image; Docker is asked directly.
 *  - NanoClaw's sandboxes carry host bind mounts (`--driver-config-json`,
 *    src/drivers/openshell/policy.ts), which a gateway with default settings
 *    refuses. A create with a deliberately invalid image reference reports the
 *    first missing setting immediately, and with all of them set fails only at
 *    the (local, offline) image-reference check — see `probeGatewayMounts`.
 */
import { spawnSync } from 'child_process';
import { randomBytes } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from '../../src/env.js';
import { getInstallSlug } from '../../src/install-slug.js';
import { OPENSHELL_ENV_KEYS, openShellGatewayEnv, openShellSettingsEnv } from '../../src/drivers/openshell/config.js';
import {
  MODEL_PROFILE_ID,
  modelProviderName,
  type ModelCredentialKind,
} from '../../src/drivers/openshell/model-provider.js';
import { settingsFromEnv } from '../../src/drivers/openshell/settings.js';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Run = (cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }) => RunResult;

/** spawnSync, colour off, never throws: a missing binary is code 127. */
export const realRun: Run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env, NO_COLOR: '1', OPENSHELL_COLOR: 'never' },
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const missing = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
  return {
    code: missing ? 127 : (r.status ?? 1),
    stdout: r.stdout ?? '',
    stderr: `${r.stderr ?? ''}${r.error ? `${r.stderr ? '\n' : ''}${r.error.message}` : ''}`,
  };
};

// ---------- model credential ----------

/** The kind of Claude credential OpenShell holds for this install, or null when it holds none. */
export function storedModelCredential(projectRoot: string, run: Run = realRun): ModelCredentialKind | null {
  const settingsEnv = openShellSettingsEnv(process.env, readEnvFile(OPENSHELL_ENV_KEYS, projectRoot));
  const r = run(settingsFromEnv(settingsEnv).bin, ['provider', 'list', '-o', 'json'], {
    env: openShellGatewayEnv(settingsEnv),
  });
  if (r.code !== 0) return null;
  let providers: { name?: string; type?: string }[] = [];
  try {
    providers = (JSON.parse(r.stdout) as { providers?: typeof providers }).providers ?? [];
  } catch {
    return null;
  }
  const name = modelProviderName(getInstallSlug(projectRoot));
  const type = providers.find((p) => p.name === name)?.type;
  return (Object.keys(MODEL_PROFILE_ID) as ModelCredentialKind[]).find((k) => MODEL_PROFILE_ID[k] === type) ?? null;
}

// ---------- host support ----------

export type HostSupport = { ok: true } | { ok: false; reason: string };

/**
 * Where NVIDIA publishes OpenShell: Linux packages for x86_64 and arm64, and a
 * Homebrew formula for Apple silicon. No Intel macOS build exists, so an Intel
 * Mac cannot run OpenShell sandboxing at all. `platform` is setup/platform.ts's
 * getPlatform(); `arch` is os.arch(); `appleSilicon` tells an Intel Mac from an
 * Apple silicon Mac whose Node runs under Rosetta (os.arch() is x64 on both).
 */
export function openShellHostSupport(host: { platform: string; arch: string; appleSilicon?: boolean }): HostSupport {
  if (host.platform === 'linux') {
    if (host.arch === 'x64' || host.arch === 'arm64') return { ok: true };
    return {
      ok: false,
      reason: `OpenShell is published for x86_64 and arm64 Linux only (this machine: ${host.arch}).`,
    };
  }
  if (host.platform === 'macos') {
    if (host.arch === 'arm64') return { ok: true };
    if (host.appleSilicon) {
      return {
        ok: false,
        reason:
          'This Mac has Apple silicon, but Node is running under Rosetta (x86_64) and OpenShell has no Intel build. ' +
          'Install the arm64 build of Node, then re-run setup.',
      };
    }
    return {
      ok: false,
      reason: "OpenShell doesn't support Intel Macs: NVIDIA publishes it for Apple silicon Macs and Linux only.",
    };
  }
  return { ok: false, reason: `OpenShell runs on Linux and Apple silicon Macs only (this machine: ${host.platform}).` };
}

// ---------- gateway status ----------

export type GatewayStatus =
  | { state: 'connected'; version: string; server: string }
  | { state: 'not_configured' }
  | { state: 'unreachable'; detail: string }
  | { state: 'cli_missing'; detail: string };

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/[│╰─▶×]/g, ' ').trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

export function parseGatewayStatus(r: RunResult): GatewayStatus {
  if (r.code === 127) return { state: 'cli_missing', detail: lastLine(r.stderr) || 'openshell not found' };
  if (r.code !== 0) return { state: 'unreachable', detail: lastLine(r.stderr || r.stdout) };
  let doc: { status?: unknown; version?: unknown; server?: unknown };
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { state: 'unreachable', detail: `unexpected \`openshell status\` output: ${lastLine(r.stdout)}` };
  }
  if (doc.status === 'connected' && typeof doc.version === 'string' && doc.version.trim()) {
    return {
      state: 'connected',
      version: doc.version.trim(),
      server: typeof doc.server === 'string' ? doc.server : '',
    };
  }
  if (doc.status === 'not_configured') return { state: 'not_configured' };
  return { state: 'unreachable', detail: `gateway status: ${String(doc.status)}` };
}

export function readGatewayStatus(bin: string, env: NodeJS.ProcessEnv, run: Run = realRun): GatewayStatus {
  return parseGatewayStatus(run(bin, ['status', '-o', 'json'], { env, timeoutMs: 20_000 }));
}

/**
 * A gateway on this machine, whose supervisor image therefore lives in this
 * machine's Docker. An unparseable or empty server counts as local: that is
 * the only kind setup installs.
 */
export function isLocalGateway(server: string): boolean {
  if (!server.trim()) return true;
  try {
    const host = new URL(server).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return true;
  }
}

/** The gateway's compute drivers from `openshell gateway info -o json`; undefined when it can't be read. */
export function readComputeDrivers(bin: string, env: NodeJS.ProcessEnv, run: Run = realRun): string[] | undefined {
  const r = run(bin, ['gateway', 'info', '-o', 'json'], { env, timeoutMs: 20_000 });
  if (r.code !== 0) return undefined;
  try {
    const doc = JSON.parse(r.stdout) as { compute_drivers?: { name?: unknown }[] };
    if (!Array.isArray(doc.compute_drivers)) return undefined;
    return doc.compute_drivers.map((d) => String(d.name ?? '')).filter(Boolean);
  } catch {
    return undefined;
  }
}

// ---------- supervisor image ----------

export const SUPERVISOR_IMAGE_REPO = 'ghcr.io/nvidia/openshell/supervisor';
/** `.env` key for an operator whose gateway config overrides `supervisor_image`. */
export const SUPERVISOR_IMAGE_KEY = 'OPENSHELL_SUPERVISOR_IMAGE';

/** OpenShell's own default: the repo tagged with the gateway version, `+` → `-` (openshell-core config.rs). */
export function supervisorImageRef(gatewayVersion: string, override?: string): string {
  if (override?.trim()) return override.trim();
  return `${SUPERVISOR_IMAGE_REPO}:${gatewayVersion.trim().replace(/^v/, '').replace(/\+/g, '-')}`;
}

export type ImageState = 'present' | 'missing' | 'unknown';

/** `unknown` = Docker itself could not be asked (daemon down, no CLI). */
export function dockerImageState(ref: string, run: Run = realRun): ImageState {
  const r = run('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], { timeoutMs: 20_000 });
  if (r.code === 0) return 'present';
  if (/no such image|no such object/i.test(`${r.stderr}\n${r.stdout}`)) return 'missing';
  return 'unknown';
}

export interface RuntimeReport {
  gateway: GatewayStatus['state'];
  gatewayVersion?: string;
  /** `remote`: the gateway runs elsewhere, so its image is not this machine's to check. */
  supervisorImage: ImageState | 'remote';
  supervisorImageRef?: string;
}

/** Read-only: what verify reports. Never pulls, starts or changes anything. */
export function inspectOpenShellRuntime(opts: {
  bin: string;
  env: NodeJS.ProcessEnv;
  supervisorOverride?: string;
  run?: Run;
}): RuntimeReport {
  const run = opts.run ?? realRun;
  const status = readGatewayStatus(opts.bin, opts.env, run);
  // Only a connected gateway says which supervisor tag it runs.
  if (status.state !== 'connected') return { gateway: status.state, supervisorImage: 'unknown' };
  const ref = supervisorImageRef(status.version, opts.supervisorOverride);
  const base = { gateway: status.state, gatewayVersion: status.version, supervisorImageRef: ref };
  if (!isLocalGateway(status.server)) return { ...base, supervisorImage: 'remote' };
  return { ...base, supervisorImage: dockerImageState(ref, run) };
}

// ---------- gateway settings NanoClaw's mounts need ----------

export type MountSetting = 'allow_driver_config' | 'enable_bind_mounts' | 'resource_admission';

export type MountProbe =
  | { result: 'ok' }
  | { result: 'missing'; setting: MountSetting; detail: string }
  | { result: 'unknown'; detail: string };

/** Classify the probe create. Messages are the v0.1.2 gateway's, in the order it checks them. */
export function classifyMountProbe(r: RunResult): MountProbe {
  const text = `${r.stderr}\n${r.stdout}`.replace(/[│╰─▶×]/g, ' ').replace(/\s+/g, ' ');
  const detail = text.trim().slice(-300);
  if (/allow_driver_config|caller driver config is disabled/i.test(text))
    return { result: 'missing', setting: 'allow_driver_config', detail };
  if (/enable_bind_mounts|bind mounts? require/i.test(text))
    return { result: 'missing', setting: 'enable_bind_mounts', detail };
  if (/resource admission is enabled|no trusted label resolver/i.test(text))
    return { result: 'missing', setting: 'resource_admission', detail };
  // Past every settings check: the create got as far as the image reference.
  if (r.code === 0 || /ImagePullFailed|invalid reference format|pull access denied|No such image/i.test(text))
    return { result: 'ok' };
  return { result: 'unknown', detail };
}

/** The probe's image: uppercase is an invalid reference, so Docker rejects it locally — no pull, nothing runs. */
export const PROBE_IMAGE = 'nanoclaw-probe/INVALID:x';

/**
 * Ask the gateway whether it accepts a NanoClaw-style sandbox (one read-only
 * host bind mount) without running one. The sandbox record a fully accepted
 * probe leaves behind (phase Error) is deleted.
 */
export function probeGatewayMounts(opts: {
  bin: string;
  env: NodeJS.ProcessEnv;
  /** Any existing host directory; never actually mounted. */
  hostDir: string;
  run?: Run;
  name?: string;
}): MountProbe {
  const run = opts.run ?? realRun;
  // DNS-1123 label within OpenShell's 19-byte sandbox-name limit.
  const name = opts.name ?? `nc-probe-${randomBytes(4).toString('hex')}`;
  const driverConfig = {
    docker: { mounts: [{ type: 'bind', source: opts.hostDir, target: '/nanoclaw-probe', read_only: true }] },
  };
  const r = run(
    opts.bin,
    [
      'sandbox',
      'create',
      '--name',
      name,
      '--from',
      PROBE_IMAGE,
      '--detach',
      '--no-tty',
      '--no-auto-providers',
      '--driver-config-json',
      JSON.stringify(driverConfig),
    ],
    { env: opts.env, timeoutMs: 60_000 },
  );
  const probe = classifyMountProbe(r);
  if (probe.result !== 'missing') run(opts.bin, ['sandbox', 'delete', name], { env: opts.env, timeoutMs: 60_000 });
  return probe;
}

/** The gateway settings NanoClaw's sandboxes need, as gateway.toml lines. */
export const NANOCLAW_GATEWAY_SETTINGS = [
  '[openshell.drivers.docker]',
  'allow_driver_config = true',
  'enable_bind_mounts = true',
  '',
  '[openshell.drivers.docker.resource_admission]',
  'enabled = false',
].join('\n');

export function gatewayRestartCommand(platform: string): string {
  return platform === 'macos'
    ? 'brew services restart nvidia/openshell/openshell'
    : 'systemctl --user restart openshell-gateway';
}

/**
 * The gateway config file the local gateway reads. On macOS the Homebrew
 * service uses its own $(brew --prefix)/var/openshell/gateway.toml while
 * ~/.config/openshell/gateway.toml is absent, so creating the latter would
 * replace the formula's config rather than extend it.
 */
export function gatewayConfigLocation(platform: string): string {
  return platform === 'macos'
    ? '~/.config/openshell/gateway.toml if it exists, otherwise $(brew --prefix)/var/openshell/gateway.toml'
    : '~/.config/openshell/gateway.toml';
}

/** Exactly what to change, for a fail() hint. */
export function gatewayConfigRemedy(platform: string): string {
  return [
    'NanoClaw mounts each session into its sandbox, which needs these OpenShell gateway settings.',
    `Add them to ${gatewayConfigLocation(platform)} (a new file starts with "[openshell]" and "version = 2"):`,
    '',
    NANOCLAW_GATEWAY_SETTINGS,
    '',
    `Then restart the gateway (\`${gatewayRestartCommand(platform)}\`) and re-run setup.`,
    'OpenShell documents host bind mounts as an operator override that weakens its isolation, ' +
      'and resource admission refuses raw bind mounts, so this is a deliberate choice for this machine.',
  ].join('\n');
}

// ---------- first-install gateway config (Linux only) ----------

/** Body of a gateway.toml NanoClaw creates when none exists. */
export const NEW_GATEWAY_TOML = `[openshell]\nversion = 2\n\n${NANOCLAW_GATEWAY_SETTINGS}\n`;

export type GatewayConfigPlan = { create: true; path: string } | { create: false; reason: string };

/**
 * May NanoClaw create the gateway config itself? Only when it would be the
 * very first config the gateway sees, so nothing an operator chose is lost:
 *
 *  - Linux only. The Linux packages' systemd user service reads
 *    ~/.config/openshell/gateway.toml (NVIDIA's installation docs). On macOS
 *    the Homebrew formula's post_install always writes its own
 *    $(brew --prefix)/var/openshell/gateway.toml, and its service script uses
 *    that file only while ~/.config/openshell/gateway.toml is absent — so
 *    creating the ~/.config file there would silently replace an existing
 *    config. macOS keeps the hand-edit instructions.
 *  - No gateway.toml at that path, of any kind (a dangling symlink counts as
 *    existing). An existing file is never opened, read, appended to or replaced.
 *  - The config location is the default one: no OPENSHELL_GATEWAY_CONFIG, no
 *    non-default XDG_CONFIG_HOME, no gateway.env beside it (which the
 *    packages load and which may redirect the config), not a snap install
 *    (which reads /var/snap/openshell/common/gateway.toml).
 *  - The gateway runs on this machine.
 */
export function planGatewayConfigCreate(opts: {
  platform: string;
  bin: string;
  server: string;
  env: NodeJS.ProcessEnv;
  hostEnv: NodeJS.ProcessEnv;
  home: string;
}): GatewayConfigPlan {
  if (opts.platform !== 'linux') {
    return { create: false, reason: 'automatic gateway configuration is Linux-only' };
  }
  if (!isLocalGateway(opts.server)) return { create: false, reason: 'the gateway runs on another machine' };
  if (opts.bin.includes('/snap/')) return { create: false, reason: 'snap installs keep their config elsewhere' };
  if (opts.env.OPENSHELL_GATEWAY_CONFIG?.trim() || opts.hostEnv.OPENSHELL_GATEWAY_CONFIG?.trim()) {
    return { create: false, reason: 'OPENSHELL_GATEWAY_CONFIG points the gateway at its own config' };
  }
  const defaultConfigHome = path.join(opts.home, '.config');
  const xdg = opts.hostEnv.XDG_CONFIG_HOME?.trim();
  if (xdg && path.resolve(xdg) !== path.resolve(defaultConfigHome)) {
    return { create: false, reason: 'XDG_CONFIG_HOME is not the default' };
  }
  const dir = path.join(defaultConfigHome, 'openshell');
  const file = path.join(dir, 'gateway.toml');
  if (pathExists(file)) return { create: false, reason: `${file} already exists` };
  if (pathExists(path.join(dir, 'gateway.env'))) {
    return { create: false, reason: `${path.join(dir, 'gateway.env')} exists and may redirect the config` };
  }
  return { create: true, path: file };
}

/** lstat only: never opens the file, and a dangling symlink still counts. */
function pathExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Create the file exclusively ('wx'): if anything appeared at the path meanwhile, this throws instead of overwriting. */
function createGatewayToml(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, NEW_GATEWAY_TOML, { flag: 'wx', mode: 0o600 });
}

/** How to bring a registered-but-silent local gateway back. */
export function gatewayStartHint(platform: string): string {
  return platform === 'macos'
    ? `Start it with \`${gatewayRestartCommand(platform)}\` (logs: $(brew --prefix)/var/log/openshell/).`
    : `Start it with \`${gatewayRestartCommand(platform)}\` (logs: \`journalctl --user -u openshell-gateway\`).`;
}

/** The installer could not start/register the gateway (e.g. Linux without a systemd user session). */
export function gatewayRegisterHint(platform: string): string {
  return platform === 'macos'
    ? `Run \`${gatewayRestartCommand(platform)}\`, then \`openshell gateway add https://localhost:17670 --local --name openshell\`.`
    : 'OpenShell runs its gateway as a systemd user service. Run `systemctl --user enable --now openshell-gateway`, ' +
        'then `openshell gateway add https://127.0.0.1:17670 --local --name openshell`.';
}

// ---------- the install step's post-install checks ----------

export type EnsureFailure =
  | 'cli_missing'
  | 'gateway_not_registered'
  | 'gateway_unreachable'
  | 'compute_driver'
  | 'docker_unavailable'
  | 'supervisor_image_missing'
  | 'gateway_config';

export type EnsureResult =
  | {
      ok: true;
      gatewayVersion: string;
      server: string;
      supervisorImageRef: string;
      supervisorImage: 'present' | 'pulled' | 'remote';
      mounts: 'ok' | 'unknown';
      warnings: string[];
      /** Set only when NanoClaw created the gateway config itself (none existed): its path. */
      gatewayConfigCreated?: string;
    }
  | { ok: false; error: EnsureFailure; message: string; hint: string };

export interface EnsureOptions {
  bin: string;
  env: NodeJS.ProcessEnv;
  platform: string;
  /** Bind source for the mounts probe (the project root). */
  hostDir: string;
  supervisorOverride?: string;
  run?: Run;
  sleep?: (ms: number) => Promise<void>;
  /** How long a registered gateway may take to answer (it may still be pulling images). */
  waitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
  /** Home directory for the gateway config path (default os.homedir()). */
  home?: string;
  /** Setup's own environment, for OPENSHELL_GATEWAY_CONFIG / XDG_CONFIG_HOME (default process.env). */
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * After the install script: the gateway answers, its supervisor image is in
 * Docker (pulled if not), and it accepts NanoClaw's mounts. Changes nothing
 * but the image pull and, on a Linux gateway with no gateway.toml at all, the
 * creation of that file (see planGatewayConfigCreate) plus a gateway restart.
 * An existing gateway config is the operator's and is never touched.
 */
export async function ensureOpenShellRuntime(opts: EnsureOptions): Promise<EnsureResult> {
  const run = opts.run ?? realRun;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const say = opts.log ?? (() => {});
  const waitMs = opts.waitMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;

  say('Checking that the OpenShell gateway answers…');
  let status = readGatewayStatus(opts.bin, opts.env, run);
  for (let waited = 0; status.state === 'unreachable' && waited < waitMs; waited += pollMs) {
    await sleep(pollMs);
    status = readGatewayStatus(opts.bin, opts.env, run);
  }
  if (status.state === 'cli_missing') {
    return {
      ok: false,
      error: 'cli_missing',
      message: `The openshell CLI could not be run (${opts.bin}).`,
      hint: `${status.detail}. Install OpenShell (setup/openshell/install.sh) or set OPENSHELL_BIN to its absolute path.`,
    };
  }
  if (status.state === 'not_configured') {
    return {
      ok: false,
      error: 'gateway_not_registered',
      message: "OpenShell is installed, but its gateway isn't running or registered.",
      hint: gatewayRegisterHint(opts.platform),
    };
  }
  if (status.state === 'unreachable') {
    return {
      ok: false,
      error: 'gateway_unreachable',
      message: `OpenShell's gateway didn't answer within ${Math.round(waitMs / 1000)}s (${status.detail}).`,
      hint: gatewayStartHint(opts.platform),
    };
  }
  say(`OpenShell gateway ${status.version} is answering at ${status.server || 'its default address'}.`);

  const warnings: string[] = [];
  const drivers = readComputeDrivers(opts.bin, opts.env, run);
  if (drivers && drivers.length > 0 && !drivers.includes('docker')) {
    return {
      ok: false,
      error: 'compute_driver',
      message: `OpenShell's gateway uses the ${drivers.join(', ')} compute driver; NanoClaw's sandboxes need its Docker driver.`,
      hint: `Make sure Docker is running, set \`compute_driver = "docker"\` under [openshell.gateway] in ${gatewayConfigLocation(opts.platform)}, then restart the gateway.`,
    };
  }

  const ref = supervisorImageRef(status.version, opts.supervisorOverride);
  let supervisorImage: 'present' | 'pulled' | 'remote';
  if (!isLocalGateway(status.server)) {
    supervisorImage = 'remote';
    say(`The gateway runs on another machine (${status.server}); its supervisor image is not checked here.`);
  } else {
    const state = dockerImageState(ref, run);
    if (state === 'unknown') {
      return {
        ok: false,
        error: 'docker_unavailable',
        message: "Couldn't ask Docker whether OpenShell's supervisor image is present.",
        hint: 'Make sure Docker is running and usable without sudo, then re-run setup.',
      };
    }
    if (state === 'present') {
      supervisorImage = 'present';
    } else {
      say(`Pulling OpenShell's supervisor image ${ref}…`);
      run('docker', ['pull', ref], { timeoutMs: 15 * 60_000 });
      if (dockerImageState(ref, run) !== 'present') {
        return {
          ok: false,
          error: 'supervisor_image_missing',
          message: `OpenShell's supervisor image ${ref} is missing and couldn't be pulled.`,
          hint: `Check the connection to ghcr.io, then run \`docker pull ${ref}\` and re-run setup.`,
        };
      }
      supervisorImage = 'pulled';
    }
    say(`Supervisor image ${ref}: ${supervisorImage}.`);
  }

  say('Checking that the gateway accepts sandboxes with host mounts…');
  let probe = probeGatewayMounts({ bin: opts.bin, env: opts.env, hostDir: opts.hostDir, run });
  let gatewayConfigCreated: string | undefined;
  let attemptNote = '';
  if (probe.result === 'missing') {
    const plan = planGatewayConfigCreate({
      platform: opts.platform,
      bin: opts.bin,
      server: status.server,
      env: opts.env,
      hostEnv: opts.hostEnv ?? process.env,
      home: opts.home ?? os.homedir(),
    });
    if (plan.create) {
      const restart = gatewayRestartCommand(opts.platform);
      say(`No gateway config exists yet; creating ${plan.path} with the settings NanoClaw's mounts need…`);
      let created = false;
      try {
        createGatewayToml(plan.path);
        created = true;
      } catch (e) {
        attemptNote = ` NanoClaw tried to create ${plan.path} but couldn't (${(e as Error).message}).`;
      }
      if (created) {
        gatewayConfigCreated = plan.path;
        say(`Restarting the gateway (\`${restart}\`)…`);
        const [cmd, ...args] = restart.split(' ');
        const r = run(cmd, args, { timeoutMs: 60_000 });
        if (r.code !== 0) {
          attemptNote = ` NanoClaw created ${plan.path} with these settings, but \`${restart}\` failed (${lastLine(r.stderr || r.stdout) || `exit ${r.code}`}).`;
        } else {
          let after = readGatewayStatus(opts.bin, opts.env, run);
          for (let waited = 0; after.state !== 'connected' && waited < waitMs; waited += pollMs) {
            await sleep(pollMs);
            after = readGatewayStatus(opts.bin, opts.env, run);
          }
          if (after.state !== 'connected') {
            attemptNote = ` NanoClaw created ${plan.path} with these settings and restarted the gateway, but it didn't answer again within ${Math.round(waitMs / 1000)}s.`;
          } else {
            say('Gateway is back; checking the mounts again…');
            probe = probeGatewayMounts({ bin: opts.bin, env: opts.env, hostDir: opts.hostDir, run });
            if (probe.result === 'missing') {
              attemptNote = ` NanoClaw created ${plan.path} with these settings and restarted the gateway, but it still refuses (${probe.setting}).`;
            }
          }
        }
      }
    }
  }
  if (probe.result === 'missing') {
    return {
      ok: false,
      error: 'gateway_config',
      message: `OpenShell's gateway refuses NanoClaw's sandbox mounts (needs ${probe.setting === 'resource_admission' ? 'resource admission off' : `${probe.setting} = true`}).${attemptNote}`,
      hint: gatewayConfigRemedy(opts.platform),
    };
  }
  if (gatewayConfigCreated) {
    warnings.push(
      `NanoClaw created ${gatewayConfigCreated} (no gateway config existed) with the settings its sandbox mounts need ` +
        '(allow_driver_config, enable_bind_mounts, resource admission off) and restarted the gateway ' +
        `(\`${gatewayRestartCommand(opts.platform)}\`). OpenShell documents host bind mounts as an operator override ` +
        'that weakens its isolation; review or remove that file if this machine should not allow them.',
    );
  }
  if (probe.result === 'unknown') {
    warnings.push(`Couldn't confirm the gateway accepts NanoClaw's sandbox mounts: ${probe.detail}`);
  }
  return {
    ok: true,
    gatewayVersion: status.version,
    server: status.server,
    supervisorImageRef: ref,
    supervisorImage,
    mounts: probe.result === 'ok' ? 'ok' : 'unknown',
    warnings,
    ...(gatewayConfigCreated ? { gatewayConfigCreated } : {}),
  };
}
