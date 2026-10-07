/**
 * Named, versioned egress-policy presets: `presets/<name>.yaml`, one bundle of
 * network rules per file, applied to a live sandbox by
 * `ncl openshell-policy apply-preset` (src/cli/resources/openshell-policy.ts).
 *
 * File shape — strict, like parsePolicyConfig (group-policy.ts): any key not
 * listed here fails loudly, because a preset grants egress.
 *
 *   name: github              # must equal the file name (github.yaml)
 *   version: 1                # positive integer; bump on ANY rule change
 *   description: …
 *   rules:                    # EgressRule, exactly the shape policy.ts uses
 *     - { name: github_api, host: api.github.com, ports: [443], binaries: [/usr/local/bin/node] }
 *
 * A rule expands to the same `openshell policy update` argv `ncl openshell-policy
 * add-rule` builds by hand: one call per (rule, port), `--add-endpoint host:port
 * --binary … --rule-name <name>`. One call per port because OpenShell v0.1.2
 * accepts `--rule-name` only with exactly one `--add-endpoint`
 * (openshell-cli policy_update.rs); repeated calls with the same rule name
 * merge into that one rule (openshell-policy merge.rs, add_rule). Binaries are
 * per call, so different rules cannot share one call either.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { parseRule } from './group-policy.js';
import { assertEgressRule, type EgressRule } from './policy.js';
import type { PolicyUpdateOptions } from './policy-commands.js';

export interface EgressPreset {
  name: string;
  version: number;
  description: string;
  rules: EgressRule[];
}

export interface PresetSummary {
  name: string;
  version: number;
  description: string;
  rules: number;
}

const PRESET_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOP_KEYS = ['name', 'version', 'description', 'rules'];

/**
 * Where the YAML files are. Next to this module under tsx/vitest; the host
 * service runs compiled `dist/`, which `tsc` does not copy YAML into, so it
 * falls back to the checkout's `src/` copy (the service's working directory is
 * the project root).
 */
let dirOverride: string | null = null;
/** Test seam: read presets from another directory (null restores the default). */
export function setPresetsDir(dir: string | null): void {
  dirOverride = dir;
}

export function presetsDir(): string {
  if (dirOverride) return dirOverride;
  const beside = fileURLToPath(new URL('./presets/', import.meta.url));
  if (fs.existsSync(beside)) return beside;
  return path.join(process.cwd(), 'src', 'drivers', 'openshell', 'presets');
}

function presetFail(file: string): (where: string, what: string) => never {
  return (where, what) => {
    throw new Error(`OpenShell egress preset ${file}: ${where}: ${what}`);
  };
}

/** Strict parse of one preset file's text. `expectedName` is the file stem. */
export function parsePreset(text: string, expectedName: string): EgressPreset {
  const file = `${expectedName}.yaml`;
  const fail: (where: string, what: string) => never = presetFail(file);
  let doc: unknown;
  try {
    doc = parseYaml(text, { uniqueKeys: true });
  } catch (err) {
    fail('yaml', err instanceof Error ? err.message.split('\n')[0] : String(err));
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('root', 'must be a mapping');
  const o = doc as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!TOP_KEYS.includes(k)) fail('root', `unknown key '${k}'`);
  if (o.name !== expectedName) fail('name', `must be '${expectedName}' (the file name), got ${JSON.stringify(o.name)}`);
  if (typeof o.version !== 'number' || !Number.isInteger(o.version) || o.version < 1)
    fail('version', 'must be a positive integer');
  if (typeof o.description !== 'string' || !o.description.trim()) fail('description', 'must be a non-empty string');
  if (!Array.isArray(o.rules) || o.rules.length === 0) fail('rules', 'must be a non-empty list');
  const seen = new Set<string>();
  const rules = o.rules.map((raw, i) => {
    const where = `rules[${i}]`;
    const rule = parseRule(raw, where, fail);
    try {
      assertEgressRule(rule);
    } catch (err) {
      fail(where, (err as { detail?: string }).detail ?? (err instanceof Error ? err.message : String(err)));
    }
    // `openshell policy update --add-endpoint` reads host:port; a ':' or '/'
    // in the host would be parsed as something else.
    if (/[:/]/.test(rule.host)) fail(`${where}.host`, `'${rule.host}' must be a bare host name`);
    if (seen.has(rule.name)) fail(`${where}.name`, `duplicate rule name '${rule.name}'`);
    seen.add(rule.name);
    return rule;
  });
  return { name: o.name as string, version: o.version as number, description: o.description as string, rules };
}

function names(dir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

export function loadPreset(name: string, dir: string = presetsDir()): EgressPreset {
  // Checked before it touches a path: a name is never a path.
  if (!PRESET_NAME.test(name)) throw new Error(`'${name}' is not a preset name (lowercase letters, digits, '-')`);
  const file = path.join(dir, `${name}.yaml`);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const available = names(dir);
    throw new Error(
      `unknown egress preset '${name}' (available: ${available.length ? available.join(', ') : 'none'})`,
      {
        cause: err,
      },
    );
  }
  return parsePreset(text, name);
}

/** Every preset, loaded strictly: one broken file fails the listing rather than hiding. */
export function listPresets(dir: string = presetsDir()): PresetSummary[] {
  return names(dir).map((n) => {
    const p = loadPreset(n, dir);
    return { name: p.name, version: p.version, description: p.description, rules: p.rules.length };
  });
}

/** One `policyUpdateArgs` options object per (rule, port) — what add-rule would be given by hand. */
export function presetUpdateOptions(preset: EgressPreset): { rule: string; options: PolicyUpdateOptions }[] {
  return preset.rules.flatMap((rule) => egressRuleUpdateOptions(rule).map((options) => ({ rule: rule.name, options })));
}

/**
 * One EgressRule as live `openshell policy update` options: one call per port
 * (`--add-endpoint host:port --binary … --rule-name <name>`), because v0.1.2
 * takes `--rule-name` with exactly one `--add-endpoint`; same-name calls merge
 * into one rule. Shared by presets and `ncl openshell-network add`.
 */
export function egressRuleUpdateOptions(rule: EgressRule): PolicyUpdateOptions[] {
  return rule.ports.map((port) => ({
    addEndpoint: [`${rule.host}:${port}`],
    binary: [...rule.binaries],
    ruleName: rule.name,
  }));
}
