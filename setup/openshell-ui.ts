/**
 * Step: openshell-ui — opt-in operator web UI for an OpenShell-backed install.
 *
 *   pnpm exec tsx setup/index.ts --step openshell-ui                    # asks (TTY), default: no
 *   pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]
 *   pnpm exec tsx setup/index.ts --step openshell-ui -- --disable
 *
 * Unlike every other step, what this installs stays resident: a systemd unit
 * running `.claude/skills/add-openshell/scripts/ui/server.ts`. The unit is
 * written, enabled and (re)started the same way setup/service.ts installs the
 * NanoClaw service — same unit directory rule (system unit as root, user unit
 * otherwise), same HOME/PATH lines, daemon-reload → enable → restart →
 * is-active. Its name deliberately does NOT start with `nanoclaw`:
 * setup/peer-cleanup.ts treats every other `nanoclaw*.service` as a peer
 * NanoClaw install and disables ones it judges unhealthy.
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
import { getNodePath, getServiceManager, isRoot } from './platform.js';
import { upsertEnvVar } from './set-env.js';
import { emitStatus } from './status.js';

export const DEFAULT_UI_PORT = 8790;
export const UI_PORT_KEY = 'NANOCLAW_OPENSHELL_UI_PORT';
export const UI_SERVER_RELATIVE = path.join('.claude', 'skills', 'add-openshell', 'scripts', 'ui', 'server.ts');

export function uiUnitName(projectRoot: string = process.cwd()): string {
  return `openshell-setup-ui-${getInstallSlug(projectRoot)}`;
}

export interface UiUnitLocation {
  unit: string;
  unitPath: string;
  systemctl: string[];
  root: boolean;
}

/** setup/service.ts's rule: root installs a system unit, everyone else a user unit. */
export function uiUnitLocation(projectRoot: string, opts: { root?: boolean; home?: string } = {}): UiUnitLocation {
  const root = opts.root ?? isRoot();
  const unit = uiUnitName(projectRoot);
  const dir = root ? '/etc/systemd/system' : path.join(opts.home ?? os.homedir(), '.config', 'systemd', 'user');
  return {
    unit,
    unitPath: path.join(dir, `${unit}.service`),
    systemctl: root ? ['systemctl'] : ['systemctl', '--user'],
    root,
  };
}

export function renderUiUnit(opts: { projectRoot: string; nodePath: string; homeDir: string; root: boolean }): string {
  const { projectRoot, nodePath, homeDir, root } = opts;
  // Absolute loader path: ExecStart must not depend on bare-specifier lookup,
  // and node_modules/tsx (a pnpm symlink) survives tsx upgrades.
  const loader = pathToFileURL(path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return `[Unit]
Description=NanoClaw OpenShell setup UI
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} --import ${loader} ${path.join(projectRoot, UI_SERVER_RELATIVE)}
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
 * unit is the holder (re-running the step on a live install keeps its port).
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

type Systemctl = (args: string[]) => void;
const realSystemctl =
  (loc: UiUnitLocation): Systemctl =>
  (args) => {
    const [cmd, ...prefix] = loc.systemctl;
    execFileSync(cmd, [...prefix, ...args], { stdio: 'ignore' });
  };

function active(systemctl: Systemctl, unit: string): boolean {
  try {
    systemctl(['is-active', unit]);
    return true;
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
  systemctl?: Systemctl;
  isFree?: (port: number) => Promise<boolean>;
  waitListening?: (port: number) => Promise<boolean>;
  serviceManager?: () => string;
  loc?: UiUnitLocation;
  hostname?: () => string;
}

export async function enableUi(projectRoot: string, requested: number | undefined, deps: UiStepDeps = {}) {
  if ((deps.serviceManager ?? getServiceManager)() !== 'systemd') {
    throw new Error('The OpenShell setup UI is installed as a systemd unit; this host has no systemd service manager.');
  }
  const serverPath = path.join(projectRoot, UI_SERVER_RELATIVE);
  if (!fs.existsSync(serverPath)) throw new Error(`UI server not found at ${serverPath}`);
  const loc = deps.loc ?? uiUnitLocation(projectRoot);
  const systemctl = deps.systemctl ?? realSystemctl(loc);
  const configuredRaw = readEnvFile([UI_PORT_KEY], projectRoot)[UI_PORT_KEY];
  const configured = configuredRaw ? Number(configuredRaw) : undefined;
  const { port, moved } = await chooseUiPort({
    requested,
    configured: Number.isInteger(configured) ? configured : undefined,
    ownUnitActive: active(systemctl, loc.unit),
    isFree: deps.isFree,
  });
  upsertEnvVar(UI_PORT_KEY, String(port), projectRoot);

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });
  fs.mkdirSync(path.dirname(loc.unitPath), { recursive: true });
  fs.writeFileSync(
    loc.unitPath,
    renderUiUnit({ projectRoot, nodePath: getNodePath(), homeDir: os.homedir(), root: loc.root }),
  );
  log.info('Wrote OpenShell setup UI unit', { unitPath: loc.unitPath, port });

  // Same sequence as setup/service.ts: restart (not start) so an edited unit takes effect.
  for (const args of [['daemon-reload'], ['enable', loc.unit], ['restart', loc.unit]]) {
    try {
      systemctl(args);
    } catch (err) {
      log.error(`systemctl ${args[0]} failed`, { unit: loc.unit, err });
    }
  }
  const listening = await (deps.waitListening ?? waitListening)(port);
  const host = (deps.hostname ?? os.hostname)();
  return { loc, port, moved, listening, active: active(systemctl, loc.unit), url: `http://${host}:${port}/` };
}

export function disableUi(projectRoot: string, deps: UiStepDeps = {}): { loc: UiUnitLocation; removed: boolean } {
  const loc = deps.loc ?? uiUnitLocation(projectRoot);
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

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const parsed = parseUiArgs(args);
  let enable = parsed.enable;
  if (enable === undefined) {
    if (process.stdin.isTTY) {
      const answer = await p.confirm({
        message:
          'Launch the OpenShell setup web UI? (credential, providers, egress approvals; runs as a service on 0.0.0.0)',
        initialValue: false,
      });
      enable = !p.isCancel(answer) && answer === true;
    } else {
      enable = false; // non-interactive and unasked: no
    }
  }

  if (!enable) {
    if (parsed.enable === false) {
      const { loc, removed } = disableUi(projectRoot);
      emitStatus('OPENSHELL_UI', { STATUS: 'success', ENABLED: false, UNIT: loc.unit, REMOVED: removed });
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
  console.log(
    `\nOpenShell setup UI: ${result.url}  (bound ${bind}:${result.port}, unit ${result.loc.unit})\n` +
      'It has no login of its own — expose it only through your password-gated reverse proxy.\n',
  );
  emitStatus('OPENSHELL_UI', {
    STATUS: result.active && result.listening ? 'success' : 'failed',
    ENABLED: true,
    URL: result.url,
    BIND: bind,
    PORT: result.port,
    ...(result.moved ? { PORT_MOVED_FROM: result.moved } : {}),
    UNIT: result.loc.unit,
    UNIT_PATH: result.loc.unitPath,
    ACTIVE: result.active,
    LISTENING: result.listening,
    LOG: 'logs/openshell-ui.log',
  });
  if (!(result.active && result.listening)) process.exit(1);
}
