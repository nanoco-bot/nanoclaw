import type { Migration } from './index.js';

/**
 * Per-agent-group OpenShell resources, durable across every sandbox the group
 * ever gets (src/db/openshell-group-resources.ts):
 *
 *  - openshell_group_providers: OpenShell GATEWAY provider names attached to a
 *    group (`openshell sandbox create --provider <name>`). Not the AI model
 *    provider in container_configs.provider — a different concept. Holds the
 *    provider's name/type, the credential KEY NAMES and an HMAC of each value
 *    at attach time; never a credential value (those live only in the
 *    OpenShell gateway's own store).
 *  - openshell_group_egress: raw network-path rules per group, in the
 *    EgressRule shape compilePolicy() already consumes, independent of any
 *    provider.
 *
 * Own tables rather than columns on container_configs: that row is the AI
 * model/runtime config (its `provider` column would collide by name), these are
 * many-per-group rows, and an install that never uses OpenShell keeps two empty
 * tables and nothing else.
 */
export const migration026: Migration = {
  version: 26,
  name: 'openshell-group-resources',
  async up(db) {
    await db.exec(`
      CREATE TABLE openshell_group_providers (
        agent_group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        provider_name     TEXT NOT NULL,
        provider_type     TEXT,
        credential_keys   TEXT NOT NULL DEFAULT '[]',
        credential_hashes TEXT NOT NULL DEFAULT '{}',
        attached_at       TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, provider_name)
      );
      CREATE TABLE openshell_group_egress (
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        rule_name      TEXT NOT NULL,
        host           TEXT NOT NULL,
        ports          TEXT NOT NULL,
        binaries       TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, rule_name)
      );
    `);
  },
};
