/**
 * The operator's OpenShell policy file: per-agent-group providers and network
 * rules, plus defaults (shape in group-policy.ts). The driver re-reads it for
 * every new sandbox; the console edits it through the helpers below.
 *
 * Edits keep the operator's comments and formatting (YAML document API), are
 * validated with the driver's own strict parser before anything is written,
 * and replace the file atomically.
 */
import fs from 'node:fs';
import path from 'node:path';

import { parseDocument, type Document } from 'yaml';

import { DATA_DIR } from '../../config.js';
import { parsePolicyConfig, type PolicyConfig } from './group-policy.js';
import type { EgressRule } from './policy.js';

/** Where the policy file lives when NANOCLAW_OPENSHELL_POLICY_FILE is not set. */
export const DEFAULT_POLICY_FILE = path.join(DATA_DIR, 'openshell', 'policy.yaml');

export function policyFilePath(env: NodeJS.ProcessEnv): string {
  return env.NANOCLAW_OPENSHELL_POLICY_FILE?.trim() || DEFAULT_POLICY_FILE;
}

function readDocument(file: string): Document {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = parseDocument(text);
  if (doc.errors.length > 0) throw new Error(`OpenShell policy file '${file}': ${doc.errors[0].message}`);
  return doc;
}

/** The file, parsed and validated; empty when it does not exist yet. */
export function readPolicyFile(file: string): PolicyConfig {
  return parsePolicyConfig(readDocument(file).toJSON());
}

/** Apply `edit`, validate the result, then replace the file atomically. */
function updatePolicyFile(file: string, edit: (doc: Document) => void): PolicyConfig {
  const doc = readDocument(file);
  if (!doc.contents) doc.contents = doc.createNode({});
  edit(doc);
  const config = parsePolicyConfig(doc.toJSON());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, doc.toString());
  fs.renameSync(tmp, file);
  return config;
}

function groupList<T>(doc: Document, folder: string, key: 'providers' | 'egress'): T[] {
  const value = doc.getIn(['groups', folder, key]) as { toJSON(): unknown } | undefined;
  return value ? ((value.toJSON() as T[]) ?? []) : [];
}

export function addGroupProvider(file: string, folder: string, name: string): PolicyConfig {
  return updatePolicyFile(file, (doc) => {
    const providers = groupList<string>(doc, folder, 'providers');
    if (!providers.includes(name)) doc.setIn(['groups', folder, 'providers'], [...providers, name]);
  });
}

export function removeGroupProvider(file: string, folder: string, name: string): PolicyConfig {
  return updatePolicyFile(file, (doc) => {
    const providers = groupList<string>(doc, folder, 'providers');
    if (!providers.includes(name)) throw new Error(`OpenShell provider '${name}' is not attached to ${folder}`);
    doc.setIn(
      ['groups', folder, 'providers'],
      providers.filter((p) => p !== name),
    );
  });
}

/** Add a network rule to the group, replacing one with the same name. */
export function putGroupEgressRule(file: string, folder: string, rule: EgressRule): PolicyConfig {
  return updatePolicyFile(file, (doc) => {
    const rules = groupList<EgressRule>(doc, folder, 'egress').filter((r) => r.name !== rule.name);
    doc.setIn(
      ['groups', folder, 'egress'],
      [...rules, { name: rule.name, host: rule.host, ports: [...rule.ports], binaries: [...rule.binaries] }],
    );
  });
}

export function removeGroupEgressRule(file: string, folder: string, name: string): PolicyConfig {
  return updatePolicyFile(file, (doc) => {
    const rules = groupList<EgressRule>(doc, folder, 'egress');
    if (!rules.some((r) => r.name === name)) throw new Error(`no network rule '${name}' for ${folder}`);
    doc.setIn(
      ['groups', folder, 'egress'],
      rules.filter((r) => r.name !== name),
    );
  });
}
