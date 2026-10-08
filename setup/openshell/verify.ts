/**
 * Verify's OpenShell checks (setup/verify.ts calls these on every install;
 * they return null on a copy that does not use OpenShell): whether OpenShell
 * holds this install's Claude credential, and whether OpenShell's gateway
 * answers and its supervisor image is still in Docker.
 */
import { readEnvFile } from '../../src/env.js';
import { inspectOpenShellRuntime, storedModelCredential, SUPERVISOR_IMAGE_KEY, type RuntimeReport } from './runtime.js';

/**
 * On an OpenShell-gateway copy, the model credential is an OpenShell provider,
 * so the answer comes from OpenShell (a gateway name in .env says nothing about
 * whether it holds a key). Null on every other copy.
 */
export function openShellCredentials(
  projectRoot: string,
  storedKind: (root: string) => string | null = (root) => storedModelCredential(root),
): { credentials: 'configured' | 'missing'; credentialSource: string } | null {
  const gatewayKind = (
    process.env.NANOCLAW_GATEWAY_PROVIDER ||
    readEnvFile(['NANOCLAW_GATEWAY_PROVIDER'], projectRoot).NANOCLAW_GATEWAY_PROVIDER ||
    ''
  )
    .trim()
    .toLowerCase();
  if (gatewayKind !== 'openshell') return null;
  const kind = storedKind(projectRoot);
  return { credentials: kind ? 'configured' : 'missing', credentialSource: `openshell-provider:${kind ?? 'none'}` };
}

/**
 * The OpenShell runtime, on a copy whose driver is `openshell`; null on every
 * other copy, which this never touches. Read-only (inspectOpenShellRuntime):
 * whether the gateway answers, and whether the supervisor image it runs every
 * sandbox's supervisor from is still in Docker. That image goes missing after
 * an `image prune -a`, and from then on every sandbox create fails until it is
 * pulled again — the gateway resolves it only when it starts.
 */
export function checkOpenShellRuntime(
  projectRoot: string,
  inspect: typeof inspectOpenShellRuntime = inspectOpenShellRuntime,
): RuntimeReport | null {
  const keys = [
    'NANOCLAW_RUNTIME_DRIVER',
    'OPENSHELL_BIN',
    'OPENSHELL_GATEWAY',
    'OPENSHELL_GATEWAY_ENDPOINT',
    SUPERVISOR_IMAGE_KEY,
  ];
  const fromFile = readEnvFile(keys, projectRoot);
  const get = (key: string) => process.env[key]?.trim() || fromFile[key]?.trim() || '';
  if (get('NANOCLAW_RUNTIME_DRIVER').toLowerCase() !== 'openshell') return null;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['OPENSHELL_GATEWAY', 'OPENSHELL_GATEWAY_ENDPOINT']) if (get(key)) env[key] = get(key);
  return inspect({
    bin: get('OPENSHELL_BIN') || 'openshell',
    env,
    supervisorOverride: get(SUPERVISOR_IMAGE_KEY) || undefined,
  });
}

/** Verify's status-block fields for the runtime report. */
export function openShellStatusFields(report: RuntimeReport | null): Record<string, string> {
  if (!report) return {};
  return {
    OPENSHELL_GATEWAY: report.gateway,
    OPENSHELL_SUPERVISOR_IMAGE: report.supervisorImage,
    ...(report.supervisorImageRef ? { OPENSHELL_SUPERVISOR_IMAGE_REF: report.supervisorImageRef } : {}),
  };
}
