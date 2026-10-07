/**
 * Custom OpenShell provider profile hints (migration 027), install-wide.
 *
 * A row says: "providers of OpenShell type T take credential env vars K… and
 * config keys C…". The setup UI lists these next to OpenShell's shipped
 * profiles (.claude/skills/add-openshell/scripts/ui/profiles.ts) as templates
 * that prefill `openshell provider create`. Hints only: whether the gateway
 * accepts type T is the gateway's call (OpenShell v0.1.2 needs the profile
 * imported there first — `openshell provider profile import`). Never a
 * credential value: names only.
 */
import { getDb } from './connection.js';

export interface CustomProviderProfile {
  id: string;
  label: string;
  /** The `--type` value for `openshell provider create`. */
  type: string;
  credentialKeys: string[];
  configKeys: string[];
  description: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  label: string;
  provider_type: string;
  credential_keys: string;
  config_keys: string;
  description: string | null;
  created_at: string;
}

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CONFIG_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

function toProfile(r: Row): CustomProviderProfile {
  return {
    id: r.id,
    label: r.label,
    type: r.provider_type,
    credentialKeys: JSON.parse(r.credential_keys) as string[],
    configKeys: JSON.parse(r.config_keys) as string[],
    description: r.description,
    createdAt: r.created_at,
  };
}

/** Validate and normalize; throws with the field at fault. */
export function normalizeProfile(input: {
  id: unknown;
  label?: unknown;
  type?: unknown;
  credentialKeys?: unknown;
  configKeys?: unknown;
  description?: unknown;
}): Omit<CustomProviderProfile, 'createdAt'> {
  const id = String(input.id ?? '').trim();
  if (!PROFILE_ID_RE.test(id)) throw new Error(`profile id '${id}' must be lowercase letters, digits, '.', '_', '-'`);
  const type = String(input.type ?? id).trim() || id;
  if (!PROFILE_ID_RE.test(type))
    throw new Error(`provider type '${type}' must be lowercase letters, digits, '.', '_', '-'`);
  const label = String(input.label ?? '').trim() || id;
  if (label.length > 80 || /\p{Cc}/u.test(label)) throw new Error('label must be one line of at most 80 characters');
  const list = (v: unknown, re: RegExp, what: string): string[] => {
    if (v === undefined || v === null || v === '') return [];
    const arr = Array.isArray(v) ? v : String(v).split(',');
    const out = arr.map((x) => String(x).trim()).filter(Boolean);
    for (const k of out) if (!re.test(k)) throw new Error(`${what} '${k}' is not valid`);
    return [...new Set(out)];
  };
  const description =
    input.description === undefined || input.description === null ? null : String(input.description).trim() || null;
  if (description && description.length > 500) throw new Error('description is limited to 500 characters');
  return {
    id,
    label,
    type,
    credentialKeys: list(input.credentialKeys, ENV_NAME_RE, 'credential key'),
    configKeys: list(input.configKeys, CONFIG_KEY_RE, 'config key'),
    description,
  };
}

export async function createProviderProfile(
  input: Omit<CustomProviderProfile, 'createdAt'>,
  now = new Date(),
): Promise<CustomProviderProfile> {
  if (await getProviderProfile(input.id)) throw new Error(`custom provider profile '${input.id}' already exists`);
  const row: Row = {
    id: input.id,
    label: input.label,
    provider_type: input.type,
    credential_keys: JSON.stringify(input.credentialKeys),
    config_keys: JSON.stringify(input.configKeys),
    description: input.description,
    created_at: now.toISOString(),
  };
  await getDb().run(
    `INSERT INTO openshell_provider_profiles (id, label, provider_type, credential_keys, config_keys, description, created_at)
     VALUES (@id, @label, @provider_type, @credential_keys, @config_keys, @description, @created_at)`,
    row,
  );
  return toProfile(row);
}

export async function getProviderProfile(id: string): Promise<CustomProviderProfile | undefined> {
  const row = await getDb().get<Row>('SELECT * FROM openshell_provider_profiles WHERE id = ?', id);
  return row ? toProfile(row) : undefined;
}

export async function listProviderProfiles(): Promise<CustomProviderProfile[]> {
  return (await getDb().all<Row>('SELECT * FROM openshell_provider_profiles ORDER BY id')).map(toProfile);
}

export async function deleteProviderProfile(id: string): Promise<boolean> {
  return (await getDb().run('DELETE FROM openshell_provider_profiles WHERE id = ?', id)).changes > 0;
}
