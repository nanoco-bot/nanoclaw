/**
 * OpenShell provider + provider-profile commands → `openshell` CLI argv, as
 * pure functions (no I/O). Used by `ncl openshell-provider-*` and by
 * `createArgs` (realize.ts) for the per-group `--provider` flags.
 *
 * Verified against NVIDIA/OpenShell `crates/openshell-cli/src/main.rs` (main,
 * 2026-10; "Providers v2"):
 *   sandbox create … --provider NAME (repeatable) [--no-auto-providers]
 *   sandbox provider list   NAME [-o table|json]
 *   sandbox provider attach NAME PROVIDER
 *   sandbox provider detach NAME PROVIDER
 *   provider get NAME
 *   provider profile list   [-o table|json|yaml] [--global]
 *   provider profile import -f FILE [--global]
 *   provider profile update ID -f FILE [--global]
 *
 * As with policy-commands.ts, the sandbox NAME is always explicit (the CLI
 * otherwise falls back to the last-used sandbox).
 */
import { assertSandboxName } from './policy-commands.js';

/**
 * Provider instance names, as `openshell provider create --name` accepts them
 * (the setup UI applies the same rule). Never starts with '-', so it can never
 * be read as a flag by the child CLI.
 */
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
/** Provider profile ids (`--type` values): lowercase. */
const PROFILE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function isProviderName(name: unknown): name is string {
  return typeof name === 'string' && PROVIDER_NAME.test(name);
}

export function assertProviderName(name: unknown): string {
  if (!isProviderName(name)) {
    throw new Error(
      `'${String(name)}' is not a valid OpenShell provider name (1-63 letters, digits, '.', '_' or '-', starting with a letter or digit)`,
    );
  }
  return name;
}

export function assertProfileId(id: unknown): string {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) {
    throw new Error(
      `'${String(id)}' is not a valid OpenShell provider profile id (lowercase letters, digits, '.', '_', '-')`,
    );
  }
  return id;
}

/** `--provider <name>` once per provider, in order, duplicates dropped. */
export function providerFlags(providers: readonly string[]): string[] {
  const out: string[] = [];
  for (const p of new Set(providers)) out.push('--provider', assertProviderName(p));
  return out;
}

export function sandboxProviderAttachArgs(sandbox: string, provider: string): string[] {
  return ['sandbox', 'provider', 'attach', assertSandboxName(sandbox), assertProviderName(provider)];
}

export function sandboxProviderDetachArgs(sandbox: string, provider: string): string[] {
  return ['sandbox', 'provider', 'detach', assertSandboxName(sandbox), assertProviderName(provider)];
}

export function sandboxProviderListArgs(sandbox: string, output: 'table' | 'json' = 'table'): string[] {
  return ['sandbox', 'provider', 'list', assertSandboxName(sandbox), '-o', output];
}

export function providerGetArgs(provider: string): string[] {
  return ['provider', 'get', assertProviderName(provider)];
}

export type ProfileOutput = 'table' | 'json' | 'yaml';

export function profileListArgs(opts: { output?: ProfileOutput; global?: boolean } = {}): string[] {
  const args = ['provider', 'profile', 'list', '-o', opts.output ?? 'table'];
  if (opts.global) args.push('--global');
  return args;
}

function filePath(file: string): string {
  if (typeof file !== 'string' || file.length === 0) throw new Error('a profile file path is required');
  if (file.startsWith('-')) throw new Error(`profile file path may not start with '-': ${file}`);
  if (/[\0\r\n]/.test(file)) throw new Error('profile file path may not contain control characters');
  return file;
}

export function profileImportArgs(file: string, opts: { global?: boolean } = {}): string[] {
  const args = ['provider', 'profile', 'import', '-f', filePath(file)];
  if (opts.global) args.push('--global');
  return args;
}

export function profileUpdateArgs(id: string, file: string, opts: { global?: boolean } = {}): string[] {
  const args = ['provider', 'profile', 'update', assertProfileId(id), '-f', filePath(file)];
  if (opts.global) args.push('--global');
  return args;
}

/** "Provider does not exist" from `provider get` (gRPC NotFound, CLI text varies by version). */
export function isProviderNotFound(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /not ?found|does not exist|no such provider|NotFound/i.test(msg);
}
