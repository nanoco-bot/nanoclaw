/**
 * The `openshell` credential gateway, against a mocked `openshell` CLI: it
 * refuses a runtime that cannot attach OpenShell providers and an install
 * whose Claude provider OpenShell does not have; otherwise it declares the
 * model API as the session's destination and contributes no credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const run = vi.fn<(args: string[]) => Promise<string>>();
vi.mock('../drivers/openshell/config.js', () => ({ configuredOpenShellCli: () => ({ bin: 'openshell', run }) }));

import { INSTALL_SLUG } from '../config.js';
import type { DriverCapabilities } from '../drivers/types.js';
import { MODEL_HOST, modelProviderName } from '../drivers/openshell/model-provider.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';
import './openshell.js';

const provider = () => getGatewayProviderRegistration('openshell')!;

const OPENSHELL_CAPS: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'declarative',
  encryptedVolumes: false,
  unrealized: [],
  sharedNetworkNamespace: false,
  auxiliaryContainers: false,
  imageBuild: false,
};

const input = (capabilities: DriverCapabilities = OPENSHELL_CAPS) => ({
  key: { installSlug: INSTALL_SLUG, agentGroupId: 'ag', sessionId: 's' },
  runtimeIdentity: `${INSTALL_SLUG}/ag/s`,
  groupName: 'Test',
  containerName: 'c',
  capabilities,
});

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue('');
});

describe('openshell gateway', () => {
  it("declares the model API and nothing else once OpenShell holds the install's Claude provider", async () => {
    const lease = await provider().sessions.ensure(input(), new AbortController().signal);
    expect(run).toHaveBeenCalledWith(['provider', 'get', modelProviderName(INSTALL_SLUG)]);
    expect(lease.contribution).toEqual({ networkAccess: { endpoint: MODEL_HOST, target: { kind: 'host' } } });
  });

  it('refuses a session, naming the sign-in step, when the Claude provider is missing', async () => {
    run.mockRejectedValue(new Error('provider not found'));
    await expect(provider().sessions.ensure(input(), new AbortController().signal)).rejects.toThrow(
      /no provider .*--step gateway-auth/s,
    );
  });

  it('refuses a runtime that enforces egress by topology (the Docker driver)', async () => {
    await expect(
      provider().sessions.ensure(input({ ...OPENSHELL_CAPS, networkPolicy: 'topology' }), new AbortController().signal),
    ).rejects.toThrow(/requires the openshell session driver/);
    expect(run).not.toHaveBeenCalled();
  });

  it('stays subscribed until core aborts, and holds nothing for approval', async () => {
    const controller = new AbortController();
    const decide = vi.fn();
    let ended = false;
    const sub = provider()
      .approvals.subscribe(decide, controller.signal)
      .then(() => (ended = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(ended).toBe(false);
    controller.abort();
    await sub;
    expect(decide).not.toHaveBeenCalled();
  });
});
