/**
 * Operator settings -> driver options. Pure, so it is testable without a host.
 *
 * Takes an env-shaped record; `register.ts` builds it from `.env` with
 * `process.env` taking precedence (see `openShellSettingsEnv`). Not
 * `drivers/index.ts#readSetting`: that module imports `installed.ts`, which
 * imports this driver — a cycle.
 */
import fs from 'node:fs';

import { mergePolicyOptions, parsePolicyConfig } from './group-policy.js';
import type { PolicyOptions } from './policy.js';

/** Every key `settingsFromEnv` reads — what `register.ts` pulls from `.env`. */
export const OPENSHELL_SETTING_KEYS = [
  'OPENSHELL_BIN',
  'NANOCLAW_OPENSHELL_BASE_RO',
  'NANOCLAW_OPENSHELL_BASE_RW',
  'NANOCLAW_OPENSHELL_LANDLOCK',
  'NANOCLAW_OPENSHELL_GATEWAY_PORTS',
  'NANOCLAW_OPENSHELL_GATEWAY_BINARIES',
  'NANOCLAW_OPENSHELL_GATEWAY_HOST',
  'NANOCLAW_OPENSHELL_POLL_MS',
  'NANOCLAW_OPENSHELL_POLICY_FILE',
] as const;

export interface EnvDriverSettings {
  bin: string;
  pollIntervalMs?: number;
  policy: PolicyOptions;
  /** Per-group-folder overrides from NANOCLAW_OPENSHELL_POLICY_FILE. */
  groupPolicy?: Record<string, PolicyOptions>;
}

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * NANOCLAW_OPENSHELL_POLICY_FILE (JSON, see group-policy.ts) supplies defaults
 * and per-group entries; the individual NANOCLAW_OPENSHELL_* variables
 * override the file's defaults field by field.
 */
export function settingsFromEnv(
  env: NodeJS.ProcessEnv,
  readFile: (path: string) => string = (p) => fs.readFileSync(p, 'utf8'),
): EnvDriverSettings {
  const policy: PolicyOptions = {};
  const ro = csv(env.NANOCLAW_OPENSHELL_BASE_RO);
  if (ro) policy.baseReadOnly = ro;
  const rw = csv(env.NANOCLAW_OPENSHELL_BASE_RW);
  if (rw) policy.baseReadWrite = rw;

  const landlock = env.NANOCLAW_OPENSHELL_LANDLOCK?.trim();
  if (landlock) {
    if (landlock !== 'best_effort' && landlock !== 'hard_requirement') {
      throw new Error(`NANOCLAW_OPENSHELL_LANDLOCK='${landlock}' must be best_effort or hard_requirement`);
    }
    policy.landlockCompatibility = landlock;
  }

  const ports = csv(env.NANOCLAW_OPENSHELL_GATEWAY_PORTS);
  const binaries = csv(env.NANOCLAW_OPENSHELL_GATEWAY_BINARIES);
  if (ports || binaries) {
    if (!ports || !binaries) {
      throw new Error('NANOCLAW_OPENSHELL_GATEWAY_PORTS and NANOCLAW_OPENSHELL_GATEWAY_BINARIES must be set together');
    }
    const parsed = ports.map((p) => Number(p));
    if (!parsed.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) {
      throw new Error(`NANOCLAW_OPENSHELL_GATEWAY_PORTS='${env.NANOCLAW_OPENSHELL_GATEWAY_PORTS}' must be TCP ports`);
    }
    policy.gatewayEgress = {
      ports: parsed,
      binaries,
      ...(env.NANOCLAW_OPENSHELL_GATEWAY_HOST?.trim() ? { host: env.NANOCLAW_OPENSHELL_GATEWAY_HOST.trim() } : {}),
    };
  }

  const poll = env.NANOCLAW_OPENSHELL_POLL_MS?.trim();
  let pollIntervalMs: number | undefined;
  if (poll) {
    pollIntervalMs = Number(poll);
    if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 250) {
      throw new Error(`NANOCLAW_OPENSHELL_POLL_MS='${poll}' must be an integer >= 250`);
    }
  }

  const file = env.NANOCLAW_OPENSHELL_POLICY_FILE?.trim();
  let merged = policy;
  let groupPolicy: Record<string, PolicyOptions> | undefined;
  if (file) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFile(file));
    } catch (err) {
      throw new Error(
        `NANOCLAW_OPENSHELL_POLICY_FILE='${file}' is not readable JSON: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    const config = parsePolicyConfig(raw);
    merged = mergePolicyOptions(config.default ?? {}, policy);
    groupPolicy = config.groups;
  }

  return {
    bin: env.OPENSHELL_BIN?.trim() || 'openshell',
    ...(pollIntervalMs ? { pollIntervalMs } : {}),
    policy: merged,
    ...(groupPolicy ? { groupPolicy } : {}),
  };
}
