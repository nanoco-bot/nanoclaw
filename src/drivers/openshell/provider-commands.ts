/**
 * `ncl openshell-provider-*` / `openshell-network-*` → `openshell` CLI argv and
 * validated inputs, as pure functions (same discipline as policy-commands.ts).
 *
 * Verified against NVIDIA/OpenShell v0.1.2 `openshell provider create --help`:
 *   provider create --name N --type T [--credential KEY[=VALUE]]... [--config K=V]...
 *   provider get N
 * Credentials always use the env-lookup form `--credential KEY` with the value
 * in the child's environment: the secret never appears in argv (readable by
 * every local user in /proc/<pid>/cmdline) and never in NanoClaw's DB or logs.
 */
import { assertEgressRule, GATEWAY_RULE_NAME, type EgressRule } from './policy.js';
import { PROVIDER_NAME_RE } from './realize.js';

/** OpenShell provider type / profile id. */
const PROVIDER_TYPE_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONFIG_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
/** Names that would change how the `openshell` child itself runs. */
const RESERVED_ENV =
  /^(PATH|HOME|USER|SHELL|PWD|TMPDIR|LANG|LC_\w+|LD_\w+|DYLD_\w+|NODE_\w+|OPENSHELL_\w+|NO_COLOR|XDG_\w+|DBUS_\w+)$/;

export function assertProviderName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!PROVIDER_NAME_RE.test(n)) {
    throw new Error(
      `'${String(name)}' is not a valid OpenShell provider name (1-63 letters, digits, '.', '_' or '-', starting with a letter or digit)`,
    );
  }
  return n;
}

export function assertProviderType(type: unknown): string {
  const t = typeof type === 'string' ? type.trim() : '';
  if (!PROVIDER_TYPE_RE.test(t)) {
    throw new Error(
      `'${String(type)}' is not a valid OpenShell provider type (lowercase letters, digits, '.', '_', '-')`,
    );
  }
  return t;
}

/** A JSON object of string → string (credentials or config), from a flag or `--stdin-json`. Values are never echoed. */
export function stringMap(value: unknown, what: string): Record<string, string> {
  if (value === undefined || value === null) return {};
  let v = value;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      // No cause on purpose: V8's JSON error quotes the input, which holds credential values.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`${what} must be a JSON object of name → value`);
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be a JSON object of name → value`);
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string' || val.length === 0) throw new Error(`${what} '${k}' needs a non-empty string value`);
    if (/[\0\r\n]/.test(val)) throw new Error(`${what} '${k}' value may not contain newlines`);
    out[k] = val;
  }
  return out;
}

export interface ProviderCreate {
  /** argv: credential KEY NAMES only. */
  args: string[];
  /** Child environment: where the credential VALUES travel. */
  env: Record<string, string>;
}

export function providerCreateInvocation(input: {
  name: string;
  type: string;
  credentials?: Record<string, string>;
  config?: Record<string, string>;
}): ProviderCreate {
  const args = [
    'provider',
    'create',
    '--name',
    assertProviderName(input.name),
    '--type',
    assertProviderType(input.type),
  ];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.credentials ?? {})) {
    if (!ENV_NAME_RE.test(key)) throw new Error(`credential name '${key}' must be an environment-variable name`);
    if (RESERVED_ENV.test(key))
      throw new Error(`credential name '${key}' is reserved; use the provider's own variable`);
    env[key] = value;
    args.push('--credential', key);
  }
  for (const [key, value] of Object.entries(input.config ?? {})) {
    if (!CONFIG_KEY_RE.test(key)) throw new Error(`config key '${key}' may only use letters, digits, '_', '.', '-'`);
    if (value.startsWith('-')) throw new Error(`config '${key}' value may not start with '-'`);
    args.push('--config', `${key}=${value}`);
  }
  return { args, env };
}

export function providerGetArgs(name: string): string[] {
  return ['provider', 'get', assertProviderName(name)];
}

/** OpenShell's own wait for a live attach/detach, kept under the 30 s CLI timeout so its error is the one reported. */
export const SANDBOX_PROVIDER_WAIT_S = 25;

/**
 * `openshell sandbox provider attach|detach <sandbox> <provider> --wait`: change
 * a RUNNING sandbox's providers. `--wait` returns once the sandbox has applied
 * the provider's credentials, policy and environment for new processes, so
 * success means it took effect, not just that it was saved.
 */
export function sandboxProviderArgs(verb: 'attach' | 'detach', sandbox: string, name: string): string[] {
  return [
    'sandbox',
    'provider',
    verb,
    sandbox,
    assertProviderName(name),
    '--wait',
    '--timeout',
    String(SANDBOX_PROVIDER_WAIT_S),
  ];
}

/** One group network rule from CLI input, in the EgressRule shape compilePolicy() consumes. */
export function groupEgressRule(input: {
  name: unknown;
  host: unknown;
  ports: unknown;
  binaries: unknown;
}): EgressRule {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const host = typeof input.host === 'string' ? input.host.trim() : '';
  const ports = numberList(input.ports, '--ports');
  const binaries = stringList(input.binaries, '--binary');
  const rule: EgressRule = { name, host, ports, binaries };
  try {
    assertEgressRule(rule);
  } catch (err) {
    throw new Error((err as { detail?: string }).detail ?? (err as Error).message, { cause: err });
  }
  if (/[:/]/.test(host)) throw new Error(`--host '${host}' must be a bare host name (ports go in --ports)`);
  if (name.startsWith('_provider_') || name === GATEWAY_RULE_NAME)
    throw new Error(`rule name '${name}' is reserved (OpenShell provider rules / the NanoClaw model relay)`);
  return rule;
}

/** `443`, `443,8443`, `[443,8443]` or a number. */
function numberList(v: unknown, flag: string): number[] {
  const parts = Array.isArray(v)
    ? v
    : typeof v === 'number'
      ? [v]
      : String(v ?? '')
          .trim()
          .replace(/^\[|\]$/g, '')
          .split(',');
  const nums = parts.filter((p) => String(p).trim() !== '').map((p) => Number(String(p).trim()));
  if (nums.length === 0 || nums.some((n) => !Number.isInteger(n)))
    throw new Error(`${flag} needs TCP ports, e.g. 443 or 443,8443`);
  return [...new Set(nums)];
}

/** One value or a JSON array of them (values may contain commas, so no comma split). */
function stringList(v: unknown, flag: string): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${flag} is required`);
  const t = v.trim();
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
    } catch {
      // fall through
    }
    throw new Error(`${flag}: not a JSON array of strings`);
  }
  return [t];
}
