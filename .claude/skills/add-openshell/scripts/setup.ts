/**
 * OpenShell gateway install step: validate that this copy is configured for
 * OpenShell sandboxing before the gateway is stamped as selected. It installs
 * nothing external — OpenShell itself is installed by setup's openshell steps.
 */
import { readEnvFile } from '../../../../src/env.js';
import { emitStatus } from '../../../../setup/status.js';
import { PREFLIGHT_KEYS, preflight } from './preflight.js';

const env: Record<string, string | undefined> = { ...readEnvFile([...PREFLIGHT_KEYS]) };
for (const key of PREFLIGHT_KEYS) if (process.env[key]?.trim()) env[key] = process.env[key];

const { errors, warnings } = preflight(env);
for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const error of errors) console.error(`error: ${error}`);

emitStatus('OPENSHELL_GATEWAY', {
  STATUS: errors.length ? 'failed' : 'success',
  WARNINGS: warnings.length,
  ...(errors.length ? { ERROR: 'openshell_not_configured' } : {}),
});
if (errors.length) process.exit(1);
