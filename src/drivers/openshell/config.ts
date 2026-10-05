/**
 * Host-side configuration for everything OpenShell in this tree: the session
 * driver (`register.ts`) and the `ncl openshell-policy-*` commands both build
 * their `openshell` CLI here, so they always talk to the same binary and the
 * same gateway.
 *
 * Precedence: `process.env` wins, then `.env` — the same rule
 * `drivers/index.ts#readSetting` applies to NANOCLAW_RUNTIME_DRIVER. The host
 * service parses `.env` in-process (no EnvironmentFile=), so settings written
 * there by `setup --step openshell` would otherwise be silently ignored.
 */
import { readEnvFile } from '../../env.js';
import { realOpenShellCli, type OpenShellCli } from './cli.js';
import { OPENSHELL_SETTING_KEYS, settingsFromEnv } from './settings.js';

/** Read by the `openshell` CLI itself to pick a gateway; forwarded, never interpreted. */
export const OPENSHELL_GATEWAY_KEYS = ['OPENSHELL_GATEWAY', 'OPENSHELL_GATEWAY_ENDPOINT'] as const;

const ALL_KEYS = [...OPENSHELL_SETTING_KEYS, ...OPENSHELL_GATEWAY_KEYS];

export function openShellSettingsEnv(
  env: NodeJS.ProcessEnv = process.env,
  fromFile: Record<string, string> = readEnvFile(ALL_KEYS),
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...fromFile };
  for (const key of ALL_KEYS) {
    if (env[key]?.trim()) merged[key] = env[key];
  }
  return merged;
}

/** Gateway-selection variables to hand the CLI child process. */
export function openShellGatewayEnv(settingsEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OPENSHELL_GATEWAY_KEYS) {
    const value = settingsEnv[key]?.trim();
    if (value) out[key] = value;
  }
  return out;
}

/** The CLI this install is configured to use. */
export function configuredOpenShellCli(env: NodeJS.ProcessEnv = process.env): OpenShellCli {
  const settingsEnv = openShellSettingsEnv(env);
  return realOpenShellCli(settingsFromEnv(settingsEnv).bin, openShellGatewayEnv(settingsEnv));
}
