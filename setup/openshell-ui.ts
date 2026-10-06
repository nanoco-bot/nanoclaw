/**
 * Step: openshell-ui — opt-in operator web UI for an OpenShell-backed install.
 *
 *   pnpm exec tsx setup/index.ts --step openshell-ui                    # asks (TTY), default: no
 *   pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]
 *   pnpm exec tsx setup/index.ts --step openshell-ui -- --disable
 *
 * Unlike every other step, what this installs stays resident: a service
 * running `.claude/skills/add-openshell/scripts/ui/server.ts` under tsx. It is
 * installed the way setup/service.ts installs the NanoClaw service, per
 * platform:
 *   - macOS: a user LaunchAgent (`~/Library/LaunchAgents/<name>.plist`), then
 *     launchctl unload → load → kickstart, verified with `launchctl list`
 *     (setupLaunchd);
 *   - Linux with systemd: a user unit (system unit as root), then
 *     daemon-reload → enable → restart → is-active (setupSystemd).
 * service.ts's third branch, a nohup wrapper for Linux without systemd, is
 * not ported: a resident web UI with no supervisor would not survive a crash
 * or reboot, so the step refuses there and says so.
 *
 * The service name (unit name and launchd label) deliberately does NOT start
 * with `nanoclaw` / `com.nanoclaw`: setup/peer-cleanup.ts treats every other
 * such unit/plist as a peer NanoClaw install and disables ones it judges
 * unhealthy.
 *
 * Declining changes nothing. The server binds 0.0.0.0 (NANOCLAW_OPENSHELL_UI_HOST
 * to change) with no app-level auth: it belongs behind the operator's
 * password-gated reverse proxy, with the port firewalled from everything else.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

import * as p from '@clack/prompts';

import { readEnvFile } from '../src/env.js';
import { getInstallSlug } from '../src/install-slug.js';
import { log } from '../src/log.js';
import { getNodePath, getPlatform, getServiceManager, isRoot } from './platform.js';
import { upsertEnvVar } from './set-env.js';
import { emitStatus } from './status.js';

export const DEFAULT_UI_PORT = 8790;
export const UI_PORT_KEY = 'NANOCLAW_OPENSHELL_UI_PORT';
export const UI_SERVER_RELATIVE = path.join('.claude', 'skills', 'add-openshell', 'scripts', 'ui', 'server.ts');

/** One name for the service on every platform: systemd unit name and launchd label. */
export function uiUnitName(projectRoot: string = process.cwd()): string {
  return `openshell-setup-ui-${getInstallSlug(projectRoot)}`;
}

export interface UiSystemdLocation {
  kind: 'systemd';
  unit: string;
  unitPath: string;
  systemctl: string[];
  root: boolean;
}

export interface UiLaunchdLocation {
  kind: 'launchd';
  label: string;
  plistPath: string;
}

export type UiServiceLocation = UiSystemdLocation | UiLaunchdLocation;

/** setup/service.ts's rule: root installs a system unit, everyone else a user unit. */
export function uiUnitLocation(projectRoot: string, opts: { root?: boolean; home?: string } = {}): UiSystemdLocation {
  const root = opts.root ?? isRoot();
  const unit = uiUnitName(projectRoot);
  const dir = root ? '/etc/systemd/system' : path.join(opts.home ?? os.homedir(), '.config', 'systemd', 'user');
  return {
    kind: 'systemd',
    unit,
    unitPath: path.join(dir, `${unit}.service`),
    systemctl: root ? ['systemctl'] : ['systemctl', '--user'],
    root,
  };
}

/** A user LaunchAgent, like setup/service.ts (it never writes a LaunchDaemon). */
export function uiLaunchdLocation(projectRoot: string, opts: { home?: string } = {}): UiLaunchdLocation {
  const label = uiUnitName(projectRoot);
  return {
    kind: 'launchd',
    label,
    plistPath: path.join(opts.home ?? os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

/**
 * Absolute loader path: the service must not depend on bare-specifier lookup,
 * and node_modules/tsx (a pnpm symlink) survives tsx upgrades.
 */
export function tsxLoaderUrl(projectRoot: string): string {
  return pathToFileURL(path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
}

/** argv the service runs, on every platform: `node --import <tsx loader> <server.ts>`. */
export function uiProgramArguments(projectRoot: string, nodePath: string): string[] {
  return [nodePath, '--import', tsxLoaderUrl(projectRoot), path.join(projectRoot, UI_SERVER_RELATIVE)];
}

export function renderUiUnit(opts: { projectRoot: string; nodePath: string; homeDir: string; root: boolean }): string {
  const { projectRoot, nodePath, homeDir, root } = opts;
  return `[Unit]
Description=NanoClaw OpenShell setup UI
After=network.target

[Service]
Type=simple
ExecStart=${uiProgramArguments(projectRoot, nodePath).join(' ')}
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/openshell-ui.log
StandardError=append:${projectRoot}/logs/openshell-ui.error.log

[Install]
WantedBy=${root ? 'multi-user.target' : 'default.target'}
`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Same shape as setup/service.ts's NanoClaw plist; ProgramArguments are the tsx invocation, one element each. */
export function renderUiPlist(opts: { projectRoot: string; nodePath: string; homeDir: string }): string {
  const { projectRoot, nodePath, homeDir } = opts;
  const label = uiUnitName(projectRoot);
  const args = uiProgramArguments(projectRoot, nodePath)
    .map((a) => `        <string>${xmlEscape(a)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(projectRoot)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xmlEscape(`/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin`)}</string>
        <key>HOME</key>
        <string>${xmlEscape(homeDir)}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${xmlEscape(projectRoot)}/logs/openshell-ui.log</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(projectRoot)}/logs/openshell-ui.error.log</string>
</dict>
</plist>
`;
}

export function parseUiArgs(args: string[]): { enable?: boolean; port?: number } {
  const out: { enable?: boolean; port?: number } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--enable') out.enable = true;
    else if (arg === '--disable') out.enable = false;
    else if (arg === '--port' && args[i + 1] !== undefined) {
      const port = Number(args[++i]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port '${args[i]}' is not a TCP port`);
      out.port = port;
    } else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return out;
}

export function isPortFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/**
 * The explicit --port, else the configured one, else the default. A port held
 * by something else moves to the next free one — unless this install's own UI
 * service is the holder (re-running the step on a live install keeps its port).
 */
export async function chooseUiPort(opts: {
  requested?: number;
  configured?: number;
  ownUnitActive: boolean;
  isFree?: (port: number) => Promise<boolean>;
}): Promise<{ port: number; moved?: number }> {
  const isFree = opts.isFree ?? ((port) => isPortFree(port));
  const want = opts.requested ?? opts.configured ?? DEFAULT_UI_PORT;
  if ((await isFree(want)) || (opts.ownUnitActive && want === opts.configured)) return { port: want };
  if (opts.requested !== undefined) throw new Error(`Port ${want} is already in use`);
  for (let port = want + 1; port < want + 200 && port < 65536; port++) {
    if (await isFree(port)) return { port, moved: want };
  }
  throw new Error(`No free port near ${want} for the OpenShell setup UI`);
}

// ---------------------------------------------------------------------------
// Service-manager seams (injected in tests)
// ---------------------------------------------------------------------------

/** Runs `systemctl [--user] <args>`; throws on a non-zero exit. */
type Systemctl = (args: string[]) => void;
/** Runs `launchctl <args>` and returns stdout; throws on a non-zero exit. */
type Launchctl = (args: string[]) => string;

const realSystemctl =
  (loc: UiSystemdLocation): Systemctl =>
  (args) => {
    const [cmd, ...prefix] = loc.systemctl;
    execFileSync(cmd, [...prefix, ...args], { stdio: 'ignore' });
  };

const realLaunchctl: Launchctl = (args) =>
  execFileSync('launchctl', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

function systemdActive(systemctl: Systemctl, unit: string): boolean {
  try {
    systemctl(['is-active', unit]);
    return true;
  } catch {
    return false;
  }
}

/** service.ts's launchd check: the label appears in `launchctl list`. */
function launchdLoaded(launchctl: Launchctl, label: string): boolean {
  try {
    return launchctl(['list']).includes(label);
  } catch {
    return false;
  }
}

async function waitListening(port: number, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortFree(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export interface UiStepDeps {
  platform?: () => string;
  serviceManager?: () => string;
  systemctl?: Systemctl;
  launchctl?: Launchctl;
  uid?: () => number;
  isFree?: (port: number) => Promise<boolean>;
  waitListening?: (port: number) => Promise<boolean>;
  /** Overrides the computed location (tests); its `kind` must match the platform. */
  loc?: UiServiceLocation;
  home?: string;
  hostname?: () => string;
  nodePath?: () => string;
}

/** Which service manager this host gets, mirroring setup/service.ts's run() branching. */
export function uiServiceKind(deps: UiStepDeps = {}): 'launchd' | 'systemd' {
  const platform = (deps.platform ?? getPlatform)();
  if (platform === 'macos') return 'launchd';
  if (platform === 'linux' && (deps.serviceManager ?? getServiceManager)() === 'systemd') return 'systemd';
  throw new Error(
    'The OpenShell setup UI runs as a supervised service: launchd on macOS or systemd on Linux. ' +
      `This host has neither (platform: ${platform}).`,
  );
}

function resolveLocation(projectRoot: string, kind: 'launchd' | 'systemd', deps: UiStepDeps): UiServiceLocation {
  if (deps.loc) {
    if (deps.loc.kind !== kind) throw new Error(`Location kind ${deps.loc.kind} does not match ${kind}`);
    return deps.loc;
  }
  return kind === 'launchd'
    ? uiLaunchdLocation(projectRoot, { home: deps.home })
    : uiUnitLocation(projectRoot, { home: deps.home });
}

/** Is this install's UI service already running (so its current port counts as "ours")? */
function serviceActive(loc: UiServiceLocation, deps: UiStepDeps): boolean {
  return loc.kind === 'launchd'
    ? launchdLoaded(deps.launchctl ?? realLaunchctl, loc.label)
    : systemdActive(deps.systemctl ?? realSystemctl(loc), loc.unit);
}

/** setup/service.ts setupSystemd's sequence: restart (not start) so an edited unit takes effect. */
function startSystemd(loc: UiSystemdLocation, unit: string, deps: UiStepDeps): boolean {
  const systemctl = deps.systemctl ?? realSystemctl(loc);
  fs.mkdirSync(path.dirname(loc.unitPath), { recursive: true });
  fs.writeFileSync(loc.unitPath, unit);
  log.info('Wrote OpenShell setup UI unit', { unitPath: loc.unitPath });
  for (const args of [['daemon-reload'], ['enable', loc.unit], ['restart', loc.unit]]) {
    try {
      systemctl(args);
    } catch (err) {
      log.error(`systemctl ${args[0]} failed`, { unit: loc.unit, err });
    }
  }
  return systemdActive(systemctl, loc.unit);
}

/**
 * setup/service.ts setupLaunchd's sequence. unload first so launchd drops any
 * cached copy of the plist (a bare `load` of an already-loaded plist keeps the
 * OLD ProgramArguments/WorkingDirectory in memory); kickstart because launchd
 * can leave a freshly loaded RunAtLoad job "pended nondemand spawn" forever.
 */
function startLaunchd(loc: UiLaunchdLocation, plist: string, deps: UiStepDeps): boolean {
  const launchctl = deps.launchctl ?? realLaunchctl;
  fs.mkdirSync(path.dirname(loc.plistPath), { recursive: true });
  fs.writeFileSync(loc.plistPath, plist);
  log.info('Wrote OpenShell setup UI launchd plist', { plistPath: loc.plistPath });
  try {
    launchctl(['unload', loc.plistPath]);
  } catch {
    log.info('launchctl unload noop (plist was not previously loaded)');
  }
  try {
    launchctl(['load', loc.plistPath]);
  } catch (err) {
    log.error('launchctl load failed', { err });
  }
  const uid = (deps.uid ?? (() => process.getuid!()))();
  try {
    launchctl(['kickstart', `gui/${uid}/${loc.label}`]);
  } catch (err) {
    log.error('launchctl kickstart failed', { err });
  }
  return launchdLoaded(launchctl, loc.label);
}

export interface EnableUiResult {
  loc: UiServiceLocation;
  port: number;
  moved?: number;
  listening: boolean;
  active: boolean;
  url: string;
}

export async function enableUi(
  projectRoot: string,
  requested: number | undefined,
  deps: UiStepDeps = {},
): Promise<EnableUiResult> {
  const kind = uiServiceKind(deps);
  const serverPath = path.join(projectRoot, UI_SERVER_RELATIVE);
  if (!fs.existsSync(serverPath)) throw new Error(`UI server not found at ${serverPath}`);
  const loc = resolveLocation(projectRoot, kind, deps);

  const configuredRaw = readEnvFile([UI_PORT_KEY], projectRoot)[UI_PORT_KEY];
  const configured = configuredRaw ? Number(configuredRaw) : undefined;
  const { port, moved } = await chooseUiPort({
    requested,
    configured: Number.isInteger(configured) ? configured : undefined,
    ownUnitActive: serviceActive(loc, deps),
    isFree: deps.isFree,
  });
  upsertEnvVar(UI_PORT_KEY, String(port), projectRoot);
  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  const nodePath = (deps.nodePath ?? getNodePath)();
  const homeDir = deps.home ?? os.homedir();
  const active =
    loc.kind === 'launchd'
      ? startLaunchd(loc, renderUiPlist({ projectRoot, nodePath, homeDir }), deps)
      : startSystemd(loc, renderUiUnit({ projectRoot, nodePath, homeDir, root: loc.root }), deps);

  const listening = await (deps.waitListening ?? waitListening)(port);
  const host = (deps.hostname ?? os.hostname)();
  return { loc, port, moved, listening, active, url: `http://${host}:${port}/` };
}

export function disableUi(projectRoot: string, deps: UiStepDeps = {}): { loc: UiServiceLocation; removed: boolean } {
  const loc = resolveLocation(projectRoot, uiServiceKind(deps), deps);
  if (loc.kind === 'launchd') {
    try {
      (deps.launchctl ?? realLaunchctl)(['unload', loc.plistPath]);
    } catch {
      // not loaded
    }
    const removed = fs.existsSync(loc.plistPath);
    fs.rmSync(loc.plistPath, { force: true });
    return { loc, removed };
  }
  const systemctl = deps.systemctl ?? realSystemctl(loc);
  try {
    systemctl(['disable', '--now', loc.unit]);
  } catch {
    // not installed / already stopped
  }
  const removed = fs.existsSync(loc.unitPath);
  fs.rmSync(loc.unitPath, { force: true });
  try {
    systemctl(['daemon-reload']);
  } catch {
    // no manager reachable
  }
  return { loc, removed };
}

/** Status fields that name the service, per kind — no systemd fields on macOS and vice versa. */
export function serviceStatusFields(loc: UiServiceLocation): Record<string, string> {
  return loc.kind === 'launchd'
    ? { SERVICE_TYPE: 'launchd', LABEL: loc.label, PLIST_PATH: loc.plistPath }
    : { SERVICE_TYPE: loc.root ? 'systemd-system' : 'systemd-user', UNIT: loc.unit, UNIT_PATH: loc.unitPath };
}

/** The interactive question, shared by `--step openshell-ui` and the setup wizard. Default: no. */
export async function askOpenShellUi(): Promise<boolean> {
  const answer = await p.confirm({
    message:
      'Also start the OpenShell setup web UI? (manage providers, approve egress-policy proposals, replace the Claude ' +
      `credential later; runs in the background on port ${DEFAULT_UI_PORT} by default, with no login of its own)`,
    initialValue: false,
  });
  return !p.isCancel(answer) && answer === true;
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseUiArgs(args);
  let enable = parsed.enable;
  if (enable === undefined) {
    enable = process.stdin.isTTY ? await askOpenShellUi() : false; // non-interactive and unasked: no
  }

  if (!enable) {
    if (parsed.enable === false) {
      const { loc, removed } = disableUi(projectRoot);
      emitStatus('OPENSHELL_UI', { STATUS: 'success', ENABLED: false, ...serviceStatusFields(loc), REMOVED: removed });
    } else {
      emitStatus('OPENSHELL_UI', { STATUS: 'skipped', ENABLED: false });
    }
    return;
  }

  const gateway = (readEnvFile(['NANOCLAW_GATEWAY_PROVIDER'], projectRoot).NANOCLAW_GATEWAY_PROVIDER ?? '').trim();
  if (gateway !== 'openshell')
    log.warn('This install does not use the openshell gateway; the credential panel will say so', { gateway });
  const result = await enableUi(projectRoot, parsed.port);
  const bind = readEnvFile(['NANOCLAW_OPENSHELL_UI_HOST'], projectRoot).NANOCLAW_OPENSHELL_UI_HOST || '0.0.0.0';
  const name = result.loc.kind === 'launchd' ? `launchd agent ${result.loc.label}` : `unit ${result.loc.unit}`;
  console.log(
    `\nOpenShell setup UI: ${result.url}  (bound ${bind}:${result.port}, ${name})\n` +
      'It has no login of its own — expose it only through your password-gated reverse proxy.\n',
  );
  emitStatus('OPENSHELL_UI', {
    STATUS: result.active && result.listening ? 'success' : 'failed',
    ENABLED: true,
    URL: result.url,
    BIND: bind,
    PORT: result.port,
    ...(result.moved ? { PORT_MOVED_FROM: result.moved } : {}),
    ...serviceStatusFields(result.loc),
    ACTIVE: result.active,
    LISTENING: result.listening,
    LOG: 'logs/openshell-ui.log',
  });
  if (!(result.active && result.listening)) process.exit(1);
}
