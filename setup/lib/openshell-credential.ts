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
 * systemd (Linux) only in this version; launchd/nohup installs are refused
 * explicitly rather than silently left without a credential.
 */
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getSystemdUnit } from '../../src/install-slug.js';

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
  loc: UnitLocation,
  deps: { exec?: Exec; readFile?: (p: string) => string } = {},
): ServiceCredential {
  const exec = deps.exec ?? realExec;
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
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
