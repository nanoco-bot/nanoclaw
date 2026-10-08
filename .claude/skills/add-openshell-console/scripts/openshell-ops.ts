/**
 * What the console runs against OpenShell, as pure argv builders and
 * parsers, plus the one fan-out it needs: applying a group change to the
 * group's running sandboxes. The group's durable settings live in the policy
 * file (src/drivers/openshell/policy-file.ts); these commands change what is
 * running now.
 */
import type { EgressRule } from '../../../../src/drivers/openshell/policy.js';
import type { ModelCredentialKind } from '../../../../src/drivers/openshell/model-provider.js';
import { PROVIDER_NAME_RE } from '../../../../src/drivers/openshell/realize.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunOpenShell = (args: string[], env: Record<string, string>) => Promise<ExecResult>;

// ---------- providers ----------

export interface KeyValue {
  key: string;
  value: string;
}

const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Names that would change how the child `openshell` itself runs. */
const RESERVED_ENV =
  /^(PATH|HOME|USER|SHELL|PWD|TMPDIR|LANG|LC_\w+|LD_\w+|DYLD_\w+|NODE_\w+|OPENSHELL_\w+|NO_COLOR|XDG_\w+|DBUS_\w+)$/;

export function assertProviderName(name: unknown): string {
  const n = String(name ?? '').trim();
  if (!PROVIDER_NAME_RE.test(n))
    throw new Error('Provider name: 1-63 letters, digits, ".", "_" or "-", starting with a letter or digit');
  return n;
}

/**
 * `openshell provider create --name N --type T --credential KEY…`. Values go
 * in the child's environment (OpenShell's `--credential KEY` lookup form), so
 * no secret appears in argv or the process table.
 */
export function providerCreateInvocation(input: { name: unknown; type: unknown; credentials?: KeyValue[] }): {
  args: string[];
  env: Record<string, string>;
} {
  const name = assertProviderName(input.name);
  const type = String(input.type ?? '').trim();
  if (!PROFILE_ID.test(type)) throw new Error('Provider type must be a service type id');
  const args = ['provider', 'create', '--name', name, '--type', type];
  const env: Record<string, string> = {};
  for (const { key, value } of input.credentials ?? []) {
    const k = String(key ?? '').trim();
    if (!ENV_NAME.test(k)) throw new Error(`Credential name '${k}' must be an environment-variable name`);
    if (RESERVED_ENV.test(k)) throw new Error(`Credential name '${k}' is reserved`);
    if (k in env) throw new Error(`Credential '${k}' is given twice`);
    const v = String(value ?? '');
    if (!v || /[\0\r\n]/.test(v)) throw new Error(`Credential '${k}' needs a single-line value`);
    env[k] = v;
    args.push('--credential', k);
  }
  return { args, env };
}

export function sandboxProviderArgs(verb: 'attach' | 'detach', sandbox: string, name: string): string[] {
  return ['sandbox', 'provider', verb, sandbox, assertProviderName(name), '--wait', '--timeout', '25'];
}

/** `openshell provider list -o json` → name → {type, credential keys}. */
export function parseProviderList(json: string): Map<string, { type: string; credentialKeys: string[] }> {
  const out = new Map<string, { type: string; credentialKeys: string[] }>();
  try {
    const doc = JSON.parse(json) as { providers?: { name?: string; type?: string; credential_keys?: string[] }[] };
    for (const p of doc.providers ?? [])
      if (p.name) out.set(p.name, { type: p.type ?? '', credentialKeys: p.credential_keys ?? [] });
  } catch {
    // an unreadable listing shows names without types
  }
  return out;
}

// ---------- network rules ----------

const RULE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const HOST = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/;
const BINARY = /^\/[A-Za-z0-9._+/@*-]{1,255}$/;

/** A network rule from form input, validated (the policy file parser re-checks its shape on write). */
export function egressRule(input: { name: unknown; host: unknown; ports: unknown; binaries: unknown }): EgressRule {
  const name = String(input.name ?? '').trim();
  if (!RULE_NAME.test(name)) throw new Error('Rule name: letters, digits, "_" or "-", at most 63');
  if (name.startsWith('_provider_')) throw new Error("Rule names starting with '_provider_' belong to OpenShell");
  const host = String(input.host ?? '').trim();
  if (!HOST.test(host)) throw new Error(`'${host}' is not a host name`);
  const ports = String(input.ports ?? '')
    .split(',')
    .map((p) => Number(p.trim()));
  if (ports.length === 0 || !ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536))
    throw new Error('Ports must be TCP port numbers, comma-separated');
  const binaries = (Array.isArray(input.binaries) ? input.binaries : [input.binaries])
    .map((b) => String(b ?? '').trim())
    .filter(Boolean);
  if (binaries.length === 0) throw new Error('Pick at least one program allowed to connect');
  for (const b of binaries) if (!BINARY.test(b)) throw new Error(`'${b}' is not an absolute program path`);
  return { name, host, ports, binaries };
}

/** One `openshell policy update` per port, as `openshell policy update --add-endpoint` takes one endpoint. */
export function addRuleArgs(sandbox: string, rule: EgressRule): string[][] {
  return rule.ports.map((port) => [
    'policy',
    'update',
    sandbox,
    '--add-endpoint',
    `${rule.host}:${port}`,
    ...rule.binaries.flatMap((b) => ['--binary', b]),
    '--rule-name',
    rule.name,
  ]);
}

export function removeRuleArgs(sandbox: string, name: string): string[] {
  return ['policy', 'update', sandbox, '--remove-rule', name];
}

// ---------- blocked requests (OpenShell rule proposals) ----------

export type RuleStatus = 'pending' | 'approved' | 'rejected';

export function ruleGetArgs(sandbox: string, status: unknown): string[] {
  const st = String(status || 'pending');
  if (!['pending', 'approved', 'rejected'].includes(st))
    throw new Error('status must be pending, approved or rejected');
  return ['rule', 'get', sandbox, '--status', st];
}

export function ruleDecideArgs(
  decision: 'approve' | 'reject',
  sandbox: string,
  chunkId: unknown,
  reason?: unknown,
): string[] {
  const id = String(chunkId ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) throw new Error('A chunk id is required');
  if (decision === 'approve') return ['rule', 'approve', sandbox, '--chunk-id', id];
  const why = String(reason ?? '').trim() || 'denied from the console';
  return ['rule', 'reject', sandbox, '--chunk-id', id, '--reason', why];
}

export interface RuleChunk {
  chunkId: string;
  status?: string;
  rule?: string;
  binary?: string;
  rationale?: string;
  /** `host:port [L4], …` as OpenShell prints it. */
  endpoints?: string;
  hits?: string;
}

const CHUNK_FIELDS: Record<string, keyof RuleChunk> = {
  status: 'status',
  rule: 'rule',
  binary: 'binary',
  rationale: 'rationale',
  endpoints: 'endpoints',
  hits: 'hits',
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `openshell rule get` text: blocks of `  Chunk: <id>` then `  Field: value` lines; anything else is ignored. */
export function parseRuleChunks(text: string): RuleChunk[] {
  const chunks: RuleChunk[] = [];
  let current: RuleChunk | undefined;
  for (const raw of String(text ?? '')
    .replace(ANSI, '')
    .split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
    if (!m) continue;
    const label = m[1].trim().toLowerCase();
    if (label === 'chunk') {
      current = { chunkId: m[2].trim() };
      chunks.push(current);
    } else if (current && CHUNK_FIELDS[label] && current[CHUNK_FIELDS[label]] === undefined) {
      (current as unknown as Record<string, string>)[CHUNK_FIELDS[label]] = m[2].trim();
    }
  }
  return chunks;
}

/** `public-api.granola.ai:443 [L4], b.io:8443` → [{host, port}]. */
export function chunkEndpoints(chunk: RuleChunk): { host: string; port: number }[] {
  return String(chunk.endpoints ?? '')
    .split(',')
    .map((part) => part.replace(/\[[^\]]*\]/g, '').trim())
    .map((part) => part.match(/^([^\s:]+):(\d{1,5})$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ host: m[1], port: Number(m[2]) }));
}

// ---------- live apply ----------

export interface LiveResult {
  sandbox: string;
  ok: boolean;
  error?: string;
}

/**
 * Run each sandbox's commands in turn; a sandbox's first failure is its error.
 * Never throws: the durable change is already saved, and every sandbox is
 * reported applied or failed.
 */
export async function applyLive(
  sandboxes: readonly string[],
  steps: (sandbox: string) => string[][],
  run: RunOpenShell,
): Promise<LiveResult[]> {
  const results: LiveResult[] = [];
  for (const sandbox of sandboxes) {
    let error: string | undefined;
    for (const args of steps(sandbox)) {
      const r = await run(args, {});
      if (r.code !== 0) {
        error = (r.stderr || r.stdout).trim().split('\n').pop() || `exit ${r.code}`;
        break;
      }
    }
    results.push(error === undefined ? { sandbox, ok: true } : { sandbox, ok: false, error });
  }
  return results;
}

// ---------- the Claude credential (scripts/auth.ts) ----------

/** Every variable auth.ts reads, in its precedence order. */
export const CREDENTIAL_INPUT_VARS = [
  'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NANOCLAW_ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

const SAFE_VALUE = /^[A-Za-z0-9._~+/=-]+$/;
const PREFIX: Record<ModelCredentialKind, string> = { oauth: 'sk-ant-oat', 'api-key': 'sk-ant-api' };

/** Environment for `auth.ts claude`: every input variable cleared, then exactly the submitted one set. */
export function credentialScriptEnv(
  submission: { kind: unknown; value: unknown },
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const kind = submission?.kind;
  if (kind !== 'oauth' && kind !== 'api-key') throw new Error("Credential kind must be 'oauth' or 'api-key'");
  const value = String(submission.value ?? '').replace(/\s+/g, '');
  if (!value.startsWith(PREFIX[kind])) throw new Error(`Must start with ${PREFIX[kind]}`);
  if (!SAFE_VALUE.test(value)) throw new Error('The value has characters a credential never contains');
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const name of CREDENTIAL_INPUT_VARS) delete env[name];
  env[kind === 'oauth' ? 'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN' : 'NANOCLAW_ANTHROPIC_API_KEY'] = value;
  return env;
}

/** `credentialSource` from setup/verify.ts checkCredentials() is `<source>:<kind>`. */
export function parseCredentialSource(credentialSource: string): { source: string; kind: string } {
  const i = credentialSource.lastIndexOf(':');
  return i < 0
    ? { source: credentialSource || 'unknown', kind: 'unknown' }
    : { source: credentialSource.slice(0, i), kind: credentialSource.slice(i + 1) };
}
