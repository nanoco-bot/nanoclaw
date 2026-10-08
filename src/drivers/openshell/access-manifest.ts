/**
 * What an agent group's sandbox can reach, described for the agent.
 *
 * OpenShell hands a sandbox placeholders for its providers' keys and enforces
 * the group's network rules, but nothing inside the sandbox says which
 * services those are or where their APIs live. Without that, an agent asked
 * about "my Granola notes" opens the Granola web app in a browser, which no
 * key or rule covers. The credential gateway puts this manifest in the
 * session's environment (NANOCLAW_OPENSHELL_ACCESS) and the agent guidance
 * tells the agent to read it.
 *
 * It holds names, hosts and header shapes only — never a key or placeholder.
 * Built best-effort: a provider whose profile cannot be read is listed by name
 * alone, and a failed lookup never refuses the session.
 */
import { parse as parseYaml } from 'yaml';

import type { OpenShellCli } from './cli.js';
import type { PolicyOptions } from './policy.js';

export const ACCESS_ENV = 'NANOCLAW_OPENSHELL_ACCESS';

export interface ServiceAccess {
  /** The OpenShell provider's name. */
  provider: string;
  /** The service type's display name (e.g. "Granola"). */
  service?: string;
  /** Variables holding the key's placeholder, e.g. GRANOLA_API_KEY. */
  env: string[];
  /** How to send it, e.g. "Authorization: Bearer $GRANOLA_API_KEY". */
  header?: string;
  /** host:port the key works for. */
  endpoints: string[];
  /** e.g. read-only, read-write. */
  access?: string;
  programs: string[];
}

export interface HostAccess {
  host: string;
  ports: number[];
  programs: string[];
}

export interface AccessManifest {
  services: ServiceAccess[];
  hosts: HostAccess[];
}

interface ProfileDoc {
  display_name?: unknown;
  credentials?: { env_vars?: unknown; auth_style?: unknown; header_name?: unknown }[];
  endpoints?: { host?: unknown; port?: unknown; access?: unknown }[];
  binaries?: unknown;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

function headerFor(cred: NonNullable<ProfileDoc['credentials']>[number], envVar: string): string | undefined {
  const style = typeof cred.auth_style === 'string' ? cred.auth_style : '';
  const name = typeof cred.header_name === 'string' && cred.header_name ? cred.header_name : 'authorization';
  const display = name.toLowerCase() === 'authorization' ? 'Authorization' : name;
  if (style === 'bearer') return `${display}: Bearer $${envVar}`;
  if (style === 'header' || style === 'api_key' || style === 'raw') return `${display}: $${envVar}`;
  return undefined;
}

/** One provider's entry from its service type (profile) document. */
export function serviceFromProfile(provider: string, profile: ProfileDoc | undefined): ServiceAccess {
  if (!profile) return { provider, env: [], endpoints: [], programs: [] };
  const creds = profile.credentials ?? [];
  const env = creds.flatMap((c) => strings(c.env_vars));
  const first = creds.find((c) => strings(c.env_vars).length > 0);
  const header = first ? headerFor(first, strings(first.env_vars)[0]) : undefined;
  const endpoints = (profile.endpoints ?? [])
    .filter((e) => typeof e.host === 'string')
    .map((e) => `${e.host as string}:${typeof e.port === 'number' ? e.port : 443}`);
  const access = (profile.endpoints ?? []).map((e) => e.access).find((a): a is string => typeof a === 'string');
  return {
    provider,
    ...(typeof profile.display_name === 'string' ? { service: profile.display_name } : {}),
    env,
    ...(header ? { header } : {}),
    endpoints,
    ...(access ? { access } : {}),
    programs: strings(profile.binaries),
  };
}

/** The manifest for one group's merged policy options. */
export async function buildAccessManifest(options: PolicyOptions, cli: OpenShellCli): Promise<AccessManifest> {
  const hosts = (options.egress ?? []).map((r) => ({ host: r.host, ports: [...r.ports], programs: [...r.binaries] }));
  const providers = [...new Set(options.providers ?? [])];
  if (providers.length === 0) return { services: [], hosts };

  let types = new Map<string, string>();
  try {
    const doc = JSON.parse(await cli.run(['provider', 'list', '-o', 'json'])) as {
      providers?: { name?: unknown; type?: unknown }[];
    };
    types = new Map(
      (doc.providers ?? [])
        .filter((p) => typeof p.name === 'string' && typeof p.type === 'string')
        .map((p) => [p.name as string, p.type as string]),
    );
  } catch {
    // Listed by name only.
  }

  const profiles = new Map<string, ProfileDoc | undefined>();
  const needed = new Set(providers.map((name) => types.get(name)).filter((t): t is string => !!t));
  for (const type of needed) {
    try {
      profiles.set(type, parseYaml(await cli.run(['provider', 'profile', 'export', type])) as ProfileDoc);
    } catch {
      profiles.set(type, undefined);
    }
  }

  const services = providers.map((name) => {
    const type = types.get(name);
    return serviceFromProfile(name, type ? profiles.get(type) : undefined);
  });
  return { services, hosts };
}

/** Compact JSON for the environment; empty manifests are omitted by the caller. */
export function renderAccessManifest(manifest: AccessManifest): string {
  return JSON.stringify(manifest);
}
