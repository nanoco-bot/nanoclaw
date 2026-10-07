/**
 * Installed-shape checks for the `openshell` gateway provider, against real
 * loopback sockets (no OpenShell gateway needed):
 *  - the relay's lifetime is the approval subscription's, so a port another
 *    process holds fails the subscription (core then closes admission);
 *  - ensure() never contributes a relay this process is not listening on;
 *  - without a host credential, ensure() refuses with a user-facing message.
 */
import http from 'node:http';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { INSTALL_SLUG } from '../config.js';
import type { DriverCapabilities } from '../drivers/types.js';
import { getGatewayProviderRegistration } from './gateway-provider-registry.js';
import { RELAY_IDENTITY_PATH } from './openshell-core.js';
import { relayListeningPort, stopModelRelay } from './openshell.js';

const provider = () => getGatewayProviderRegistration('openshell')!;

const OPENSHELL_CAPS: DriverCapabilities = {
  isolationTiers: ['container'],
  admissionEnforced: false,
  networkPolicy: 'declarative',
  encryptedVolumes: false,
  unrealized: [],
  sharedNetworkNamespace: true,
  auxiliaryContainers: false,
  imageBuild: false,
};

const input = (capabilities: DriverCapabilities = OPENSHELL_CAPS, sessionId = 's') => ({
  key: { installSlug: 'test', agentGroupId: 'ag', sessionId },
  runtimeIdentity: `test/ag/${sessionId}`,
  groupName: 'Test',
  containerName: 'c',
  capabilities,
});

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Start the subscription; resolves once the relay is listening (or the subscription settled). */
async function subscribe(controller: AbortController): Promise<{ running: Promise<unknown> }> {
  const running = provider()
    .approvals.subscribe(async () => 'deny', controller.signal)
    .then(
      () => 'ended',
      (err: Error) => err,
    );
  for (let i = 0; i < 50 && relayListeningPort() === undefined; i++) {
    const settled = await Promise.race([running.then(() => true), new Promise((r) => setTimeout(() => r(false), 20))]);
    if (settled) break;
  }
  // Wrapped: an async function returning a bare promise would adopt it and wait for the subscription to end.
  return { running };
}

let port: number;
const controllers: AbortController[] = [];

beforeEach(async () => {
  port = await freePort();
  vi.stubEnv('NANOCLAW_OPENSHELL_MODEL_RELAY_PORT', String(port));
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-api03-FAKE-for-tests');
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  await import('./openshell.js');
});
afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort();
  await stopModelRelay();
  vi.unstubAllEnvs();
});

describe('openshell gateway provider', () => {
  it('registers kind openshell with its agent skill', () => {
    expect(provider().agentSkills).toEqual(['openshell-gateway']);
  });

  it('subscribe binds the relay on this install’s port; ensure() contributes exactly that port', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    await subscribe(controller);
    expect(relayListeningPort()).toBe(port);

    const lease = await provider().sessions.ensure(input(), new AbortController().signal);
    expect(lease.contribution).toEqual({
      env: { ANTHROPIC_BASE_URL: `http://host.openshell.internal:${port}`, ANTHROPIC_AUTH_TOKEN: 'gateway-managed' },
      networkAccess: { endpoint: 'host.openshell.internal', target: { kind: 'host' } },
    });

    // The ownership probe setup uses: answered locally, never forwarded.
    const identity = await fetch(`http://127.0.0.1:${port}${RELAY_IDENTITY_PATH}`);
    expect(await identity.json()).toEqual({ install: INSTALL_SLUG });
  });

  it('a port held by another process fails the subscription and no session is admitted', async () => {
    const squatter = http.createServer((_req, res) => res.end('another install'));
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    try {
      const controller = new AbortController();
      controllers.push(controller);
      const outcome = await (await subscribe(controller)).running;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as NodeJS.ErrnoException).code).toBe('EADDRINUSE');
      expect(relayListeningPort()).toBeUndefined();

      const refused = provider().sessions.ensure(input(), new AbortController().signal);
      await expect(refused).rejects.toThrow(`not listening on configured port ${port}`);
      await expect(refused).rejects.toMatchObject({ userMessage: expect.stringMatching(/model relay isn't running/) });
    } finally {
      squatter.closeAllConnections();
      await new Promise((r) => squatter.close(r));
    }
  });

  it('a relay bound to an old port (config changed without restart) is refused, not used', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    await subscribe(controller);
    vi.stubEnv('NANOCLAW_OPENSHELL_MODEL_RELAY_PORT', String(port + 1));
    await expect(provider().sessions.ensure(input(), new AbortController().signal)).rejects.toThrow(/restart NanoClaw/);
  });

  it('without a host credential, sessions are refused with a message for the chat', async () => {
    const controller = new AbortController();
    controllers.push(controller);
    await subscribe(controller);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const refused = provider().sessions.ensure(input(), new AbortController().signal);
    await expect(refused).rejects.toThrow(/no credential/);
    await expect(refused).rejects.toMatchObject({
      userMessage: expect.stringMatching(/no Claude credential is configured/),
    });
    // The relay itself still refuses to forward unauthenticated requests.
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
  });

  it('refuses sessions on a runtime without declarative egress (e.g. Docker)', async () => {
    await expect(
      provider().sessions.ensure(
        input({ ...OPENSHELL_CAPS, networkPolicy: 'topology', imageBuild: true }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/requires the openshell session driver/);
  });

  it('aborting the subscription closes the relay; the relay stopping ends the subscription', async () => {
    const first = new AbortController();
    const { running: ended } = await subscribe(first);
    first.abort();
    expect(await ended).toBe('ended');
    expect(relayListeningPort()).toBeUndefined();

    const second = new AbortController();
    controllers.push(second);
    const { running } = await subscribe(second);
    expect(relayListeningPort()).toBe(port);
    await stopModelRelay(); // e.g. the listener died
    expect(await running).toBeInstanceOf(Error);
  });
});
