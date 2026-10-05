/**
 * The OpenShell model relay's port: one per install, chosen at setup, never a
 * shared fixed default.
 *
 * The relay port and the sandbox egress allow-list port must be the same
 * number, so setup always writes BOTH keys from one value (relayPortEnv). Two
 * NanoClaw copies on one box must never share a port: a sandbox pointed at a
 * port its own host does not hold would reach the OTHER copy's relay, which
 * adds that copy's credential.
 *
 * Ownership: the relay answers GET RELAY_IDENTITY_PATH with its install slug
 * (src/gateway-providers/openshell-core.ts — same path, kept equal by a test),
 * so "in use" can be told apart from "in use by this install's own host".
 */
import { createHash } from 'crypto';
import net from 'net';

/** The fixed default earlier versions wrote; treated as "not chosen yet". */
export const LEGACY_RELAY_PORT = 18790;
export const RELAY_PORT_RANGE = { min: 20000, size: 10000 } as const;
export const RELAY_IDENTITY_PATH = '/.nanoclaw/relay-identity';

export const RELAY_PORT_KEY = 'NANOCLAW_OPENSHELL_MODEL_RELAY_PORT';
export const EGRESS_PORTS_KEY = 'NANOCLAW_OPENSHELL_GATEWAY_PORTS';

/** Deterministic first choice for an install, inside RELAY_PORT_RANGE. */
export function candidateRelayPort(installSlug: string): number {
  const n = parseInt(createHash('sha1').update(installSlug).digest('hex').slice(0, 8), 16);
  return RELAY_PORT_RANGE.min + (n % RELAY_PORT_RANGE.size);
}

/** Both keys, from one value — the only way setup writes either of them. */
export function relayPortEnv(port: number): Record<string, string> {
  return { [RELAY_PORT_KEY]: String(port), [EGRESS_PORTS_KEY]: String(port) };
}

export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

/**
 * The install slug of the relay listening on `port`, or undefined if it is not
 * a NanoClaw relay. A raw one-shot HTTP/1.0 request over `net` rather than
 * http.get: the probe may land on any process, and the socket must be
 * destroyed on every path so nothing keeps setup's event loop alive.
 */
export function relayOwner(port: number, timeoutMs = 1500): Promise<string | undefined> {
  return new Promise((resolve) => {
    let raw = '';
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (install: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(install);
    };
    const timer = setTimeout(() => done(undefined), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`GET ${RELAY_IDENTITY_PATH} HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n`));
    socket.on('data', (chunk: string) => {
      raw += chunk;
      if (raw.length > 8192) done(undefined);
    });
    socket.on('end', () => {
      const [head, body = ''] = raw.split('\r\n\r\n');
      if (!/^HTTP\/1\.[01] 200 /.test(head)) return done(undefined);
      try {
        const install = (JSON.parse(body) as { install?: unknown }).install;
        done(typeof install === 'string' ? install : undefined);
      } catch {
        done(undefined);
      }
    });
    socket.on('error', () => done(undefined));
    socket.on('close', () => done(undefined));
  });
}

export type PortState = 'free' | 'ours' | 'taken';

export async function portState(port: number, installSlug: string): Promise<PortState> {
  if (await isPortFree(port)) return 'free';
  return (await relayOwner(port)) === installSlug ? 'ours' : 'taken';
}

export interface RelayPortChoice {
  port: number;
  /** Why this port: kept the configured one, or picked a new one. */
  source: 'kept' | 'selected';
  replaced?: { port: number; why: 'legacy-default' | 'taken' };
}

/**
 * Keep the configured port when it is this install's (free, or held by this
 * install's own relay); otherwise walk the install's range from its
 * deterministic candidate to the first free port. The egress key is not
 * consulted: the caller rewrites it from the result (relayPortEnv).
 */
export async function selectRelayPort(
  existing: Record<string, string | undefined>,
  installSlug: string,
  state: (port: number) => Promise<PortState> = (p) => portState(p, installSlug),
): Promise<RelayPortChoice> {
  const raw = existing[RELAY_PORT_KEY]?.trim();
  // Earlier versions wrote only the egress key, with the fixed legacy port.
  const configured = raw ? Number(raw) : existing[EGRESS_PORTS_KEY]?.trim() ? LEGACY_RELAY_PORT : NaN;
  let replaced: RelayPortChoice['replaced'];
  if (Number.isInteger(configured) && configured > 0 && configured < 65536) {
    if (configured === LEGACY_RELAY_PORT) replaced = { port: configured, why: 'legacy-default' };
    else if ((await state(configured)) !== 'taken') return { port: configured, source: 'kept' };
    else replaced = { port: configured, why: 'taken' };
  }
  const start = candidateRelayPort(installSlug) - RELAY_PORT_RANGE.min;
  for (let i = 0; i < 200; i++) {
    const port = RELAY_PORT_RANGE.min + ((start + i) % RELAY_PORT_RANGE.size);
    if (port === replaced?.port) continue;
    if ((await state(port)) === 'free') return { port, source: 'selected', ...(replaced ? { replaced } : {}) };
  }
  throw new Error(
    `No free port for the OpenShell model relay in ${RELAY_PORT_RANGE.min}-${RELAY_PORT_RANGE.min + RELAY_PORT_RANGE.size - 1}`,
  );
}
