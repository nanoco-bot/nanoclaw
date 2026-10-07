/**
 * OpenShell provider TYPES (gateway provider profiles), as the setup UI shows
 * and creates them. The gateway is the authority: types are read from
 * `openshell provider profile list -o json` and created with
 * `openshell provider profile import -f <file>`. OpenShell v0.1.2 ships no
 * profiles, so a new service (an API with a bearer key, say) needs one before
 * any provider of that type can be created.
 *
 * The simple form covers the common case — one credential, sent as a bearer
 * token or in a named header (OpenShell's two auth styles), to one or more
 * host:port endpoints, from a set of binaries. Access per endpoint is
 * OpenShell's: read-only = GET/HEAD/OPTIONS, read-write adds writes, full = any. Anything else is pasted as YAML and
 * imported as-is (OpenShell validates it).
 */

export interface GatewayEndpoint {
  host: string;
  port: number;
  access?: string;
}

export interface GatewayType {
  id: string;
  label: string;
  description: string;
  /** Env-var names the provider's credential is read from (first of each credential). */
  credentialKeys: string[];
  endpoints: GatewayEndpoint[];
  binaries: string[];
  /** 'user' for imported profiles; whatever OpenShell reports otherwise. */
  source?: string;
}

export function profileListArgs(): string[] {
  return ['provider', 'profile', 'list', '-o', 'json'];
}
export function profileImportArgs(file: string): string[] {
  return ['provider', 'profile', 'import', '-f', file];
}
export function profileDeleteArgs(id: string): string[] {
  return ['provider', 'profile', 'delete', assertTypeId(id)];
}

const TYPE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]{0,127}$/;
const HOST = /^(\*\.)?[A-Za-z0-9]([A-Za-z0-9-]{0,62})(\.[A-Za-z0-9]([A-Za-z0-9-]{0,62}))*$/;
const HEADER = /^[A-Za-z0-9-]{1,64}$/;
const BINARY = /^\/[A-Za-z0-9._+/@-]{1,255}$/;

export function assertTypeId(id: unknown): string {
  const v = String(id ?? '').trim();
  if (!TYPE_ID.test(v)) throw new Error('type id must be lowercase letters, digits and dashes (e.g. granola)');
  return v;
}

/** `openshell provider profile list -o json` → the types the gateway knows. Lenient: unknown fields ignored. */
export function parseGatewayTypes(json: string): GatewayType[] {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error('OpenShell returned a profile list that is not JSON');
  }
  const list = Array.isArray(doc) ? doc : ((doc as { profiles?: unknown[] } | null)?.profiles ?? []);
  const out: GatewayType[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    if (!raw || typeof raw.id !== 'string') continue;
    const creds = Array.isArray(raw.credentials) ? (raw.credentials as Record<string, unknown>[]) : [];
    const endpoints = Array.isArray(raw.endpoints) ? (raw.endpoints as Record<string, unknown>[]) : [];
    out.push({
      id: raw.id,
      label: typeof raw.display_name === 'string' && raw.display_name ? raw.display_name : raw.id,
      description: typeof raw.description === 'string' ? raw.description : '',
      credentialKeys: creds.map((c) => (Array.isArray(c.env_vars) ? String(c.env_vars[0] ?? '') : '')).filter(Boolean),
      endpoints: endpoints
        .filter((e) => typeof e.host === 'string')
        .map((e) => ({
          host: String(e.host),
          port: Number(e.port ?? 443),
          ...(typeof e.access === 'string' ? { access: e.access } : {}),
        })),
      binaries: Array.isArray(raw.binaries) ? (raw.binaries as unknown[]).map(String) : [],
      ...(typeof raw.source === 'string' ? { source: raw.source } : {}),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export type AuthStyle = 'bearer' | 'header';

export interface NewTypeInput {
  id: unknown;
  label?: unknown;
  description?: unknown;
  /** Env var the credential is read from, e.g. GRANOLA_API_KEY. */
  credentialKey: unknown;
  authStyle?: unknown;
  /** For authStyle 'header': the header name (e.g. x-api-key). */
  authName?: unknown;
  endpoints: unknown;
  binaries: unknown;
}

function yamlString(s: string): string {
  return JSON.stringify(s); // a JSON string is a valid YAML double-quoted scalar
}

/** Validate the simple form and render the profile YAML OpenShell imports. Throws on bad input. */
export function buildProfileYaml(input: NewTypeInput): { id: string; yaml: string } {
  const id = assertTypeId(input.id);
  const label = String(input.label ?? '').trim() || id;
  const description = String(input.description ?? '').trim() || `${label} API`;
  const key = String(input.credentialKey ?? '').trim();
  if (!ENV_VAR.test(key)) throw new Error('credential variable must look like GRANOLA_API_KEY (A–Z, digits, _)');
  const auth = String(input.authStyle ?? 'bearer') as AuthStyle;
  if (!['bearer', 'header'].includes(auth)) throw new Error('auth must be bearer or header');
  const authName = String(input.authName ?? '').trim();
  if (auth === 'header' && !HEADER.test(authName)) throw new Error('header name is required (e.g. x-api-key)');

  const endpoints = (Array.isArray(input.endpoints) ? input.endpoints : []).map((e) => {
    const r = (e ?? {}) as Record<string, unknown>;
    const host = String(r.host ?? '')
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const port = Number(r.port ?? 443);
    const access = String(r.access ?? 'read-only');
    if (!HOST.test(host)) throw new Error(`'${host}' is not a host name (e.g. public-api.granola.ai)`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`port ${r.port} is not a TCP port`);
    if (!['read-only', 'read-write', 'full'].includes(access))
      throw new Error('access must be read-only, read-write or full');
    return { host, port, access };
  });
  if (endpoints.length === 0) throw new Error('at least one host is required');

  const binaries = (Array.isArray(input.binaries) ? input.binaries : []).map((b) => String(b).trim()).filter(Boolean);
  if (binaries.length === 0) throw new Error('pick at least one program allowed to connect');
  for (const b of binaries) if (!BINARY.test(b)) throw new Error(`'${b}' is not an absolute program path`);

  const lines = [
    `id: ${id}`,
    `display_name: ${yamlString(label)}`,
    `description: ${yamlString(description)}`,
    'category: other',
    'credentials:',
    '  - name: api_key',
    `    description: ${yamlString(`${label} credential`)}`,
    `    env_vars: [${key}]`,
    '    required: true',
    `    auth_style: ${auth}`,
    ...(auth === 'bearer' ? ['    header_name: authorization'] : []),
    ...(auth === 'header' ? [`    header_name: ${authName.toLowerCase()}`] : []),
    'discovery:',
    '  credentials: [api_key]',
    'endpoints:',
    ...endpoints.flatMap((e) => [
      `  - host: ${e.host}`,
      `    port: ${e.port}`,
      '    protocol: rest',
      `    access: ${e.access}`,
      '    enforcement: enforce',
    ]),
    `binaries: [${binaries.join(', ')}]`,
  ];
  return { id, yaml: lines.join('\n') + '\n' };
}

/** The `id:` of a pasted profile, for the response; OpenShell validates the rest. */
export function yamlProfileId(yaml: string): string {
  const m = String(yaml).match(/^id:\s*["']?([a-z0-9][a-z0-9-]*)["']?\s*$/m);
  if (!m) throw new Error('the YAML needs a top-level `id:` (lowercase, e.g. granola)');
  return m[1];
}
