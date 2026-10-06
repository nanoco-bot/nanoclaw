/**
 * The OpenShell gateway's model credential: where it lives and how to check it.
 *
 * The relay reads ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN from the host
 * SERVICE's process environment. Setup puts it there with a systemd drop-in
 * owned by this install's unit — `<unit>.service.d/credential.conf`, mode
 * 0600 — and never in `.env` or any tracked file. Verify checks the same
 * place the relay reads (the running service's environment, else the unit's
 * configured Environment, else the drop-in file), so it cannot report
 * "configured" while the relay sees nothing.
 *
 * macOS: the same host service runs as a LaunchAgent, and launchd has no
 * drop-ins or env files, so the credential goes into that plist's
 * EnvironmentVariables dict (the plist setup/service.ts writes owner-only,
 * which already carries proxy variables the same way), followed by the
 * service's own unload → load → kickstart. Verify reads it back from the
 * plist. setup/service.ts carries it across later rewrites of the plist.
 *
 * Anything else (Linux without systemd: WSL / the nohup fallback) is refused
 * explicitly rather than silently left without a credential.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
import { getPlatform, getServiceManager } from '../platform.js';
import { reloadLaunchAgent, writeOwnerOnly } from '../service.js';
import { RELAY_CREDENTIAL_KEYS, editPlistEnvironment, readPlistEnvironment } from './launchd-plist.js';

export type CredentialKind = 'api-key' | 'oauth';
export interface ModelCredential {
  kind: CredentialKind;
  value: string;
}

export const CREDENTIAL_ENV: Record<CredentialKind, string> = {
  'api-key': 'ANTHROPIC_API_KEY',
  oauth: 'CLAUDE_CODE_OAUTH_TOKEN',
};

/** Token charset: no whitespace, quotes, backslashes or `%` — nothing systemd would reinterpret. */
const SAFE_VALUE = /^[A-Za-z0-9._~+/=-]+$/;

export function assertSafeCredential(cred: ModelCredential): void {
  if (!cred.value || !SAFE_VALUE.test(cred.value)) {
    throw new Error(
      `The ${CREDENTIAL_ENV[cred.kind]} value has characters a credential never contains; check what was pasted`,
    );
  }
}

/** Same rule the other gateways use: an sk-ant-oat token is OAuth whichever variable carried it. */
export function suppliedCredential(env: NodeJS.ProcessEnv = process.env): ModelCredential | undefined {
  const token = (env.NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN)?.trim();
  if (token) return { kind: 'oauth', value: token };
  const key = (env.NANOCLAW_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY)?.trim();
  if (!key) return undefined;
  return { kind: key.startsWith('sk-ant-oat') ? 'oauth' : 'api-key', value: key };
}

export interface UnitLocation {
  unit: string;
  root: boolean;
  /** `systemctl` argv prefix for this unit's manager. */
  systemctl: string[];
  dropInDir: string;
  dropInPath: string;
}

/** Mirrors setup/service.ts: root installs a system unit, everyone else a user unit. */
export function unitLocation(
  projectRoot: string = process.cwd(),
  opts: { root?: boolean; home?: string } = {},
): UnitLocation {
  const root = opts.root ?? process.getuid?.() === 0;
  const unit = getSystemdUnit(projectRoot);
  const base = root ? '/etc/systemd/system' : path.join(opts.home ?? os.homedir(), '.config', 'systemd', 'user');
  const dropInDir = path.join(base, `${unit}.service.d`);
  return {
    unit,
    root,
    systemctl: root ? ['systemctl'] : ['systemctl', '--user'],
    dropInDir,
    dropInPath: path.join(dropInDir, 'credential.conf'),
  };
}

export function renderCredentialDropIn(cred: ModelCredential): string {
  assertSafeCredential(cred);
  return [
    '# Written by NanoClaw setup (OpenShell gateway). Read by the host model relay only;',
    '# never passed to agents. Do not commit. Remove with: systemctl --user revert <unit>',
    '[Service]',
    `Environment=${CREDENTIAL_ENV[cred.kind]}=${cred.value}`,
    '',
  ].join('\n');
}

/** Atomic, owner-only write. The directory is created 0700 when absent. */
export function writeCredentialDropIn(loc: UnitLocation, cred: ModelCredential): void {
  const content = renderCredentialDropIn(cred);
  fs.mkdirSync(loc.dropInDir, { recursive: true, mode: 0o700 });
  const tmp = path.join(loc.dropInDir, `.credential.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, loc.dropInPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}

/** Credential kind present in an environment listing (`KEY=value` pairs, whitespace- or NUL-separated). */
export function credentialKindIn(listing: string): CredentialKind | undefined {
  const has = (key: string) => new RegExp(`(?:^|[\\s\\0"]|Environment=)${key}=[^\\s\\0"]+`, 'm').test(listing);
  if (has(CREDENTIAL_ENV['api-key'])) return 'api-key';
  if (has(CREDENTIAL_ENV.oauth)) return 'oauth';
  return undefined;
}

export interface ServiceCredential {
  kind: CredentialKind | 'none';
  /** Where it was read: the live process, the unit as loaded by systemd, or the drop-in on disk. */
  source: 'running-service' | 'unit-environment' | 'drop-in-file' | 'unavailable';
}

type Exec = (cmd: string, args: string[]) => string;
const realExec: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });

/** What the relay will see. Values are never returned, only the kind. */
export function inspectServiceCredential(
  loc: UnitLocation | LaunchdCredentialLocation,
  deps: { exec?: Exec; readFile?: (p: string) => string } = {},
): ServiceCredential {
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
  if (isLaunchd(loc)) return inspectLaunchdCredential(loc, readFile);
  const exec = deps.exec ?? realExec;
  const [cmd, ...prefix] = loc.systemctl;
  try {
    const out = exec(cmd, [...prefix, 'show', loc.unit, '-p', 'MainPID', '-p', 'Environment']);
    const pid = Number(out.match(/^MainPID=(\d+)/m)?.[1] ?? 0);
    if (pid > 0) {
      try {
        return { kind: credentialKindIn(readFile(`/proc/${pid}/environ`)) ?? 'none', source: 'running-service' };
      } catch {
        // Not readable (different user, non-Linux): fall back to the unit's Environment.
      }
    }
    const env = out.match(/^Environment=(.*)$/m)?.[1] ?? '';
    return { kind: credentialKindIn(env) ?? 'none', source: 'unit-environment' };
  } catch {
    // No systemd manager to ask: read the drop-in setup would have written.
  }
  try {
    return { kind: credentialKindIn(readFile(loc.dropInPath)) ?? 'none', source: 'drop-in-file' };
  } catch {
    return { kind: 'none', source: 'unavailable' };
  }
}

// ---------------------------------------------------------------------------
// macOS (launchd) and platform selection
// ---------------------------------------------------------------------------

export interface LaunchdCredentialLocation {
  kind: 'launchd';
  /** The NanoClaw host service's launchd label (setup/service.ts setupLaunchd). */
  label: string;
  plistPath: string;
}

export type CredentialLocation = UnitLocation | LaunchdCredentialLocation;

export function isLaunchd(loc: CredentialLocation): loc is LaunchdCredentialLocation {
  return (loc as { kind?: string }).kind === 'launchd';
}

export function launchdLocation(
  projectRoot: string = process.cwd(),
  opts: { home?: string } = {},
): LaunchdCredentialLocation {
  const label = getLaunchdLabel(projectRoot);
  return {
    kind: 'launchd',
    label,
    plistPath: path.join(opts.home ?? os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
  };
}

export const UNSUPPORTED_SERVICE_MANAGER =
  'The OpenShell gateway installs its model credential into the NanoClaw service definition ' +
  '(a systemd drop-in on Linux, the LaunchAgent plist on macOS); this host has neither systemd nor launchd. ' +
  'This version supports OpenShell on Linux with systemd, or on macOS.';

/** Where this host's service gets its credential; throws on hosts with no supported service manager. */
export function credentialLocation(
  projectRoot: string = process.cwd(),
  opts: { platform?: string; serviceManager?: string; root?: boolean; home?: string } = {},
): CredentialLocation {
  const platform = opts.platform ?? getPlatform();
  if (platform === 'macos') return launchdLocation(projectRoot, { home: opts.home });
  if (platform === 'linux' && (opts.serviceManager ?? getServiceManager()) === 'systemd') {
    return unitLocation(projectRoot, { root: opts.root, home: opts.home });
  }
  throw new Error(UNSUPPORTED_SERVICE_MANAGER);
}

/**
 * Put the credential into the LaunchAgent plist's EnvironmentVariables:
 * this key replaced in place (or added), the other credential variable
 * removed (exactly one, as with the drop-in — and an older API key would
 * otherwise win over a new OAuth token), every other byte untouched. Written
 * owner-only via rename, then the service is reloaded the way setupLaunchd
 * does it.
 */
export function writeLaunchdCredential(
  loc: LaunchdCredentialLocation,
  cred: ModelCredential,
  deps: { reload?: (plistPath: string, label: string) => void } = {},
): void {
  assertSafeCredential(cred);
  let plist: string;
  try {
    plist = fs.readFileSync(loc.plistPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    throw new Error(missingLaunchAgentMessage(loc), { cause: err });
  }
  const key = CREDENTIAL_ENV[cred.kind];
  const next = editPlistEnvironment(
    plist,
    { [key]: cred.value },
    RELAY_CREDENTIAL_KEYS.filter((k) => k !== key),
  );
  writeOwnerOnly(loc.plistPath, next);
  (deps.reload ?? reloadLaunchAgent)(loc.plistPath, loc.label);
}

function missingLaunchAgentMessage(loc: LaunchdCredentialLocation): string {
  return (
    `No NanoClaw LaunchAgent at ${loc.plistPath}, so there is no service to give the Claude credential to. ` +
    'Install the service first (`pnpm exec tsx setup/index.ts --step service`), then re-run the sign-in ' +
    '(`pnpm exec tsx setup/index.ts --step gateway-auth`).'
  );
}

/**
 * The plist must already exist — setup never invents one. Checked before any
 * prompt, so nobody signs in only to be told there is nowhere to put it. (The
 * systemd drop-in has no such requirement: it may precede its unit.)
 */
export function assertServiceReady(loc: CredentialLocation): void {
  if (isLaunchd(loc) && !fs.existsSync(loc.plistPath)) throw new Error(missingLaunchAgentMessage(loc));
}

/** Write the credential where this platform's service reads it (drop-in or plist). */
export function writeServiceCredential(
  loc: CredentialLocation,
  cred: ModelCredential,
  deps: { reload?: (plistPath: string, label: string) => void } = {},
): void {
  if (isLaunchd(loc)) writeLaunchdCredential(loc, cred, deps);
  else writeCredentialDropIn(loc, cred);
}

/** The plist's EnvironmentVariables is the service's environment on macOS (no /proc to read). */
function inspectLaunchdCredential(loc: LaunchdCredentialLocation, readFile: (p: string) => string): ServiceCredential {
  let plist: string;
  try {
    plist = readFile(loc.plistPath);
  } catch {
    return { kind: 'none', source: 'unavailable' };
  }
  const env = readPlistEnvironment(plist) ?? new Map<string, string>();
  const listing = [...env].map(([k, v]) => `${k}=${v}`).join('\n');
  return { kind: credentialKindIn(listing) ?? 'none', source: 'unit-environment' };
}

/** inspectServiceCredential for this host, or "unavailable" where no service manager is supported. */
export function inspectInstallCredential(projectRoot: string = process.cwd()): ServiceCredential {
  let loc: CredentialLocation;
  try {
    loc = credentialLocation(projectRoot);
  } catch {
    return { kind: 'none', source: 'unavailable' };
  }
  return inspectServiceCredential(loc);
}
