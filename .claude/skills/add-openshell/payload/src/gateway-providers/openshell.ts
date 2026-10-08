/**
 * `openshell` credential gateway.
 *
 * OpenShell itself holds the agent's Claude credential: setup stores it as an
 * OpenShell provider, the session driver attaches that provider to every
 * sandbox, and OpenShell swaps the real value in on requests to the model API.
 * So this adapter runs no proxy and contributes no credential. It only
 * declares the session's destination and refuses sessions that cannot work:
 * on a runtime that is not the OpenShell driver, or before setup has stored
 * the credential.
 *
 * No approval holds: OpenShell enforces allow and deny itself, and its blocked
 * requests are reviewed with `openshell rule` (or the setup console), not
 * through NanoClaw's approval cards.
 */
import { INSTALL_SLUG } from '../config.js';
import { configuredOpenShellCli } from '../drivers/openshell/config.js';
import { MODEL_HOST, modelProviderName } from '../drivers/openshell/model-provider.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';

/** An error whose `userMessage` core shows in the chat instead of a generic failure. */
function userFacingError(message: string, userMessage: string): Error & { userMessage: string } {
  return Object.assign(new Error(message), { userMessage });
}

/** Whether OpenShell holds this install's Claude provider. */
async function modelProviderExists(name: string): Promise<boolean> {
  try {
    await configuredOpenShellCli().run(['provider', 'get', name]);
    return true;
  } catch {
    return false;
  }
}

registerGatewayProvider({
  kind: 'openshell',
  agentSkills: ['openshell-gateway'],
  sessions: {
    async ensure(input) {
      // The credential reaches the agent only as an OpenShell provider, which
      // only the OpenShell driver attaches.
      if (input.capabilities.networkPolicy !== 'declarative') {
        throw new Error(
          'The OpenShell gateway requires the openshell session driver (NANOCLAW_RUNTIME_DRIVER=openshell); ' +
            `the selected runtime enforces egress by '${input.capabilities.networkPolicy}'.`,
        );
      }
      const provider = modelProviderName(INSTALL_SLUG);
      if (!(await modelProviderExists(provider))) {
        throw userFacingError(
          `OpenShell has no provider '${provider}' with this install's Claude credential; refusing session`,
          "I can't reply yet: no Claude credential is configured for this NanoClaw install. The operator needs to run setup's sign-in step (`pnpm exec tsx setup/index.ts --step gateway-auth`).",
        );
      }
      return { contribution: { networkAccess: { endpoint: MODEL_HOST, target: { kind: 'host' } } } };
    },
  },
  approvals: {
    // Nothing to subscribe to; stay pending until core aborts, so the gateway
    // reads as available for as long as the host runs.
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
});
