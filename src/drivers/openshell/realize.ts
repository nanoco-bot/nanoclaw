/**
 * Realization helpers that talk OpenShell's CLI vocabulary: names, argv, the
 * `-o json` sandbox shape, phase mapping, and error normalization. Pure — the
 * driver composes these with an `OpenShellCli`.
 */
import { createHash } from 'node:crypto';

import {
  asFailureError,
  deniedByPolicy,
  labelValueLegal,
  labelsForKey,
  specInvalid,
  type ContainerSpec,
  type SessionFailure,
  type SessionFailureError,
  type SessionKey,
  type SessionPhase,
  type SessionSpec,
  type SessionStatus,
} from '../types.js';
import { sandboxImage } from './image.js';
import { OpenShellCliError } from './cli.js';
import type { DriverConfig } from './policy.js';

/**
 * Sandbox names are DNS-1123 labels of at most 19 bytes on v0.1.2
 * (`MAX_ROUTABLE_NAME_LEN`), so the Docker driver's readable
 * `ncl-<slug>-<session>` cannot fit. Derived from the FULL key, never a
 * timestamp, so `prepare` stays idempotent; 60 bits of sha256 make collisions
 * negligible, and ownership is still verified by labels before adopting.
 */
export function sandboxName(key: SessionKey): string {
  const digest = createHash('sha256')
    .update(`${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`)
    .digest('hex');
  return `ncl-${digest.slice(0, 15)}`;
}

/** Labels stamped on the sandbox: canonical key labels + lineage, realized verbatim or refused. */
export function sandboxLabels(spec: SessionSpec, container: ContainerSpec): Record<string, string> {
  const labels = labelsForKey(spec.key, container.role, { ...spec.labels, ...(container.labels ?? {}) });
  for (const [k, v] of Object.entries(labels)) {
    // Never projected or truncated: labels are the adoption contract, and a
    // mangled one silently breaks listSessions() reconstruction.
    if (!labelValueLegal(v)) throw specInvalid(`label ${k}='${v}' is not a realizable label value`);
  }
  return labels;
}

/** `memoryMb` -> OpenShell's Kubernetes-style quantity. */
export function memoryQuantity(memoryMb: number): string {
  return `${Math.floor(memoryMb)}Mi`;
}

export interface CreateArgsInput {
  spec: SessionSpec;
  container: ContainerSpec;
  name: string;
  policyPath: string;
  driverConfig: DriverConfig | null;
  /** OpenShell provider names to attach (the install's Claude provider and the group's, from the policy file). */
  providers?: readonly string[];
  /** Driver-owned, non-secret variables (the access manifest); set last. */
  extraEnv?: Record<string, string>;
}

/**
 * The `openshell sandbox create` flag that attaches a named provider, once per
 * provider. Verified on OpenShell v0.1.2: `--help` ("Attach a configured
 * credential provider to the sandbox … Repeatable") and openshell-cli
 * main.rs (`#[arg(long = "provider")] providers: Vec<String>`).
 */
export const PROVIDER_ATTACH_FLAG = '--provider';

/** OpenShell's own provider-name shape (openshell-cli), also refused if it could read as a flag. */
export const PROVIDER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * `openshell sandbox create` argv. `--detach` returns once the sandbox is
 * provisioned without attaching to the main process; `--no-tty` and
 * `--no-auto-providers` keep it non-interactive (a prompt would hang the host).
 *
 * `--no-auto-providers` stays even when providers are attached: it only stops
 * OpenShell from auto-CREATING missing providers out of this host's local
 * credentials; it does not conflict with `--provider` (no clap
 * conflicts_with between them in main.rs). A named provider the gateway does
 * not have fails the create instead of being invented from the host's env.
 */
export function createArgs({
  spec,
  container,
  name,
  policyPath,
  driverConfig,
  providers = [],
  extraEnv = {},
}: CreateArgsInput): string[] {
  const args = ['sandbox', 'create', '--name', name, '--from', sandboxImage(container.image), '--policy', policyPath];
  if (driverConfig) args.push('--driver-config-json', JSON.stringify(driverConfig));
  for (const [k, v] of Object.entries(sandboxLabels(spec, container))) args.push('--label', `${k}=${v}`);
  // env first, then the contributed lane: on a key collision the contributed
  // value wins (the ordering the seam states as contract).
  const env = { ...container.env, ...(container.contributedEnv ?? {}), ...extraEnv };
  for (const [k, v] of Object.entries(env)) args.push('--env', `${k}=${v}`);
  if (spec.resources.cpus) args.push('--cpu', spec.resources.cpus);
  if (spec.resources.memoryMb) args.push('--memory', memoryQuantity(spec.resources.memoryMb));
  for (const provider of new Set(providers)) {
    if (!PROVIDER_NAME_RE.test(provider)) throw specInvalid(`OpenShell provider name '${provider}' is not valid`);
    args.push(PROVIDER_ATTACH_FLAG, provider);
  }
  args.push('--detach', '--no-tty', '--no-auto-providers', '-o', 'json');
  const argv = [...(container.command ?? []), ...(container.args ?? [])];
  if (argv.length > 0) args.push('--', ...argv);
  return args;
}

// ---------- the `-o json` sandbox document (openshell-cli sandbox_to_json @ v0.1.2) ----------

export type OpenShellPhase =
  | 'Unspecified'
  | 'Provisioning'
  | 'Ready'
  | 'Error'
  | 'Deleting'
  | 'Stopping'
  | 'Stopped'
  | 'Starting'
  | 'Completed'
  | 'Unknown';

export interface OpenShellSandboxDoc {
  id?: string;
  name: string;
  labels?: Record<string, string>;
  phase?: OpenShellPhase | string;
  exit_code?: number | null;
  configuration_admission?: { state?: string; error?: string } | null;
}

export function parseSandboxDoc(out: string): OpenShellSandboxDoc {
  const doc = JSON.parse(out) as OpenShellSandboxDoc | { sandbox?: OpenShellSandboxDoc };
  // Tolerate an envelope; v0.1.2 `get -o json` prints the bare document.
  return 'sandbox' in doc && doc.sandbox ? doc.sandbox : (doc as OpenShellSandboxDoc);
}

export function parseSandboxList(out: string): { sandboxes: OpenShellSandboxDoc[]; nextPageToken: string } {
  const doc = JSON.parse(out) as { sandboxes?: OpenShellSandboxDoc[]; next_page_token?: string };
  return { sandboxes: doc.sandboxes ?? [], nextPageToken: doc.next_page_token ?? '' };
}

/**
 * OpenShell phase -> the coarse listing phase. Unknown means the gateway lost
 * track — the list cannot vouch for an end, so it is NOT dressed up as a
 * corpse (adoption would tear down a possibly-live session).
 */
export function listingPhase(phase: string | undefined): SessionPhase {
  switch (phase) {
    case 'Ready':
    case 'Stopping':
    case 'Unknown':
      return 'running';
    case 'Stopped':
    case 'Completed':
    case 'Error':
    case 'Deleting':
      return 'terminal';
    default: // Provisioning, Starting, Unspecified, anything newer
      return 'starting';
  }
}

/** The failure an ended sandbox recorded, if any. */
export function recordedFailure(doc: OpenShellSandboxDoc): SessionFailure | undefined {
  const exit = typeof doc.exit_code === 'number' ? doc.exit_code : undefined;
  if (doc.phase === 'Error') {
    if (doc.configuration_admission?.state === 'rejected') {
      return {
        kind: 'denied-by-policy',
        retryable: false,
        detail: doc.configuration_admission.error || 'configuration rejected',
      };
    }
    return { kind: 'started-then-died', retryable: false, ...(exit !== undefined ? { exitCode: exit } : {}) };
  }
  if ((doc.phase === 'Stopped' || doc.phase === 'Completed') && exit !== undefined && exit !== 0) {
    return { kind: 'started-then-died', retryable: false, exitCode: exit };
  }
  return undefined;
}

/** Per-handle truth read. Only `stopped`/`failed` are terminal to the session-events hub. */
export function handleStatus(doc: OpenShellSandboxDoc): SessionStatus {
  const failure = recordedFailure(doc);
  if (failure) return { phase: 'failed', failure };
  switch (doc.phase) {
    case 'Provisioning':
    case 'Starting':
    case 'Unspecified':
      return { phase: 'preparing' };
    case 'Stopped':
    case 'Completed':
    case 'Deleting':
      return { phase: 'stopped' };
    default: // Ready, Stopping, Unknown — not a confirmed end
      return { phase: 'running' };
  }
}

export function isTerminalPhase(phase: string | undefined): boolean {
  return listingPhase(phase) === 'terminal';
}

// ---------- errors ----------

/**
 * The SANDBOX does not exist (OpenShell: `message: "sandbox not found"`).
 * Deliberately narrow: other missing things — a provider, an image, an unknown
 * gateway — are configuration errors, and reading them as "sandbox gone" would
 * make every session look stopped.
 */
export function isNotFound(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /\bsandbox(?: '[^']*')? not found\b|\bno such sandbox\b/i.test(msg);
}

/** Create on a name the gateway already holds (CLI: AlreadyExists status). */
export function isAlreadyExists(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /already exists|AlreadyExists/i.test(msg);
}

const GATEWAY_CONFIG_HINT =
  'This is OpenShell gateway configuration (an operator fix, not a driver bug). Gateway said: ';

/**
 * The part of CLI stderr that explains the failure. The CLI prints advisory
 * warnings first (one per credential-looking `--env`, which NanoClaw's
 * gateway lane legitimately produces) and its `Error:` block last — so the
 * head of stderr is the wrong place to look: with a few warnings, the real
 * error starts well past 500 characters.
 */
export function cliErrorSummary(raw: string): string {
  const at = raw.lastIndexOf('Error:');
  const text = at >= 0 ? raw.slice(at) : raw.slice(-500);
  return text
    .replace(/\s*\n\s*│?\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

/**
 * Raw runtime errors never cross the seam — except where the gateway is
 * telling the OPERATOR what to change, which is passed through as the
 * denied-by-policy detail together with the exact setting to flip.
 */
export function normalizeOpenShellError(error: unknown, now: () => number = Date.now): SessionFailureError {
  const msg = cliErrorSummary(error instanceof Error ? error.message : String(error));
  const missingProvider = /provider '([^']+)' not found/i.exec(msg);
  if (missingProvider) {
    // A provider the policy file attaches but the OpenShell gateway does not
    // have. Retrying cannot fix it; the operator must create it or drop it.
    return specInvalid(
      `OpenShell provider '${missingProvider[1]}' is attached to this agent group but does not exist in OpenShell; ` +
        `create it (\`openshell provider create\`) or remove it from the group's providers in the OpenShell policy file. OpenShell said: ${msg}`,
    );
  }
  if (/reserved for the OpenShell workspace/i.test(msg)) {
    // The image's OCI WorkingDir is OpenShell's workspace root, and no mount may
    // cover it. NanoClaw's agent image sets WORKDIR /workspace/group while core
    // mounts the session at /workspace — so the stock image cannot be realized
    // as-is. The image is composition's to choose (drivers never build), so say
    // what to change rather than retrying a create that cannot succeed.
    return specInvalid(
      `a mount covers the image's working directory, which OpenShell reserves as its workspace root; ` +
        `use an agent image whose WORKDIR is outside every mount target (e.g. a derived image with WORKDIR /sandbox, ` +
        `selected via CONTAINER_IMAGE). OpenShell said: ${msg}`,
    );
  }
  if (/enable_bind_mounts|bind mounts? require/i.test(msg)) {
    return deniedByPolicy(
      `bind mounts are disabled on the OpenShell gateway; set [openshell.drivers.docker] enable_bind_mounts = true. ${GATEWAY_CONFIG_HINT}${msg}`,
    );
  }
  if (/allow_driver_config|driver config is disabled/i.test(msg)) {
    return deniedByPolicy(
      `driver config is disabled on the OpenShell gateway; set [openshell.drivers.docker] allow_driver_config = true. ${GATEWAY_CONFIG_HINT}${msg}`,
    );
  }
  if (/resource admission|not admitted|admission provenance/i.test(msg)) {
    return deniedByPolicy(
      `the OpenShell gateway's resource admission refused the sandbox's mounts; configure [openshell.drivers.docker.resource_admission] (label-based admission, or enabled = false). ${GATEWAY_CONFIG_HINT}${msg}`,
    );
  }
  const code = error instanceof OpenShellCliError ? error.exitCode : undefined;
  if (code === 'ENOENT' || /ENOENT|command not found/i.test(msg)) {
    return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }
  if (
    /connection refused|failed to connect|transport error|dns error|gateway.*(unreachable|unavailable)|Unavailable|timed out|ETIMEDOUT/i.test(
      msg,
    )
  ) {
    return asFailureError({ kind: 'runtime-unavailable', retryable: true });
  }
  if (/manifest unknown|pull access denied|No such image|image.*not found|failed to pull/i.test(msg)) {
    return asFailureError({ kind: 'image-unavailable', retryable: true });
  }
  if (/no space left|cannot allocate memory|resource ?exhausted|ResourceExhausted/i.test(msg)) {
    return asFailureError({ kind: 'resources-exhausted', retryable: true });
  }
  return asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `openshell-${now()}` });
}
