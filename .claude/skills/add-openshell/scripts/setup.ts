/**
 * OpenShell gateway install step: validate that this copy is configured for
 * OpenShell sandboxing before the gateway is stamped as selected. It installs
 * nothing external — the OpenShell gateway itself is operated separately.
 */
import { readEnvFile } from '../../../../src/env.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { portState } from '../../../../setup/lib/openshell-relay-port.js';
import { emitStatus } from '../../../../setup/status.js';
import { PREFLIGHT_KEYS, preflight } from './preflight.js';

const fromFile = readEnvFile([...PREFLIGHT_KEYS]);
const env: Record<string, string | undefined> = { ...fromFile };
for (const key of PREFLIGHT_KEYS) if (process.env[key]?.trim()) env[key] = process.env[key];

const port = Number(env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT?.trim());
const relayPortState =
  Number.isInteger(port) && port > 0 && port < 65536 ? await portState(port, getInstallSlug()) : undefined;
const { errors, warnings } = preflight(env, undefined, relayPortState);
for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);

emitStatus('OPENSHELL_GATEWAY', {
  STATUS: errors.length ? 'failed' : 'success',
  WARNINGS: warnings.length,
  ...(relayPortState ? { RELAY_PORT: port, RELAY_PORT_STATE: relayPortState } : {}),
  ...(errors.length ? { ERROR: 'openshell_not_configured' } : {}),
});
if (errors.length) process.exit(1);
