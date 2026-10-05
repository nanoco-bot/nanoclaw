/**
 * `openshell` gateway provider — NanoClaw's gateway seam realized with NVIDIA
 * OpenShell as the egress enforcer (see openshell-core.ts for the division of
 * labor). Requires the `openshell` session driver (NANOCLAW_RUNTIME_DRIVER=openshell):
 * the relay address it contributes only resolves inside an OpenShell sandbox.
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

import { readEnvFile } from '../env.js';
import { log } from '../log.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';
import {
  OPENSHELL_GATEWAY_SETTING_KEYS,
  contributionEnv,
  modelCredentialFromEnv,
  openShellGatewayConfig,
  relayHeaders,
  type OpenShellGatewayConfig,
} from './openshell-core.js';

let relay: http.Server | null = null;

/** Non-secret settings: process.env wins, then `.env`. */
function settings(): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = readEnvFile([...OPENSHELL_GATEWAY_SETTING_KEYS]);
  for (const key of OPENSHELL_GATEWAY_SETTING_KEYS) {
    if (process.env[key]?.trim()) merged[key] = process.env[key];
  }
  return merged;
}

function startModelRelay(cfg: OpenShellGatewayConfig): void {
  if (relay) return;
  const upstream = new URL(cfg.modelUpstream);
  const client = upstream.protocol === 'https:' ? https : http;
  relay = http.createServer((req, res) => {
    // Read per request so a credential rotated in the service environment
    // takes effect on restart without re-reading anything at import time.
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
  });
  // Loopback only: the OpenShell supervisor reaches it as the host alias;
  // nothing off-box can talk to the credential injector.
  relay.on('error', (err) => {
    // Never take the host down (an unhandled 'error' on a server is an
    // uncaught exception). Sessions fail their model calls and say so; the
    // next ensure() retries the bind.
    log.error('OpenShell gateway: model relay failed to listen', { port: cfg.relayPort, err: err.message });
    relay = null;
  });
  relay.listen(cfg.relayPort, '127.0.0.1', () => {
    log.info('OpenShell gateway: model relay listening', {
      address: `127.0.0.1:${cfg.relayPort}`,
      upstream: upstream.origin,
      credential: modelCredentialFromEnv(process.env).kind, // kind only — never the value
    });
  });
}

/** Close the relay (tests; the host simply exits). */
export async function stopModelRelay(): Promise<void> {
  const server = relay;
  relay = null;
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
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
      startModelRelay(cfg);
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
    // Must stay pending until aborted: a subscription that ENDS means "bridge
    // down" to core, which closes session admission. OpenShell allow/deny is
    // enforced by the gateway itself, so nothing is forwarded for approval.
    subscribe(_decide, signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  },
});
