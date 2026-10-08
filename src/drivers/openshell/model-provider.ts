/**
 * The agent's Claude credential, held by OpenShell.
 *
 * NanoClaw stores no model credential. Setup hands it to the OpenShell gateway
 * once, as an OpenShell provider; the driver attaches that provider to every
 * sandbox. Inside the sandbox the credential variable holds an
 * `openshell:resolve:env:…` placeholder, and OpenShell swaps in the real value
 * on requests to the provider's endpoints from the provider's binaries.
 *
 * OpenShell v0.1.2 ships no provider profiles, so NanoClaw brings the two it
 * needs: one for a Claude subscription OAuth token (`Authorization: Bearer`)
 * and one for an Anthropic API key (`x-api-key`).
 */
import { PROVIDER_NAME_RE } from './realize.js';

export type ModelCredentialKind = 'oauth' | 'api-key';

/** The environment variable Claude Code reads for each credential kind. */
export const MODEL_CREDENTIAL_ENV: Record<ModelCredentialKind, string> = {
  oauth: 'CLAUDE_CODE_OAUTH_TOKEN',
  'api-key': 'ANTHROPIC_API_KEY',
};

/** The provider profile (OpenShell "type") for each credential kind. */
export const MODEL_PROFILE_ID: Record<ModelCredentialKind, string> = {
  oauth: 'nanoclaw-claude-oauth',
  'api-key': 'nanoclaw-claude-api-key',
};

export const MODEL_HOST = 'api.anthropic.com';
export const MODEL_PORT = 443;

/**
 * Programs allowed to reach the model. Claude Code's native binary lives under
 * a pnpm path that contains its version, so it is matched with single-component
 * globs (`*` matches one path component); node and bun cover the Agent SDK.
 */
export const MODEL_BINARIES = [
  '/pnpm/global/*/.pnpm/*/node_modules/@anthropic-ai/claude-code/bin/claude.exe',
  '/usr/local/bin/node',
  '/usr/local/bin/bun',
] as const;

/** The rule realizing the session's network access: the model API, from the model binaries. */
export const MODEL_EGRESS = { ports: [MODEL_PORT], binaries: [...MODEL_BINARIES] };

/** One provider per install, so several NanoClaw installs can share an OpenShell gateway. */
export function modelProviderName(installSlug: string): string {
  const name = `nanoclaw-${installSlug}-claude`;
  if (!PROVIDER_NAME_RE.test(name)) throw new Error(`install slug '${installSlug}' does not form a provider name`);
  return name;
}

/** The provider profile YAML `openshell provider profile import` takes for `kind`. */
export function modelProfileYaml(kind: ModelCredentialKind): string {
  const auth =
    kind === 'oauth'
      ? ['    auth_style: bearer', '    header_name: authorization']
      : ['    auth_style: header', '    header_name: x-api-key'];
  return [
    `id: ${MODEL_PROFILE_ID[kind]}`,
    `display_name: "NanoClaw Claude (${kind === 'oauth' ? 'subscription' : 'API key'})"`,
    'description: "Claude credential for NanoClaw agents"',
    'category: other',
    'credentials:',
    '  - name: credential',
    `    env_vars: [${MODEL_CREDENTIAL_ENV[kind]}]`,
    '    required: true',
    ...auth,
    'discovery:',
    '  credentials: [credential]',
    'endpoints:',
    `  - host: ${MODEL_HOST}`,
    `    port: ${MODEL_PORT}`,
    '    protocol: rest',
    '    access: full',
    '    enforcement: enforce',
    `binaries: [${MODEL_BINARIES.join(', ')}]`,
    '',
  ].join('\n');
}
