import http from 'node:http';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { RELAY_IDENTITY_PATH as PAYLOAD_IDENTITY_PATH } from '../../.claude/skills/add-openshell/payload/src/gateway-providers/openshell-core.js';
import {
  EGRESS_PORTS_KEY,
  LEGACY_RELAY_PORT,
  RELAY_IDENTITY_PATH,
  RELAY_PORT_KEY,
  RELAY_PORT_RANGE,
  candidateRelayPort,
  isPortFree,
  portState,
  relayOwner,
  relayPortEnv,
  selectRelayPort,
  type PortState,
} from './openshell-relay-port.js';

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => {
      (s as http.Server).closeAllConnections?.();
      return new Promise((r) => s.close(r));
    }),
  );
});

function listen(server: net.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

const states =
  (map: Record<number, PortState>) =>
  async (port: number): Promise<PortState> =>
    map[port] ?? 'free';

describe('relay port selection', () => {
  it('relay port and egress allow-list are always written together from one value', () => {
    expect(relayPortEnv(23456)).toEqual({ [RELAY_PORT_KEY]: '23456', [EGRESS_PORTS_KEY]: '23456' });
  });

  it('derives a stable, per-install first choice inside the range (never the legacy shared port)', () => {
    const a = candidateRelayPort('d94cc5f6');
    expect(candidateRelayPort('d94cc5f6')).toBe(a);
    expect(candidateRelayPort('0badc0de')).not.toBe(a);
    expect(a).toBeGreaterThanOrEqual(RELAY_PORT_RANGE.min);
    expect(a).toBeLessThan(RELAY_PORT_RANGE.min + RELAY_PORT_RANGE.size);
    expect(a).not.toBe(LEGACY_RELAY_PORT);
  });

  it('fresh install: the candidate when free, else the next free port', async () => {
    const c = candidateRelayPort('slug1');
    expect(await selectRelayPort({}, 'slug1', states({}))).toEqual({ port: c, source: 'selected' });
    const next = c + 1 < RELAY_PORT_RANGE.min + RELAY_PORT_RANGE.size ? c + 1 : RELAY_PORT_RANGE.min;
    expect((await selectRelayPort({}, 'slug1', states({ [c]: 'taken' }))).port).toBe(next);
  });

  it('keeps a configured port that is free or held by this install’s own relay (setup re-run on a live host)', async () => {
    const existing = { [RELAY_PORT_KEY]: '24001', [EGRESS_PORTS_KEY]: '9' };
    expect(await selectRelayPort(existing, 's', states({}))).toEqual({ port: 24001, source: 'kept' });
    expect(await selectRelayPort(existing, 's', states({ 24001: 'ours' }))).toEqual({ port: 24001, source: 'kept' });
  });

  it('replaces a configured port another process holds, and the legacy fixed default', async () => {
    const taken = await selectRelayPort({ [RELAY_PORT_KEY]: '24001' }, 's', states({ 24001: 'taken' }));
    expect(taken).toMatchObject({ source: 'selected', replaced: { port: 24001, why: 'taken' } });
    expect(taken.port).not.toBe(24001);
    const legacy = await selectRelayPort({ [EGRESS_PORTS_KEY]: '18790' }, 's', states({}));
    expect(legacy).toMatchObject({ source: 'selected', replaced: { port: LEGACY_RELAY_PORT, why: 'legacy-default' } });
    const legacyExplicit = await selectRelayPort({ [RELAY_PORT_KEY]: '18790' }, 's', states({}));
    expect(legacyExplicit.port).not.toBe(LEGACY_RELAY_PORT);
  });

  it('the identity path matches what the relay serves', () => {
    expect(RELAY_IDENTITY_PATH).toBe(PAYLOAD_IDENTITY_PATH);
  });
});

describe('port probes against real loopback sockets', () => {
  it('isPortFree / portState tell free, our relay, and someone else apart', async () => {
    const relay = http.createServer((req, res) => {
      if (req.url === RELAY_IDENTITY_PATH) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ install: 'mine' }));
      } else res.writeHead(404).end();
    });
    const relayPort = await listen(relay);
    // A non-HTTP service: reads the request, answers garbage, closes.
    const other = await listen(net.createServer((s) => s.once('data', () => s.end('SSH-2.0-OpenSSH_9.6\r\n'))));

    expect(await isPortFree(relayPort)).toBe(false);
    expect(await relayOwner(relayPort)).toBe('mine');
    expect(await portState(relayPort, 'mine')).toBe('ours');
    expect(await portState(relayPort, 'another-install')).toBe('taken');
    expect(await relayOwner(other)).toBeUndefined();
    expect(await portState(other, 'mine')).toBe('taken');

    const free = await listen(net.createServer());
    await new Promise((r) => servers.pop()!.close(r));
    expect(await portState(free, 'mine')).toBe('free');
  });
});
