import { inspectInstallCredential } from '../../../../setup/lib/openshell-credential.js';
import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';

/**
 * The OpenShell gateway keeps no credential store of its own: the relay reads
 * the Anthropic credential from the service environment, which setup fills
 * from a 0600 systemd drop-in (see auth.ts). Providers that need the gateway
 * to hold other credentials are refused explicitly, never silently accepted.
 */
export function createCredentialStore(root = process.cwd()): ProviderCredentialStore {
  return {
    async has(provider) {
      return provider === 'claude' && inspectInstallCredential(root).kind !== 'none';
    },
    async save(provider) {
      throw new Error(
        `The OpenShell gateway does not store credentials (provider '${provider}'). ` +
          'It relays only the Anthropic credential setup installs for its service.',
      );
    },
  };
}
