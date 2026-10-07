/**
 * `openshell` gateway provider — NanoClaw's gateway seam realized with NVIDIA
 * OpenShell as the egress enforcer (see openshell-core.ts for the division of
 * labor). Requires the `openshell` session driver (NANOCLAW_RUNTIME_DRIVER=openshell):
 * the relay address it contributes only resolves inside an OpenShell sandbox.
 *
 * Relay lifetime = approval-subscription lifetime. Core treats a subscription
 * that fails or ends as "gateway unavailable": it stops sessions, closes
 * session admission, and retries the subscription with backoff. So:
 *   - subscribe() binds the relay on this install's port and stays pending
 *     only while it is listening;
 *   - a bind failure (EADDRINUSE: another copy holds the port) fails the
 *     subscription, so NO session is admitted pointing at a port this process
 *     does not own;
 *   - ensure() re-checks that the relay it contributes is the one listening.
 *
 * Scope, stated plainly:
 *  - no approval holds: OpenShell enforces allow/deny itself, and its live
 *    rule proposals are operated with `ncl openshell-policy-*`, not through
 *    NanoClaw's approval cards;
 *  - the model relay is a minimal header-swapping reverse proxy for the
 *    Anthropic Messages API.
 */
import http from 'node:http';
import https from 'node:https';

import { INSTALL_SLUG } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';
import {
  OPENSHELL_GATEWAY_SETTING_KEYS,
  RELAY_IDENTITY_PATH,
  contributionEnv,
  modelCredentialFromEnv,
  openShellGatewayConfig,
  relayHeaders,
  userFacingError,
  type OpenShellGatewayConfig,
} from './openshell-core.js';

interface RelayState {
  server: http.Server;
  port: number;
  /** Settles when the server stops listening (closed or errored). */
  closed: Promise<void>;
}

let relay: RelayState | null = null;

/** Non-secret settings: process.env wins, then `.env`. */
function settings(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = readEnvFile([...OPENSHELL_GATEWAY_SETTING_KEYS]);
  for (const key of OPENSHELL_GATEWAY_SETTING_KEYS) {
    if (process.env[key]?.trim()) merged[key] = process.env[key];
  }
  return merged;
}

function handler(cfg: OpenShellGatewayConfig): http.RequestListener {
  const upstream = new URL(cfg.modelUpstream);
  const client = upstream.protocol === 'https:' ? https : http;
  return (req, res) => {
    if (req.method === 'GET' && req.url === RELAY_IDENTITY_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ install: INSTALL_SLUG }));
      return;
    }
    // Read per request: the credential lives in the service environment.
    const cred = modelCredentialFromEnv(process.env);
    if (cred.kind === 'none') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'api_error',
            message:
              'OpenShell gateway model relay has no credential: set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in the NanoClaw host service environment',
          },
        }),
      );
      return;
    }
    const target = new URL(req.url ?? '/', upstream);
    const up = client.request(
      target,
      { method: req.method, headers: { ...relayHeaders(req.headers, cred), host: target.host } },
      (upRes) => {
        log.debug('OpenShell gateway: model relay', {
          method: req.method,
          path: target.pathname,
          status: upRes.statusCode,
        });
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', (err) => {
      log.warn('OpenShell gateway: model relay upstream error', { err: err.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model relay upstream unreachable' } }),
      );
    });
    req.pipe(up);
  };
}

/** Bind the relay on loopback; rejects (and leaves no relay) when the port cannot be bound. */
function startModelRelay(cfg: OpenShellGatewayConfig): Promise<RelayState> {
  if (relay) return Promise.resolve(relay);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler(cfg));
    let settleClosed!: () => void;
    const closed = new Promise<void>((r) => (settleClosed = r));
    server.once('error', (err) => {
      log.error('OpenShell gateway: model relay failed to listen; refusing sessions until it can', {
        port: cfg.relayPort,
        err: err.message,
      });
      reject(err);
    });
    server.listen(cfg.relayPort, '127.0.0.1', () => {
      const state: RelayState = { server, port: cfg.relayPort, closed };
      relay = state;
      server.on('error', (err) => {
        log.error('OpenShell gateway: model relay error', { port: cfg.relayPort, err: err.message });
        if (relay === state) relay = null;
        settleClosed();
      });
      server.on('close', () => {
        if (relay === state) relay = null;
        settleClosed();
      });
      log.info('OpenShell gateway: model relay listening', {
        address: `127.0.0.1:${cfg.relayPort}`,
        upstream: new URL(cfg.modelUpstream).origin,
        credential: modelCredentialFromEnv(process.env).kind, // kind only — never the value
      });
      resolve(state);
    });
  });
}

/** Close the relay (subscription abort, tests). */
export async function stopModelRelay(): Promise<void> {
  const state = relay;
  relay = null;
  if (state) await new Promise<void>((resolve) => state.server.close(() => resolve()));
}

/** Test seam: the port the relay is listening on, if any. */
export function relayListeningPort(): number | undefined {
  return relay?.port;
}

registerGatewayProvider({
  kind: 'openshell',
  agentSkills: ['openshell-gateway'],
  sessions: {
    async ensure(input) {
      // Fail closed off OpenShell: the relay address resolves only inside an
      // OpenShell sandbox, and egress to it is granted by the declarative
      // sandbox policy. A topology-enforced runtime (Docker) can realize
      // neither, so no session starts with a gateway that cannot work.
      if (input.capabilities.networkPolicy !== 'declarative') {
        throw new Error(
          'The OpenShell gateway requires the openshell session driver (NANOCLAW_RUNTIME_DRIVER=openshell); ' +
            `the selected runtime enforces egress by '${input.capabilities.networkPolicy}'.`,
        );
      }
      const cfg = openShellGatewayConfig(settings());
      // Never point a sandbox at a port this process does not hold: if the
      // relay is down, or bound to a port the config no longer names (setup
      // re-run without a restart), the sandbox would reach whatever owns it.
      if (!relay || relay.port !== cfg.relayPort) {
        throw userFacingError(
          `OpenShell model relay is not listening on configured port ${cfg.relayPort}` +
            (relay ? ` (listening on ${relay.port}; restart NanoClaw)` : ''),
          "I can't reach my model right now: this NanoClaw install's model relay isn't running. The operator needs to check the host logs and restart NanoClaw.",
        );
      }
      if (modelCredentialFromEnv(process.env).kind === 'none') {
        throw userFacingError(
          'OpenShell model relay has no credential (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN missing from the service environment); refusing session',
          "I can't reply yet: no Claude credential is configured for this NanoClaw install. The operator needs to run setup's sign-in step (`pnpm exec tsx setup/index.ts --step gateway-auth`) and restart NanoClaw.",
        );
      }
      return {
        contribution: {
          env: contributionEnv(cfg),
          // Egress is enforced by OpenShell policy (driver capability
          // networkPolicy: 'declarative'); this names where the gateway lives.
          networkAccess: { endpoint: cfg.hostAlias, target: { kind: 'host' } },
        },
      };
    },
  },
  approvals: {
    // Pending == relay listening. Ending/throwing tells core the gateway is
    // unavailable: it closes session admission and retries with backoff.
    // OpenShell allow/deny is enforced by the gateway itself, so nothing is
    // forwarded for approval.
    async subscribe(_decide, signal) {
      if (signal.aborted) return;
      const state = await startModelRelay(openShellGatewayConfig(settings()));
      await new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        signal.addEventListener('abort', onAbort, { once: true });
        void state.closed.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      if (signal.aborted) await stopModelRelay();
      else throw new Error('OpenShell model relay stopped listening');
    },
  },
});
