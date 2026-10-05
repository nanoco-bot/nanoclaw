/**
 * Pure preflight for the OpenShell gateway: does this copy's configuration
 * hang together? Shared by `setup.ts` (the skill's install step) and its test.
 *
 * Errors block installation; warnings are reported and installation goes on
 * (they describe the host, which may legitimately be prepared afterwards).
 */
import type { PortState } from '../../../../setup/lib/openshell-relay-port.js';
import { resolveBinary } from '../../../../setup/lib/resolve-binary.js';

export { resolveBinary };

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

const DEFAULT_HOST_ALIAS = 'host.openshell.internal';

/** Every `.env` key the preflight reads. */
export const PREFLIGHT_KEYS = [
  'NANOCLAW_RUNTIME_DRIVER',
  'OPENSHELL_BIN',
  'NANOCLAW_OPENSHELL_GATEWAY_PORTS',
  'NANOCLAW_OPENSHELL_GATEWAY_BINARIES',
  'NANOCLAW_OPENSHELL_GATEWAY_HOST',
  'NANOCLAW_OPENSHELL_HOST_ALIAS',
  'NANOCLAW_OPENSHELL_MODEL_RELAY_PORT',
] as const;

export function preflight(
  env: Record<string, string | undefined>,
  which: (bin: string) => string | undefined = (bin) => resolveBinary(bin),
  /** State of the configured relay port, probed by the caller (setup.ts). */
  relayPortState?: PortState,
): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const driver = env.NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() || 'docker';
  if (driver !== 'openshell') {
    errors.push(
      `The OpenShell gateway requires NANOCLAW_RUNTIME_DRIVER=openshell (this copy uses '${driver}'): ` +
        'its model relay is reachable only from inside an OpenShell sandbox. ' +
        'Run `pnpm exec tsx setup/index.ts --step openshell` to enable OpenShell sandboxing, or pick another gateway.',
    );
  }

  const alias = env.NANOCLAW_OPENSHELL_HOST_ALIAS?.trim() || DEFAULT_HOST_ALIAS;
  // No fixed default: a shared default port lets one copy's sandboxes reach
  // another copy's relay. Setup picks a port per install.
  const relayPort = Number(env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT?.trim());
  const ports = (env.NANOCLAW_OPENSHELL_GATEWAY_PORTS ?? '')
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((p) => p > 0);
  const egressHost = env.NANOCLAW_OPENSHELL_GATEWAY_HOST?.trim();
  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    errors.push(
      'NANOCLAW_OPENSHELL_MODEL_RELAY_PORT is not set. Run `pnpm exec tsx setup/index.ts --step openshell -- --enable` ' +
        'to choose a port for this install (it also sets NANOCLAW_OPENSHELL_GATEWAY_PORTS to match).',
    );
  } else if (ports.length !== 1 || ports[0] !== relayPort || !env.NANOCLAW_OPENSHELL_GATEWAY_BINARIES?.trim()) {
    errors.push(
      `The sandbox egress allow-list (NANOCLAW_OPENSHELL_GATEWAY_PORTS=${ports.join(',') || '<unset>'}) must be exactly ` +
        `the relay port ${relayPort}, with NANOCLAW_OPENSHELL_GATEWAY_BINARIES set; re-run \`setup --step openshell -- --enable\` to resync them.`,
    );
  } else if (egressHost && egressHost !== alias) {
    errors.push(
      `NANOCLAW_OPENSHELL_GATEWAY_HOST='${egressHost}' does not match the relay alias '${alias}' agents are given.`,
    );
  } else if (relayPortState === 'taken') {
    errors.push(
      `Relay port ${relayPort} is already in use by another process (not this install's relay). ` +
        'Sandboxes would reach whatever holds it. Re-run `setup --step openshell -- --enable` to pick a free port.',
    );
  }

  const bin = env.OPENSHELL_BIN?.trim() || 'openshell';
  if (!which(bin)) {
    warnings.push(
      `The openshell CLI was not found at '${bin}'. Install it (https://github.com/NVIDIA/OpenShell) ` +
        'or set OPENSHELL_BIN to its absolute path before starting NanoClaw.',
    );
  } else if (!bin.includes('/')) {
    warnings.push(
      `OPENSHELL_BIN='${bin}' is resolved through PATH. The background service has a fixed PATH; ` +
        'prefer an absolute path.',
    );
  }
  return { errors, warnings };
}
