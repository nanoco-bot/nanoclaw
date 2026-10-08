/**
 * Preflight for the OpenShell gateway: does this copy's configuration hang
 * together? Shared by `setup.ts` (the skill's install step) and its test.
 *
 * Errors block installation; warnings are reported and installation goes on
 * (they describe the host, which may legitimately be prepared afterwards).
 */
import { resolveBinary } from '../../../../setup/lib/resolve-binary.js';

export interface PreflightResult {
  errors: string[];
  warnings: string[];
}

/** Every `.env` key the preflight reads. */
export const PREFLIGHT_KEYS = ['NANOCLAW_RUNTIME_DRIVER', 'OPENSHELL_BIN'] as const;

export function preflight(
  env: Record<string, string | undefined>,
  which: (bin: string) => string | undefined = (bin) => resolveBinary(bin),
): PreflightResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const driver = env.NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() || 'docker';
  if (driver !== 'openshell') {
    errors.push(
      `The OpenShell gateway requires NANOCLAW_RUNTIME_DRIVER=openshell (this copy uses '${driver}'): ` +
        'only the OpenShell driver attaches the OpenShell provider that holds the Claude credential. ' +
        'Run `pnpm exec tsx setup/index.ts --step openshell` to enable OpenShell sandboxing, or pick another gateway.',
    );
  }

  const bin = env.OPENSHELL_BIN?.trim() || 'openshell';
  if (!which(bin)) {
    warnings.push(
      `The openshell CLI was not found at '${bin}'. Install it with \`pnpm exec tsx setup/index.ts --step openshell-install\` ` +
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
