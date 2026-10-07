/**
 * OpenShell's builtin provider profiles, as `--type` values for
 * `openshell provider create`, with the credential env-var names each profile
 * declares. Source: NVIDIA/OpenShell `providers/*.yaml` (main, 2026-10). A
 * profile that declares no credentials is "generic" (upstream TUI:
 * `is_generic = credential_keys.is_empty()`): the operator names the env var.
 *
 * Hints only — the gateway is the authority on what a profile accepts, and
 * the UI shows OpenShell's own error text when it refuses something.
 */
export interface ProviderProfile {
  id: string;
  label: string;
  /** Env-var names the profile reads credentials from; empty = generic. */
  credentialKeys: readonly string[];
}

export const PROVIDER_PROFILES: readonly ProviderProfile[] = [
  { id: 'anthropic', label: 'Anthropic', credentialKeys: ['ANTHROPIC_API_KEY'] },
  { id: 'aws', label: 'AWS', credentialKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'] },
  {
    id: 'aws-bedrock',
    label: 'AWS Bedrock',
    credentialKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION'],
  },
  {
    id: 'aws-s3',
    label: 'AWS S3',
    credentialKeys: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
  },
  { id: 'claude-code', label: 'Claude Code', credentialKeys: ['ANTHROPIC_API_KEY'] },
  {
    id: 'codex',
    label: 'Codex',
    credentialKeys: [
      'CODEX_AUTH_ACCESS_TOKEN',
      'CODEX_AUTH_REFRESH_TOKEN',
      'CODEX_AUTH_ACCOUNT_ID',
      'CODEX_AUTH_ID_TOKEN',
    ],
  },
  { id: 'copilot', label: 'GitHub Copilot', credentialKeys: ['COPILOT_GITHUB_TOKEN'] },
  { id: 'cursor', label: 'Cursor', credentialKeys: [] },
  { id: 'deepinfra', label: 'DeepInfra', credentialKeys: ['DEEPINFRA_API_KEY'] },
  { id: 'github', label: 'GitHub', credentialKeys: ['GITHUB_TOKEN'] },
  {
    id: 'google-cloud',
    label: 'Google Cloud (GCP APIs)',
    credentialKeys: ['GCP_SA_ACCESS_TOKEN', 'GCP_ADC_ACCESS_TOKEN'],
  },
  {
    id: 'google-vertex-ai',
    label: 'Google Vertex AI',
    credentialKeys: ['GOOGLE_SERVICE_ACCOUNT_KEY', 'GOOGLE_VERTEX_AI_SERVICE_ACCOUNT_TOKEN', 'GOOGLE_VERTEX_AI_TOKEN'],
  },
  { id: 'nvidia', label: 'NVIDIA', credentialKeys: ['NVIDIA_API_KEY'] },
  { id: 'oci-genai', label: 'OCI Generative AI', credentialKeys: ['OCI_GENAI_API_KEY'] },
  { id: 'openai', label: 'OpenAI', credentialKeys: ['OPENAI_API_KEY'] },
  { id: 'openrouter', label: 'OpenRouter', credentialKeys: ['OPENROUTER_API_KEY'] },
  { id: 'pypi', label: 'PyPI', credentialKeys: [] },
];

/**
 * A selectable template in the UI: a shipped profile above, or an operator's
 * custom one (`ncl openshell-provider-profile`, openshell_provider_profiles).
 * `type` is what `openshell provider create --type` gets; for shipped profiles
 * it is the id.
 */
export interface ProfileTemplate {
  id: string;
  label: string;
  type: string;
  credentialKeys: readonly string[];
  configKeys: readonly string[];
  description?: string | null;
  source: 'builtin' | 'custom';
  generic: boolean;
}

/** The custom-profile fields the merge needs (src/db/openshell-provider-profiles.ts CustomProviderProfile). */
export interface CustomProfileInput {
  id: string;
  label: string;
  type: string;
  credentialKeys: readonly string[];
  configKeys: readonly string[];
  description?: string | null;
}

/**
 * Shipped + custom, by id. A custom profile with a shipped id replaces it:
 * the operator's definition of a type (e.g. their own imported `github` with
 * their image's binaries) is the more specific hint. Builtins first in their
 * own order, then custom-only ids alphabetically.
 */
export function mergeProfiles(
  custom: readonly CustomProfileInput[],
  builtin: readonly ProviderProfile[] = PROVIDER_PROFILES,
): ProfileTemplate[] {
  const byId = new Map(custom.map((c) => [c.id, c]));
  const fromCustom = (c: CustomProfileInput): ProfileTemplate => ({
    id: c.id,
    label: c.label,
    type: c.type,
    credentialKeys: [...c.credentialKeys],
    configKeys: [...c.configKeys],
    description: c.description ?? null,
    source: 'custom',
    generic: c.credentialKeys.length === 0,
  });
  const out: ProfileTemplate[] = builtin.map((b) => {
    const c = byId.get(b.id);
    return c
      ? fromCustom(c)
      : {
          id: b.id,
          label: b.label,
          type: b.id,
          credentialKeys: b.credentialKeys,
          configKeys: [],
          source: 'builtin',
          generic: b.credentialKeys.length === 0,
        };
  });
  const builtinIds = new Set(builtin.map((b) => b.id));
  for (const c of [...custom].sort((a, b) => a.id.localeCompare(b.id)))
    if (!builtinIds.has(c.id)) out.push(fromCustom(c));
  return out;
}

export function findProfile(
  id: string,
  templates?: readonly ProfileTemplate[],
): ProviderProfile | ProfileTemplate | undefined {
  if (templates) return templates.find((p) => p.type === id) ?? templates.find((p) => p.id === id);
  return PROVIDER_PROFILES.find((p) => p.id === id);
}

/** Generic = no declared credential keys, or a type no template knows (imported straight into the gateway). */
export function isGenericType(id: string, templates?: readonly ProfileTemplate[]): boolean {
  const profile = findProfile(id, templates);
  return !profile || profile.credentialKeys.length === 0;
}
