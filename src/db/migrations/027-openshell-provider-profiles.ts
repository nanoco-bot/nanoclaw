import type { Migration } from './index.js';

/**
 * Custom OpenShell provider profile HINTS, install-wide
 * (src/db/openshell-provider-profiles.ts): the shape of a provider type the
 * operator uses that is not one of OpenShell's shipped example profiles —
 * which `--type` to pass, which credential env-var NAMES and config keys it
 * takes. Templates for `openshell provider create` in the setup UI and ncl;
 * never the source of truth for what the gateway accepts, and never a
 * credential value.
 */
export const migration027: Migration = {
  version: 27,
  name: 'openshell-provider-profiles',
  async up(db) {
    await db.exec(`
      CREATE TABLE openshell_provider_profiles (
        id              TEXT PRIMARY KEY,
        label           TEXT NOT NULL,
        provider_type   TEXT NOT NULL,
        credential_keys TEXT NOT NULL DEFAULT '[]',
        config_keys     TEXT NOT NULL DEFAULT '[]',
        description     TEXT,
        created_at      TEXT NOT NULL
      );
    `);
  },
};
