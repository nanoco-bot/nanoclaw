/**
 * `ncl openshell-policy-*` → `openshell` CLI argv, as pure functions.
 *
 * Verified against NVIDIA/OpenShell v0.1.2 `crates/openshell-cli/src/main.rs`:
 *   policy get    [NAME] [--full|--base] [-o table|json] [--rev N] [--global]
 *   policy update [NAME] --add-endpoint/--remove-endpoint/--add-allow/--add-deny/
 *                 --remove-rule (repeatable) --binary (repeatable) --rule-name
 *                 --any-binary --endpoint-path --dry-run --wait --timeout
 *   rule get      [NAME] [--status pending|approved|rejected]   (hidden, alias `rl`)
 *   rule approve  [NAME] --chunk-id ID
 *   rule reject   [NAME] --chunk-id ID [--reason TEXT]
 *
 * NAME is always passed explicitly: when omitted the CLI falls back to the
 * LAST-USED sandbox, which on a host running many sessions is whichever one
 * somebody touched last — never what an operator command should act on.
 *
 * Scope (OpenShell RFC 0002): live draft proposals (`rule …`) cover
 * `network_policies` ONLY. Filesystem / Landlock / process policy is fixed at
 * sandbox start; `policy get` / `policy update` read and edit the full policy
 * document directly, without the proposal flow.
 */

const SANDBOX_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export function assertSandboxName(name: string): string {
  if (!SANDBOX_NAME.test(name) || name.length > 63) {
    throw new Error(`'${name}' is not a valid OpenShell sandbox name (lowercase DNS label)`);
  }
  return name;
}

/** A value that must not be read as a flag by the child CLI. */
function value(flag: string, v: string): string {
  if (v.startsWith('-')) throw new Error(`${flag} value may not start with '-': ${v}`);
  return v;
}

export interface PolicyViewOptions {
  output?: 'table' | 'json';
  /** Base policy without provider-composed entries (default: full effective policy). */
  base?: boolean;
  rev?: number;
}

export function policyViewArgs(sandbox: string, opts: PolicyViewOptions = {}): string[] {
  const args = ['policy', 'get', assertSandboxName(sandbox), opts.base ? '--base' : '--full'];
  if (opts.rev !== undefined) {
    if (!Number.isInteger(opts.rev) || opts.rev < 0) throw new Error('--rev must be a non-negative integer');
    if (opts.rev > 0) args.push('--rev', String(opts.rev));
  }
  args.push('-o', opts.output ?? 'table');
  return args;
}

export type RuleStatus = 'pending' | 'approved' | 'rejected';

export function ruleListArgs(sandbox: string, status: RuleStatus = 'pending'): string[] {
  return ['rule', 'get', assertSandboxName(sandbox), '--status', status];
}

export function ruleApproveArgs(sandbox: string, chunkId: string): string[] {
  return ['rule', 'approve', assertSandboxName(sandbox), '--chunk-id', value('--chunk-id', chunkId)];
}

export function ruleRejectArgs(sandbox: string, chunkId: string, reason: string): string[] {
  return ['rule', 'reject', assertSandboxName(sandbox), '--chunk-id', value('--chunk-id', chunkId), '--reason', reason];
}

export interface PolicyUpdateOptions {
  addEndpoint?: string[];
  removeEndpoint?: string[];
  addAllow?: string[];
  addDeny?: string[];
  removeRule?: string[];
  binary?: string[];
  ruleName?: string;
  anyBinary?: boolean;
  endpointPath?: string;
  dryRun?: boolean;
  wait?: boolean;
  timeout?: number;
}

const REPEATABLE: [keyof PolicyUpdateOptions, string][] = [
  ['addEndpoint', '--add-endpoint'],
  ['removeEndpoint', '--remove-endpoint'],
  ['addAllow', '--add-allow'],
  ['addDeny', '--add-deny'],
  ['removeRule', '--remove-rule'],
];

export function policyUpdateArgs(sandbox: string, opts: PolicyUpdateOptions): string[] {
  const args = ['policy', 'update', assertSandboxName(sandbox)];
  let mutations = 0;
  for (const [key, flag] of REPEATABLE) {
    for (const v of (opts[key] as string[] | undefined) ?? []) {
      args.push(flag, value(flag, v));
      mutations++;
    }
  }
  if (mutations === 0) {
    throw new Error(
      'nothing to change: give at least one of --add-endpoint, --remove-endpoint, --add-allow, --add-deny, --remove-rule',
    );
  }
  if (opts.anyBinary && opts.binary?.length) throw new Error('--any-binary and --binary are mutually exclusive');
  for (const b of opts.binary ?? []) args.push('--binary', value('--binary', b));
  if (opts.ruleName) args.push('--rule-name', value('--rule-name', opts.ruleName));
  if (opts.anyBinary) args.push('--any-binary');
  if (opts.endpointPath !== undefined) args.push('--endpoint-path', opts.endpointPath);
  if (opts.dryRun) args.push('--dry-run');
  if (opts.wait) args.push('--wait');
  if (opts.timeout !== undefined) {
    if (!Number.isInteger(opts.timeout) || opts.timeout <= 0) throw new Error('--timeout must be a positive integer');
    args.push('--timeout', String(opts.timeout));
  }
  return args;
}

/**
 * One flag value or a JSON array of them. ncl keeps one value per flag, and
 * OpenShell rule specs contain commas (`host:443,8443:GET:/x`), so splitting
 * on commas would corrupt them; repeat a flag by passing a JSON array.
 */
export function repeated(v: unknown, flag: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v !== 'string') throw new Error(`${flag} requires a value`);
  const trimmed = v.trim();
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${flag}: not a valid JSON array`, { cause: err });
    }
    if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === 'string')) {
      throw new Error(`${flag}: JSON value must be an array of strings`);
    }
    return parsed;
  }
  return [v];
}

export type ProposalsState = 'enabled' | 'disabled' | 'unset' | 'unknown';

export const PROPOSALS_SETTING = 'agent_policy_proposals_enabled';

/**
 * Reads `openshell settings get <sandbox> --json`
 * (`{"settings": {"<key>": {"value": …, "scope": …}}}` on v0.1.2). Anything
 * not recognizably on is reported as such — never assumed on.
 */
export function proposalsState(settingsJson: string): ProposalsState {
  let doc: unknown;
  try {
    doc = JSON.parse(settingsJson);
  } catch {
    return 'unknown';
  }
  const settings = (doc as { settings?: Record<string, unknown> } | null)?.settings;
  if (!settings || typeof settings !== 'object') return 'unknown';
  const entry = settings[PROPOSALS_SETTING] as { value?: unknown; scope?: unknown } | undefined;
  if (!entry) return 'unset';
  if (entry.scope === 'unset') return 'unset';
  const v = String(entry.value ?? '')
    .trim()
    .toLowerCase();
  if (['true', 'yes', '1', 'on'].includes(v)) return 'enabled';
  if (['false', 'no', '0', 'off'].includes(v)) return 'disabled';
  return 'unknown';
}

/**
 * What the setting means for this list (OpenShell RFC 0002): it gates only
 * AGENT-authored proposals — the in-sandbox `policy.local` skill and routes.
 * Connections OpenShell denies still produce proposals with it off, so the
 * list is not empty just because the setting is.
 */
export function proposalsNote(state: ProposalsState): string | undefined {
  switch (state) {
    case 'enabled':
      return undefined;
    case 'disabled':
    case 'unset':
      return (
        `Proposals here come from connections OpenShell denied. ${PROPOSALS_SETTING} is ` +
        `${state === 'unset' ? 'not set (default: off)' : 'off'} for this sandbox, so the agent cannot draft rules ` +
        'itself; turn it on at the OpenShell gateway to let it ' +
        `(e.g. \`openshell settings set --global --key ${PROPOSALS_SETTING} --value true\`).`
      );
    case 'unknown':
      return `Could not read ${PROPOSALS_SETTING} for this sandbox, so whether the agent can draft rules itself is unknown.`;
  }
}
