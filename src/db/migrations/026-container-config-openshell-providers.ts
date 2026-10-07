import type { Migration } from './index.js';

/**
 * Per-agent-group OpenShell provider attachments on `container_configs`.
 *
 * JSON array of OpenShell provider INSTANCE names (`openshell provider create
 * --name <n>`). The OpenShell session driver passes one `--provider <name>` per
 * entry to every `openshell sandbox create` for that group, so a provider
 * attached once survives the per-session sandbox teardown. Managed by
 * `ncl openshell-provider attach|detach|list` (operator-only). Inert on any
 * other runtime driver.
 *
 * '[]' = no providers attached (the pre-feature behavior: provider-less sandboxes).
 */
export const migration026: Migration = {
  version: 26,
  name: 'container-config-openshell-providers',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN openshell_providers TEXT NOT NULL DEFAULT '[]';`);
  },
};
