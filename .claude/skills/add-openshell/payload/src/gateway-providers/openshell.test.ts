/**
 * Installed-shape checks: importing the provider registers exactly the
 * `openshell` kind, and its session contribution is accepted by core's spec
 * validation when composed with the OpenShell driver's capabilities. The
 * relay is started on a free loopback port and closed again; no OpenShell
 * gateway is needed.
 */
import net from 'node:net';

import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      );
    });
  });
}

const previousPort = process.env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT;
afterAll(async () => {
  const { stopModelRelay } = await import('./openshell.js');
  await stopModelRelay();
  if (previousPort === undefined) delete process.env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT;
  else process.env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT = previousPort;
});

describe('openshell gateway provider registration', () => {
  it('registers kind openshell with its agent skill, and ensure() contributes the relay env', async () => {
    const port = await freePort();
    process.env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT = String(port);
    const registry = await import('./gateway-provider-registry.js');
    await import('./openshell.js');
    const provider = registry.getGatewayProviderRegistration('openshell');
    expect(provider?.agentSkills).toEqual(['openshell-gateway']);

    const lease = await provider!.sessions.ensure(
      {
        key: { installSlug: 'test', agentGroupId: 'ag', sessionId: 's' },
        runtimeIdentity: 'test/ag/s',
        groupName: 'Test',
        containerName: 'c',
        capabilities: {
          isolationTiers: ['container'],
          admissionEnforced: false,
          networkPolicy: 'declarative',
          encryptedVolumes: false,
          unrealized: [],
          sharedNetworkNamespace: true,
          auxiliaryContainers: false,
          imageBuild: false,
        },
      },
      new AbortController().signal,
    );
    expect(lease.contribution).toEqual({
      env: { ANTHROPIC_BASE_URL: `http://host.openshell.internal:${port}`, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
      networkAccess: { endpoint: 'host.openshell.internal', target: { kind: 'host' } },
    });

    // The relay answers on loopback; with no host credential it refuses
    // rather than forwarding an unauthenticated request upstream.
    const saved = { key: process.env.ANTHROPIC_API_KEY, oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      let res: Response | undefined;
      for (let i = 0; i < 20 && !res; i++) {
        res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' }).catch(
          () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 50)),
        );
      }
      expect(res?.status).toBe(503);
      expect(await res!.text()).toMatch(/no credential/);
    } finally {
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.oauth !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = saved.oauth;
    }
  });

  it('refuses sessions on a runtime without declarative egress (e.g. Docker)', async () => {
    const registry = await import('./gateway-provider-registry.js');
    const provider = registry.getGatewayProviderRegistration('openshell')!;
    await expect(
      provider.sessions.ensure(
        {
          key: { installSlug: 'test', agentGroupId: 'ag', sessionId: 's2' },
          runtimeIdentity: 'test/ag/s2',
          groupName: 'Test',
          containerName: 'c2',
          capabilities: {
            isolationTiers: ['container'],
            admissionEnforced: false,
            networkPolicy: 'topology',
            encryptedVolumes: false,
            unrealized: [],
            sharedNetworkNamespace: false,
            auxiliaryContainers: false,
            imageBuild: true,
          },
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/requires the openshell session driver/);
  });

  it('approval subscription stays pending until aborted', async () => {
    const registry = await import('./gateway-provider-registry.js');
    const provider = registry.getGatewayProviderRegistration('openshell')!;
    const controller = new AbortController();
    let settled = false;
    const pending = provider.approvals
      .subscribe(async () => 'deny', controller.signal)
      .then(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    controller.abort();
    await pending;
    expect(settled).toBe(true);
  });
});
