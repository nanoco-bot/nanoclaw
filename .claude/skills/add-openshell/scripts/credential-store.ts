import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';

/**
 * The OpenShell gateway keeps no credential store: its relay reads the
 * Anthropic credential from the host service environment (see auth.ts).
 * Providers that need the gateway to hold a credential are refused
 * explicitly, never silently accepted.
 */
export function createCredentialStore(): ProviderCredentialStore {
  return {
    async has(provider) {
      return (
        provider === 'claude' &&
        Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim())
      );
    },
    async save(provider) {
      throw new Error(
        `The OpenShell gateway does not store credentials (provider '${provider}'). ` +
          'It relays only an Anthropic credential taken from the NanoClaw service environment.',
      );
    },
  };
}
