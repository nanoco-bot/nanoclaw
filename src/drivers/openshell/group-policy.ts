/**
 * Per-agent-group OpenShell policy options — operator configuration, keyed by
 * the agent group's FOLDER (the `nanoclaw-group-folder` label core stamps on
 * every spec, verbatim). Folder, not group id: ids are generated UUIDs; the
 * folder is the stable name an operator writes in a config file.
 *
 * This is the mechanism behind "same spec shape, different reachable
 * destinations per agent": e.g. group `alice` gets an egress rule to the CRM
 * API and group `bob` does not. The driver still decides nothing — it looks up
 * what the operator declared for the folder on the spec.
 *
 * File shape (NANOCLAW_OPENSHELL_POLICY_FILE, JSON):
 *   { "default": PolicyOptions, "groups": { "<folder>": PolicyOptions } }
 */
import { GROUP_FOLDER_LABEL, type SessionSpec } from './seam.js';
import type { EgressRule, PolicyOptions } from './policy.js';

export interface PolicyConfig {
  default?: PolicyOptions;
  groups?: Record<string, PolicyOptions>;
}

/**
 * `over` wins field by field; `egress` rules ACCUMULATE (default rules, then
 * the group's) — a group adds destinations on top of what every agent gets
 * (e.g. the model gateway), it does not have to restate them.
 */
export function mergePolicyOptions(base: PolicyOptions, over: PolicyOptions): PolicyOptions {
  const merged: PolicyOptions = { ...base, ...over };
  const egress = [...(base.egress ?? []), ...(over.egress ?? [])];
  if (egress.length > 0) merged.egress = egress;
  else delete merged.egress;
  return merged;
}

/** The options for this spec's agent group: defaults merged with the group's entry (if any). */
export function policyOptionsFor(
  spec: SessionSpec,
  defaults: PolicyOptions,
  groups: Record<string, PolicyOptions> = {},
): PolicyOptions {
  const folder = spec.labels[GROUP_FOLDER_LABEL];
  const own = folder && Object.prototype.hasOwnProperty.call(groups, folder) ? groups[folder] : undefined;
  return own ? mergePolicyOptions(defaults, own) : defaults;
}

// ---------- parsing (fail loudly on anything unexpected: this file grants egress) ----------

const OPTION_KEYS = new Set([
  'baseReadOnly',
  'baseReadWrite',
  'includeWorkdir',
  'landlockCompatibility',
  'gatewayEgress',
  'egress',
]);

function fail(where: string, what: string): never {
  throw new Error(`OpenShell policy config: ${where}: ${what}`);
}

function stringArray(v: unknown, where: string): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string')) fail(where, 'must be an array of strings');
  return v as string[];
}

function parseRule(v: unknown, where: string): EgressRule {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['name', 'host', 'ports', 'binaries'].includes(k)) fail(where, `unknown key '${k}'`);
  if (typeof o.name !== 'string') fail(where, 'name must be a string');
  if (typeof o.host !== 'string') fail(where, 'host must be a string');
  if (!Array.isArray(o.ports) || !o.ports.every((p) => typeof p === 'number'))
    fail(where, 'ports must be an array of numbers');
  return {
    name: o.name,
    host: o.host,
    ports: o.ports as number[],
    binaries: stringArray(o.binaries, `${where}.binaries`),
  };
}

export function parsePolicyOptions(v: unknown, where: string): PolicyOptions {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'must be an object');
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!OPTION_KEYS.has(k)) fail(where, `unknown key '${k}'`);
  const out: PolicyOptions = {};
  if (o.baseReadOnly !== undefined) out.baseReadOnly = stringArray(o.baseReadOnly, `${where}.baseReadOnly`);
  if (o.baseReadWrite !== undefined) out.baseReadWrite = stringArray(o.baseReadWrite, `${where}.baseReadWrite`);
  if (o.includeWorkdir !== undefined) {
    if (typeof o.includeWorkdir !== 'boolean') fail(`${where}.includeWorkdir`, 'must be a boolean');
    out.includeWorkdir = o.includeWorkdir;
  }
  if (o.landlockCompatibility !== undefined) {
    if (o.landlockCompatibility !== 'best_effort' && o.landlockCompatibility !== 'hard_requirement') {
      fail(`${where}.landlockCompatibility`, 'must be best_effort or hard_requirement');
    }
    out.landlockCompatibility = o.landlockCompatibility;
  }
  if (o.gatewayEgress !== undefined) {
    const g = o.gatewayEgress as Record<string, unknown>;
    if (!g || typeof g !== 'object') fail(`${where}.gatewayEgress`, 'must be an object');
    if (!Array.isArray(g.ports) || !g.ports.every((p) => typeof p === 'number'))
      fail(`${where}.gatewayEgress.ports`, 'must be numbers');
    out.gatewayEgress = {
      ports: g.ports as number[],
      binaries: stringArray(g.binaries, `${where}.gatewayEgress.binaries`),
      ...(typeof g.host === 'string' ? { host: g.host } : {}),
    };
  }
  if (o.egress !== undefined) {
    if (!Array.isArray(o.egress)) fail(`${where}.egress`, 'must be an array');
    out.egress = o.egress.map((r, i) => parseRule(r, `${where}.egress[${i}]`));
  }
  return out;
}

export function parsePolicyConfig(json: unknown): PolicyConfig {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('root', 'must be an object');
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (k !== 'default' && k !== 'groups' && k !== '$comment') fail('root', `unknown key '${k}'`);
  const out: PolicyConfig = {};
  if (o.default !== undefined) out.default = parsePolicyOptions(o.default, 'default');
  if (o.groups !== undefined) {
    if (!o.groups || typeof o.groups !== 'object' || Array.isArray(o.groups)) fail('groups', 'must be an object');
    out.groups = {};
    for (const [folder, opts] of Object.entries(o.groups as Record<string, unknown>)) {
      out.groups[folder] = parsePolicyOptions(opts, `groups.${folder}`);
    }
  }
  return out;
}
