/**
 * Pure builders for everything the OpenShell setup UI runs. No I/O here:
 * exec.ts executes what these return, and the tests pin them.
 *
 *  - providers: raw upstream `openshell provider create|get|list` (NanoClaw has
 *    no provider wrapper, deliberately);
 *  - credential: the add-openshell skill's own `scripts/auth.ts`, driven
 *    non-interactively through its supported env vars;
 *  - policy: request frames for the existing `ncl openshell-policy-*` commands
 *    (src/cli/resources/openshell-policy.ts), dispatched in-process.
 */
import { assertSafeCredential, type CredentialKind } from '../../../../../setup/lib/openshell-credential.js';
import { findProfile, type ProfileTemplate } from './profiles.js';

// ---------------------------------------------------------------------------
// openshell provider create / get / list
// ---------------------------------------------------------------------------

export interface KeyValue {
  key: string;
  value: string;
}

export interface ProviderCreateInput {
  name: string;
  type: string;
  credentials?: KeyValue[];
  config?: KeyValue[];
  globalProfile?: boolean;
}

export interface Invocation {
  args: string[];
  /** Extra environment for the child — where credential VALUES travel. */
  env: Record<string, string>;
}

const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Env names a credential may not take: they would change how the child
 * `openshell` process itself runs (loader, PATH, its own gateway selection).
 */
const RESERVED_ENV =
  /^(PATH|HOME|USER|SHELL|PWD|TMPDIR|LANG|LC_\w+|LD_\w+|DYLD_\w+|NODE_\w+|OPENSHELL_\w+|NO_COLOR|XDG_\w+|DBUS_\w+)$/;

function checkValue(what: string, value: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${what} needs a value`);
  if (/[\0\r\n]/.test(value)) throw new Error(`${what} value may not contain newlines`);
  return value;
}

/**
 * `openshell provider create --name N --type T [--credential KEY]... [--config K=V]... [--global-profile]`
 *
 * Credentials use OpenShell's documented env-lookup form (`--credential KEY`,
 * value read from the child's environment — `parse_credential_pairs` in
 * openshell-cli) instead of `--credential KEY=VALUE`: same result at the
 * gateway, but the secret never appears in the process table
 * (/proc/<pid>/cmdline is readable by every local user). Config values are
 * not secrets and go on argv as `KEY=VALUE`.
 */
export function providerCreateInvocation(input: ProviderCreateInput): Invocation {
  const name = String(input.name ?? '').trim();
  const type = String(input.type ?? '').trim();
  if (!PROVIDER_NAME.test(name))
    throw new Error('Provider name: 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit');
  if (!PROFILE_ID.test(type))
    throw new Error('Provider type must be a profile id (lowercase letters, digits, ".", "_", "-")');

  const args = ['provider', 'create', '--name', name, '--type', type];
  const env: Record<string, string> = {};
  for (const { key, value } of input.credentials ?? []) {
    const k = String(key ?? '').trim();
    if (!ENV_NAME.test(k)) throw new Error(`Credential name '${k}' must be an environment-variable name (A-Z, 0-9, _)`);
    if (RESERVED_ENV.test(k))
      throw new Error(`Credential name '${k}' is reserved; use the provider's own variable name`);
    if (k in env) throw new Error(`Credential '${k}' is given twice`);
    env[k] = checkValue(`Credential '${k}'`, value);
    args.push('--credential', k);
  }
  const seenConfig = new Set<string>();
  for (const { key, value } of input.config ?? []) {
    const k = String(key ?? '').trim();
    if (!CONFIG_KEY.test(k)) throw new Error(`Config key '${k}' may only use letters, digits, "_", "." and "-"`);
    if (seenConfig.has(k)) throw new Error(`Config '${k}' is given twice`);
    seenConfig.add(k);
    args.push('--config', `${k}=${checkValue(`Config '${k}'`, value)}`);
  }
  if (input.globalProfile) args.push('--global-profile');
  return { args, env };
}

/** Credential keys the selected profile (shipped or custom) declares that the form did not fill — a hint, not a refusal. */
export function missingDeclaredCredentials(
  input: ProviderCreateInput,
  templates?: readonly ProfileTemplate[],
): string[] {
  const declared = findProfile(String(input.type ?? '').trim(), templates)?.credentialKeys ?? [];
  const given = new Set((input.credentials ?? []).map((c) => String(c.key).trim()));
  return declared.filter((k) => !given.has(k));
}

export function providerGetArgs(name: string): string[] {
  const n = String(name ?? '').trim();
  if (!PROVIDER_NAME.test(n)) throw new Error('Invalid provider name');
  return ['provider', 'get', n];
}

export function providerListArgs(): string[] {
  return ['provider', 'list'];
}

// ---------------------------------------------------------------------------
// Claude credential: the add-openshell skill's scripts/auth.ts
// ---------------------------------------------------------------------------

/** Every variable auth.ts's suppliedCredential() reads, in its precedence order. */
export const CREDENTIAL_INPUT_VARS = [
  'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NANOCLAW_ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

export interface CredentialSubmission {
  kind: CredentialKind;
  value: string;
}

const PREFIX: Record<CredentialKind, string> = { oauth: 'sk-ant-oat', 'api-key': 'sk-ant-api' };

/**
 * Environment for `auth.ts claude`: every credential input variable cleared
 * (an inherited CLAUDE_CODE_OAUTH_TOKEN would otherwise win over a submitted
 * API key — OAuth comes first in auth.ts's precedence), then exactly one set.
 * Same prefix rule auth.ts's own prompt applies.
 */
export function credentialScriptEnv(
  submission: CredentialSubmission,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const kind = submission?.kind;
  if (kind !== 'oauth' && kind !== 'api-key') throw new Error("Credential kind must be 'oauth' or 'api-key'");
  const value = String(submission.value ?? '').replace(/\s+/g, '');
  if (!value.startsWith(PREFIX[kind])) throw new Error(`Must start with ${PREFIX[kind]}`);
  assertSafeCredential({ kind, value });
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const name of CREDENTIAL_INPUT_VARS) delete env[name];
  env[kind === 'oauth' ? 'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN' : 'NANOCLAW_ANTHROPIC_API_KEY'] = value;
  return env;
}

/** `node --import <tsx loader> <skill>/scripts/auth.ts claude` — no pnpm on the service PATH needed. */
export function credentialScriptArgs(tsxLoaderUrl: string, authScriptPath: string): string[] {
  return ['--import', tsxLoaderUrl, authScriptPath, 'claude'];
}

/** `credentialSource` from setup/verify.ts checkCredentials() is `<source>:<kind>`. */
export function parseCredentialSource(credentialSource: string): { source: string; kind: string } {
  const i = credentialSource.lastIndexOf(':');
  return i < 0
    ? { source: credentialSource || 'unknown', kind: 'unknown' }
    : { source: credentialSource.slice(0, i), kind: credentialSource.slice(i + 1) };
}

// ---------------------------------------------------------------------------
// ncl openshell-policy-* request frames
// ---------------------------------------------------------------------------

export interface PolicyFrame {
  command: string;
  args: Record<string, unknown>;
}

export type RuleStatus = 'pending' | 'approved' | 'rejected';
const STATUSES: readonly RuleStatus[] = ['pending', 'approved', 'rejected'];

function sandboxArg(sandbox: unknown): string {
  const s = String(sandbox ?? '').trim();
  if (!s) throw new Error('A sandbox name is required');
  return s; // the resource itself validates the DNS-label shape
}

export function policyListFrame(sandbox: unknown, status: unknown = 'pending'): PolicyFrame {
  const st = String(status || 'pending') as RuleStatus;
  if (!STATUSES.includes(st)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  return { command: 'openshell-policy-list', args: { sandbox: sandboxArg(sandbox), status: st } };
}

export function policyApproveFrame(sandbox: unknown, chunkId: unknown): PolicyFrame {
  const id = String(chunkId ?? '').trim();
  if (!id) throw new Error('A chunk id is required');
  return { command: 'openshell-policy-approve', args: { sandbox: sandboxArg(sandbox), chunk_id: id } };
}

export function policyRejectFrame(sandbox: unknown, chunkId: unknown, reason: unknown): PolicyFrame {
  const id = String(chunkId ?? '').trim();
  const why = String(reason ?? '').trim();
  if (!id) throw new Error('A chunk id is required');
  if (!why) throw new Error('A reason is required to reject');
  return { command: 'openshell-policy-reject', args: { sandbox: sandboxArg(sandbox), chunk_id: id, reason: why } };
}

export function policyViewFrame(sandbox: unknown): PolicyFrame {
  return { command: 'openshell-policy-view', args: { sandbox: sandboxArg(sandbox), output: 'json' } };
}

// ---------------------------------------------------------------------------
// Lenient parse of `openshell rule get` text (v0.1.2 run.rs sandbox_draft_get)
// ---------------------------------------------------------------------------

export interface RuleChunk {
  chunkId: string;
  status?: string;
  rule?: string;
  binary?: string;
  confidence?: string;
  rationale?: string;
  security?: string;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Blocks of `  Chunk: <id>` followed by `  Field: value` lines. Anything it
 * does not recognize is ignored — the raw text is always shown next to it.
 */
export function parseRuleChunks(text: string): RuleChunk[] {
  const chunks: RuleChunk[] = [];
  let current: RuleChunk | undefined;
  const fields: Record<string, keyof RuleChunk> = {
    status: 'status',
    rule: 'rule',
    binary: 'binary',
    confidence: 'confidence',
    rationale: 'rationale',
    security: 'security',
  };
  for (const raw of String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (label === 'chunk') {
      current = { chunkId: value };
      chunks.push(current);
    } else if (current && fields[label] && current[fields[label]] === undefined) {
      (current as unknown as Record<string, string>)[fields[label]] = value;
    }
  }
  return chunks.filter((c) => c.chunkId);
}
