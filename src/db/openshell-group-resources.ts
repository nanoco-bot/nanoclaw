/**
 * Per-agent-group OpenShell resources (migration 026): which OpenShell gateway
 * providers a group's sandboxes get, and the group's own raw egress rules.
 * Read at every sandbox creation (src/drivers/openshell/register.ts), so they
 * survive every new sandbox the group ever gets with no manual step.
 *
 * Credential invariant: no credential VALUE is ever stored here. A provider
 * row holds its name, type, the credential KEY NAMES and an HMAC of each value
 * as supplied at attach time (to tell "same key re-attached" from "rotated");
 * the values themselves go straight into `openshell provider create` and live
 * only in the OpenShell gateway's store.
 */
import { createHmac } from 'node:crypto';

import type { EgressRule } from '../drivers/openshell/policy.js';
import { getDb } from './connection.js';

export interface GroupProviderRow {
  agent_group_id: string;
  provider_name: string;
  provider_type: string | null;
  /** JSON array of env-var names. */
  credential_keys: string;
  /** JSON object KEY → credentialValueHash(value). */
  credential_hashes: string;
  attached_at: string;
}

export interface GroupProvider {
  agentGroupId: string;
  name: string;
  type: string | null;
  credentialKeys: string[];
  credentialHashes: Record<string, string>;
  attachedAt: string;
}

/** Fixed HMAC key: domain separation, not a secret. Compare, never log. */
const CREDENTIAL_HASH_KEY = 'nanoclaw/openshell-provider-credential/v1';

export function credentialValueHash(value: string): string {
  return createHmac('sha256', CREDENTIAL_HASH_KEY).update(value).digest('hex');
}

function toProvider(row: GroupProviderRow): GroupProvider {
  return {
    agentGroupId: row.agent_group_id,
    name: row.provider_name,
    type: row.provider_type,
    credentialKeys: JSON.parse(row.credential_keys) as string[],
    credentialHashes: JSON.parse(row.credential_hashes) as Record<string, string>,
    attachedAt: row.attached_at,
  };
}

/**
 * Attach (or re-attach) a provider to a group. `credentials` are hashed here
 * and dropped; only key names and hashes are written.
 */
export async function attachGroupProvider(input: {
  agentGroupId: string;
  name: string;
  type?: string | null;
  credentials?: Record<string, string>;
  now?: Date;
}): Promise<GroupProvider> {
  const keys = Object.keys(input.credentials ?? {}).sort();
  const hashes = Object.fromEntries(keys.map((k) => [k, credentialValueHash(input.credentials![k])]));
  const row: GroupProviderRow = {
    agent_group_id: input.agentGroupId,
    provider_name: input.name,
    provider_type: input.type ?? null,
    credential_keys: JSON.stringify(keys),
    credential_hashes: JSON.stringify(hashes),
    attached_at: (input.now ?? new Date()).toISOString(),
  };
  await getDb().run(
    `INSERT INTO openshell_group_providers
       (agent_group_id, provider_name, provider_type, credential_keys, credential_hashes, attached_at)
     VALUES (@agent_group_id, @provider_name, @provider_type, @credential_keys, @credential_hashes, @attached_at)
     ON CONFLICT (agent_group_id, provider_name) DO UPDATE SET
       provider_type = excluded.provider_type,
       credential_keys = excluded.credential_keys,
       credential_hashes = excluded.credential_hashes,
       attached_at = excluded.attached_at`,
    row,
  );
  return toProvider(row);
}

/** True when a row was removed. */
export async function detachGroupProvider(agentGroupId: string, name: string): Promise<boolean> {
  const res = await getDb().run(
    'DELETE FROM openshell_group_providers WHERE agent_group_id = ? AND provider_name = ?',
    agentGroupId,
    name,
  );
  return res.changes > 0;
}

export async function listGroupProviders(agentGroupId: string): Promise<GroupProvider[]> {
  const rows = await getDb().all<GroupProviderRow>(
    'SELECT * FROM openshell_group_providers WHERE agent_group_id = ? ORDER BY provider_name',
    agentGroupId,
  );
  return rows.map(toProvider);
}

interface GroupEgressRow {
  agent_group_id: string;
  rule_name: string;
  host: string;
  ports: string;
  binaries: string;
  created_at: string;
}

export interface GroupEgressRule extends EgressRule {
  createdAt: string;
}

function toRule(row: GroupEgressRow): GroupEgressRule {
  return {
    name: row.rule_name,
    host: row.host,
    ports: JSON.parse(row.ports) as number[],
    binaries: JSON.parse(row.binaries) as string[],
    createdAt: row.created_at,
  };
}

/** Add or replace (by name) one raw egress rule for a group. */
export async function putGroupEgressRule(agentGroupId: string, rule: EgressRule, now = new Date()): Promise<void> {
  await getDb().run(
    `INSERT INTO openshell_group_egress (agent_group_id, rule_name, host, ports, binaries, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (agent_group_id, rule_name) DO UPDATE SET
       host = excluded.host, ports = excluded.ports, binaries = excluded.binaries, created_at = excluded.created_at`,
    agentGroupId,
    rule.name,
    rule.host,
    JSON.stringify([...rule.ports]),
    JSON.stringify([...rule.binaries]),
    now.toISOString(),
  );
}

export async function removeGroupEgressRule(agentGroupId: string, name: string): Promise<boolean> {
  const res = await getDb().run(
    'DELETE FROM openshell_group_egress WHERE agent_group_id = ? AND rule_name = ?',
    agentGroupId,
    name,
  );
  return res.changes > 0;
}

export async function listGroupEgressRules(agentGroupId: string): Promise<GroupEgressRule[]> {
  const rows = await getDb().all<GroupEgressRow>(
    'SELECT * FROM openshell_group_egress WHERE agent_group_id = ? ORDER BY rule_name',
    agentGroupId,
  );
  return rows.map(toRule);
}
