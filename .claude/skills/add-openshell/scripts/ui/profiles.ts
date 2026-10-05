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

export function findProfile(id: string): ProviderProfile | undefined {
  return PROVIDER_PROFILES.find((p) => p.id === id);
}

/** Generic = no declared credential keys, or a profile id this table does not know (custom/imported). */
export function isGenericType(id: string): boolean {
  const profile = findProfile(id);
  return !profile || profile.credentialKeys.length === 0;
}
