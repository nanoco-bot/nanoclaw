/**
 * Pure core of the `openshell` gateway provider (no NanoClaw imports beyond
 * types, so it is unit-testable without a host).
 *
 * Generalized from the POC's `openshell-demo-core.ts`
 * (nanoco-bot/poc-nvidia-openshell, demo/nanoclaw/overlay/gateway-providers),
 * minus everything demo-only (mock CRM URL/token, `kind: 'openshell-demo'`).
 *
 * Division of labor — the NanoClaw gateway seam realized on OpenShell:
 *  - EGRESS belongs to OpenShell. Every byte a sandbox sends leaves through the
 *    OpenShell supervisor proxy, which allows or denies per the policy the
 *    `openshell` session driver compiled. This provider decides nothing about
 *    reachability.
 *  - MODEL CREDENTIALS belong to this provider. Agents get
 *    `ANTHROPIC_BASE_URL=<relay>` + `ANTHROPIC_AUTH_TOKEN=gateway-managed`
 *    (the same contribution shape the OneCLI provider uses); the relay, on the
 *    host, swaps in the real credential at request time. The real key never
 *    enters a sandbox.
 */

export interface OpenShellGatewayConfig {
  /** Name agents use to reach host services through the OpenShell proxy. */
  hostAlias: string;
  /** Loopback port the model relay listens on. Must be in the driver's NANOCLAW_OPENSHELL_GATEWAY_PORTS. */
  relayPort: number;
  /** Upstream model API the relay forwards to. */
  modelUpstream: string;
}

/** Settings this provider reads (from `process.env`, then `.env`). None is a secret. */
export const OPENSHELL_GATEWAY_SETTING_KEYS = [
  'NANOCLAW_OPENSHELL_HOST_ALIAS',
  'NANOCLAW_OPENSHELL_MODEL_RELAY_PORT',
  'NANOCLAW_OPENSHELL_MODEL_UPSTREAM',
] as const;

export const DEFAULTS = {
  hostAlias: 'host.openshell.internal',
  relayPort: 18790,
  modelUpstream: 'https://api.anthropic.com',
} as const;

function port(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name}='${v}' must be a TCP port`);
  return n;
}

export function openShellGatewayConfig(env: Record<string, string | undefined>): OpenShellGatewayConfig {
  const upstream = env.NANOCLAW_OPENSHELL_MODEL_UPSTREAM?.trim() || DEFAULTS.modelUpstream;
  let parsed: URL;
  try {
    parsed = new URL(upstream);
  } catch (err) {
    throw new Error(`NANOCLAW_OPENSHELL_MODEL_UPSTREAM='${upstream}' is not a URL`, { cause: err });
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`NANOCLAW_OPENSHELL_MODEL_UPSTREAM='${upstream}' must be http(s)`);
  }
  return {
    hostAlias: env.NANOCLAW_OPENSHELL_HOST_ALIAS?.trim() || DEFAULTS.hostAlias,
    relayPort: port(env.NANOCLAW_OPENSHELL_MODEL_RELAY_PORT, DEFAULTS.relayPort, 'NANOCLAW_OPENSHELL_MODEL_RELAY_PORT'),
    modelUpstream: parsed.origin,
  };
}

/** The typed per-session contribution (env lane = ContainerSpec.contributedEnv). */
export function contributionEnv(cfg: OpenShellGatewayConfig): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://${cfg.hostAlias}:${cfg.relayPort}`,
    ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
  };
}

// ---------- model relay: credential injection at request time ----------

export type ModelCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; value: string } | { kind: 'none' };

/**
 * The relay's credential comes from the HOST process environment only — never
 * from `.env`, never from an agent. (See the skill's SKILL.md for how to
 * provide it to the service.)
 */
export function modelCredentialFromEnv(env: Record<string, string | undefined>): ModelCredential {
  if (env.ANTHROPIC_API_KEY?.trim()) return { kind: 'api-key', value: env.ANTHROPIC_API_KEY.trim() };
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { kind: 'oauth', value: env.CLAUDE_CODE_OAUTH_TOKEN.trim() };
  return { kind: 'none' };
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Outbound headers for the upstream model API: the agent's placeholder auth is
 * DROPPED and the real credential set. Whatever the agent sent for auth never
 * reaches upstream, and the real value never travels back to the agent.
 */
export function relayHeaders(
  incoming: Record<string, string | string[] | undefined>,
  cred: ModelCredential,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (v === undefined || HOP_BY_HOP.has(key) || key === 'authorization' || key === 'x-api-key') continue;
    out[key] = v;
  }
  if (cred.kind === 'api-key') out['x-api-key'] = cred.value;
  if (cred.kind === 'oauth') {
    out.authorization = `Bearer ${cred.value}`;
    // Subscription OAuth tokens are accepted by the Messages API only with this beta flag.
    const beta = typeof out['anthropic-beta'] === 'string' ? out['anthropic-beta'] : '';
    if (
      !beta
        .split(',')
        .map((s) => s.trim())
        .includes('oauth-2025-04-20')
    ) {
      out['anthropic-beta'] = beta ? `${beta},oauth-2025-04-20` : 'oauth-2025-04-20';
    }
  }
  return out;
}
