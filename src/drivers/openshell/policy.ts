/**
 * SessionSpec -> OpenShell realization, as pure functions.
 *
 * Two artifacts come out of one agent ContainerSpec, and they must agree:
 *
 * 1. The sandbox's OWN filesystem policy (`--policy <yaml>`). OpenShell's
 *    Landlock layer denies every path the policy does not list — including the
 *    target of a bind mount. A mount the policy does not grant is attached but
 *    unusable, and a policy without the base system dirs cannot even exec a
 *    binary ("Permission denied"). Verified empirically on v0.1.2.
 * 2. The Docker compute-driver attachment (`--driver-config-json`): one `bind`
 *    entry per MountSpec, `read_only` from the declared mode.
 *
 * Nothing in here decides anything the spec did not state (the seam rule:
 * "drivers never compute, look up, or decide"). Mount mode comes from the
 * spec; container paths are the spec's container paths, verbatim. The only
 * inputs that are not in the spec are operator-level driver options (base
 * system dirs, the optional gateway egress rule), and those are explicit.
 */
import {
  deniedByPolicy,
  specInvalid,
  type ContainerSpec,
  type MountClass,
  type MountSpec,
  type SessionSpec,
} from './seam.js';

/** The base-system grant verified to let binaries exec inside a v0.1.2 sandbox. */
export const DEFAULT_BASE_READ_ONLY: readonly string[] = ['/usr', '/bin', '/lib', '/lib64', '/etc'];
export const DEFAULT_BASE_READ_WRITE: readonly string[] = [];

/** OpenShell policy schema limits (docs/how-it-works/policies/schema.mdx @ v0.1.2). */
const MAX_POLICY_PATHS = 256;
const MAX_PATH_BYTES = 4096;

export const GATEWAY_RULE_NAME = 'nanoclaw_gateway';

export interface PolicyOptions {
  /** Read-only system paths every sandbox needs to exec anything. */
  baseReadOnly?: readonly string[];
  /** Read-write scratch paths (e.g. `/tmp`) the image needs. Empty by default — the verified minimal shape. */
  baseReadWrite?: readonly string[];
  /** `filesystem_policy.include_workdir`. Default true (verified shape). */
  includeWorkdir?: boolean;
  /**
   * Omitted by default, which leaves OpenShell's `best_effort` — under which a
   * kernel that cannot enforce Landlock runs the sandbox WITHOUT filesystem
   * rules (logged, not fatal). `hard_requirement` fails the sandbox instead.
   */
  landlockCompatibility?: 'best_effort' | 'hard_requirement';
  /**
   * Realizes `spec.networkAccess` as one network rule. The intent carries a
   * destination name but no port or binary list, and OpenShell rules need
   * both, so the operator supplies them here. Unset = no network rule at all,
   * i.e. OpenShell's default deny: the session fails CLOSED (cannot reach the
   * gateway), never open.
   */
  gatewayEgress?: {
    ports: number[];
    /** Executables allowed to open the connection (real paths, globs allowed). */
    binaries: string[];
    /** Override the destination host (e.g. `host.openshell.internal`); default `spec.networkAccess.endpoint`. */
    host?: string;
  };
  /**
   * Additional named egress allow rules, one OpenShell `network_policies`
   * entry each. This is how per-agent third-party access is expressed: the
   * same spec composed for two agent groups yields different reachable
   * destinations because the operator's per-group options differ (see
   * `group-policy.ts`), never because the driver decided anything.
   * Emitted only for `network: 'shared-private'`; `network: 'none'` gets no rules.
   */
  egress?: readonly EgressRule[];
}

export interface EgressRule {
  /** Rule key/name. `[A-Za-z0-9][A-Za-z0-9_-]*`, <=63 bytes; `_provider_*` is reserved by OpenShell. */
  name: string;
  host: string;
  ports: readonly number[];
  /** Executables allowed to open the connection, or any of their ancestors (OpenShell binary matching). */
  binaries: readonly string[];
}

const RULE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

/** Refuse a rule OpenShell would reject (or that would silently match nothing). */
export function assertEgressRule(rule: EgressRule): void {
  if (!RULE_NAME_RE.test(rule.name)) throw specInvalid(`egress rule name '${rule.name}' must match ${RULE_NAME_RE}`);
  if (!rule.host || /\s/.test(rule.host))
    throw specInvalid(`egress rule '${rule.name}' needs a host without whitespace`);
  if (rule.ports.length === 0 || !rule.ports.every((p) => Number.isInteger(p) && p > 0 && p < 65536)) {
    throw specInvalid(`egress rule '${rule.name}' needs TCP ports in 1..65535`);
  }
  // An empty binaries list matches no executable in OpenShell — a rule that
  // looks like an allow but allows nothing. Refuse rather than mislead.
  if (rule.binaries.length === 0) throw specInvalid(`egress rule '${rule.name}' needs at least one binary`);
  for (const b of rule.binaries) {
    if (!b.startsWith('/')) throw specInvalid(`egress rule '${rule.name}' binary '${b}' must be an absolute path`);
  }
}

export interface CompiledPolicy {
  version: 1;
  filesystem_policy: {
    include_workdir: boolean;
    read_only: string[];
    read_write: string[];
  };
  landlock?: { compatibility: 'best_effort' | 'hard_requirement' };
  process?: { run_as_user: string; run_as_group: string };
  network_policies?: Record<
    string,
    { name: string; endpoints: Array<{ host: string; ports: number[] }>; binaries: Array<{ path: string }> }
  >;
}

export interface DockerBindMount {
  type: 'bind';
  source: string;
  target: string;
  read_only: boolean;
}

export interface DriverConfig {
  docker: { mounts: DockerBindMount[] };
}

export type PolicyAccess = 'read_only' | 'read_write';

/**
 * MountClass -> filesystem_policy list. Exhaustive on purpose: a new class in
 * the vendored union fails typecheck here instead of being silently realized.
 *
 * - group-state: the session mailbox DBs / group folder. Its declared mode is
 *   honored — rw is the IPC channel; ro is a legitimate read-only view over
 *   group paths (composed instructions, per-group config; see MountSpec docs).
 * - install-surface, gateway-trust: read-only by contract (validateSpec
 *   enforces it before we get here; re-asserted so this function is safe alone).
 * - identity-material: never mountable into the agent role — and this driver
 *   realizes only the agent role — so seeing one is a refusal.
 * - allowlisted-extra: operator-vetted; may legitimately be rw.
 */
export function mountAccess(mount: MountSpec, role: string): PolicyAccess {
  const cls: MountClass = mount.class;
  switch (cls) {
    case 'group-state':
    case 'allowlisted-extra':
      return mount.mode === 'rw' ? 'read_write' : 'read_only';
    case 'install-surface':
    case 'gateway-trust':
      if (mount.mode !== 'ro') throw deniedByPolicy(`${cls} mount ${mount.hostPath} must be ro`);
      return 'read_only';
    case 'identity-material':
      throw deniedByPolicy(`identity-material mount ${mount.hostPath} invalid on role ${role}`);
    default: {
      const unreachable: never = cls;
      throw specInvalid(`unknown mount class ${String(unreachable)}`);
    }
  }
}

/** Absolute, no empty / '.' / '..' segments, within the schema's byte limit. */
export function assertPolicyPath(path: string, what: string): void {
  if (!path.startsWith('/')) throw specInvalid(`${what} '${path}' must be absolute`);
  if (Buffer.byteLength(path) > MAX_PATH_BYTES) throw specInvalid(`${what} exceeds ${MAX_PATH_BYTES} bytes`);
  if (path === '/') return;
  const segments = path.split('/').slice(1);
  if (!segments.every((s) => s !== '' && s !== '.' && s !== '..')) {
    throw specInvalid(`${what} '${path}' must be canonical (no '..', '.', '//', or trailing '/')`);
  }
}

function uniq(paths: Iterable<string>): string[] {
  return [...new Set(paths)];
}

export function compilePolicy(spec: SessionSpec, container: ContainerSpec, opts: PolicyOptions = {}): CompiledPolicy {
  const readOnly: string[] = [...(opts.baseReadOnly ?? DEFAULT_BASE_READ_ONLY)];
  const readWrite: string[] = [...(opts.baseReadWrite ?? DEFAULT_BASE_READ_WRITE)];

  for (const mount of container.mounts) {
    assertPolicyPath(mount.containerPath, `containerPath of ${mount.class} mount`);
    (mountAccess(mount, container.role) === 'read_write' ? readWrite : readOnly).push(mount.containerPath);
  }
  for (const p of [...readOnly, ...readWrite]) assertPolicyPath(p, 'policy path');
  if (readWrite.includes('/')) throw specInvalid("OpenShell policy cannot grant read_write on '/'");

  const rw = uniq(readWrite);
  // A path granted rw needs no separate ro entry; listing it twice would make
  // the effective access an ordering artifact of OpenShell's merge.
  const ro = uniq(readOnly).filter((p) => !rw.includes(p));
  if (ro.length + rw.length > MAX_POLICY_PATHS) {
    throw specInvalid(`OpenShell policy allows at most ${MAX_POLICY_PATHS} paths (got ${ro.length + rw.length})`);
  }

  const policy: CompiledPolicy = {
    version: 1,
    filesystem_policy: { include_workdir: opts.includeWorkdir ?? true, read_only: ro, read_write: rw },
  };
  if (opts.landlockCompatibility) policy.landlock = { compatibility: opts.landlockCompatibility };

  if (spec.runAs) {
    // OpenShell rejects root (0) and requires 1..4294967294 — refuse here with
    // the reason rather than letting the gateway fail the create opaquely.
    for (const [field, id] of [
      ['uid', spec.runAs.uid],
      ['gid', spec.runAs.gid],
    ] as const) {
      if (!Number.isInteger(id) || id < 1 || id > 4294967294) {
        throw specInvalid(`runAs.${field} ${id} not realizable on OpenShell (must be 1..4294967294; root is refused)`);
      }
    }
    policy.process = { run_as_user: String(spec.runAs.uid), run_as_group: String(spec.runAs.gid) };
  }

  const rules: NonNullable<CompiledPolicy['network_policies']> = {};
  const egress = opts.gatewayEgress;
  if (spec.network === 'shared-private' && egress && egress.ports.length > 0 && egress.binaries.length > 0) {
    if (spec.networkAccess.target.kind === 'session-container') {
      throw specInvalid(
        'session-container network targets need auxiliary containers, which this driver does not realize',
      );
    }
    rules[GATEWAY_RULE_NAME] = {
      name: GATEWAY_RULE_NAME,
      endpoints: [{ host: egress.host ?? spec.networkAccess.endpoint, ports: [...egress.ports] }],
      binaries: egress.binaries.map((path) => ({ path })),
    };
  }
  if (spec.network === 'shared-private') {
    for (const rule of opts.egress ?? []) {
      assertEgressRule(rule);
      if (rules[rule.name]) throw specInvalid(`duplicate egress rule name '${rule.name}'`);
      rules[rule.name] = {
        name: rule.name,
        endpoints: [{ host: rule.host, ports: [...rule.ports] }],
        binaries: rule.binaries.map((path) => ({ path })),
      };
    }
  }
  if (Object.keys(rules).length > 0) policy.network_policies = rules;
  return policy;
}

/** `--driver-config-json` payload, or null when the spec carries no mounts (then allow_driver_config is not needed). */
export function compileDriverConfig(container: ContainerSpec): DriverConfig | null {
  if (container.mounts.length === 0) return null;
  return {
    docker: {
      mounts: container.mounts.map((m) => ({
        type: 'bind' as const,
        source: m.hostPath,
        target: m.containerPath,
        read_only: m.mode !== 'rw',
      })),
    },
  };
}

// ---------- YAML emission ----------
//
// The policy shape is fixed and small, so it is emitted directly rather than
// pulling in a YAML dependency. Every scalar string is JSON-quoted, which is a
// valid YAML double-quoted scalar — no path can be misread as YAML syntax.

function q(s: string): string {
  return JSON.stringify(s);
}

function list(indent: string, items: readonly string[]): string[] {
  return items.length === 0 ? [' []'] : items.map((i) => `\n${indent}- ${q(i)}`);
}

export function renderPolicyYaml(policy: CompiledPolicy): string {
  const fs = policy.filesystem_policy;
  const out: string[] = [
    `version: ${policy.version}`,
    'filesystem_policy:',
    `  include_workdir: ${fs.include_workdir}`,
    `  read_only:${list('    ', fs.read_only).join('')}`,
    `  read_write:${list('    ', fs.read_write).join('')}`,
  ];
  if (policy.landlock) out.push('landlock:', `  compatibility: ${q(policy.landlock.compatibility)}`);
  if (policy.process) {
    out.push(
      'process:',
      `  run_as_user: ${q(policy.process.run_as_user)}`,
      `  run_as_group: ${q(policy.process.run_as_group)}`,
    );
  }
  if (policy.network_policies) {
    out.push('network_policies:');
    for (const [key, rule] of Object.entries(policy.network_policies)) {
      out.push(`  ${q(key)}:`, `    name: ${q(rule.name)}`, '    endpoints:');
      for (const ep of rule.endpoints) {
        out.push(`      - host: ${q(ep.host)}`, `        ports: [${ep.ports.join(', ')}]`);
      }
      out.push('    binaries:');
      for (const b of rule.binaries) out.push(`      - path: ${q(b.path)}`);
    }
  }
  return `${out.join('\n')}\n`;
}
