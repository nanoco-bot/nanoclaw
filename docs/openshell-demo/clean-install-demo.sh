#!/usr/bin/env bash
#
# NanoClaw + OpenShell — clean-install demo.
#
# Starting from nothing but a git clone, this script:
#   1. installs NanoClaw from nanoco-bot/nanoclaw (bob/openshell-standard-install, PR #1),
#   2. during setup, answers "yes" to "Enable OpenShell sandboxing?" (the new step this
#      PR adds) instead of the Docker default,
#   3. registers two agent identities, alice and bob, with an identical fake CRM
#      credential but DIFFERENT OpenShell egress policies,
#   4. asks both the same question and shows OpenShell allowing alice's call and
#      denying bob's — proving policy, not possession of the token, decides access,
#   5. exercises `ncl openshell-policy` (view / list / approve / reject / add-rule)
#      against the real running sandboxes.
#
# IMPORTANT — what's real vs. what's demo scaffolding:
#   - The OpenShell driver, the `openshell` gateway provider, the setup step, and the
#     `openshell-policy` CLI resource are the real, shipped PR code. Nothing about
#     those is faked.
#   - Demonstrating a live agent asking a question needs a model. This box has no
#     Anthropic credential, so this script installs a small LOCAL-ONLY stand-in
#     gateway provider (`openshell-demo`, written out by this script, NOT part of the
#     PR) that swaps in a scripted decision table instead of a real model call, and a
#     mock CRM server with 3 fake contacts. Every file this script writes under
#     demo/ is clearly commented as demo-only. Point this at a real ANTHROPIC_API_KEY
#     (see --real-model below) and the real `openshell` gateway carries the same
#     scene with actual Claude Code reasoning instead.
#
# Usage:
#   ./clean-install-demo.sh [workdir]              # clone + enable OpenShell + run the demo
#   ./clean-install-demo.sh [workdir] --teardown    # stop services started by this script
#
# Requirements on this machine: docker, a running OpenShell gateway + `openshell` CLI
# on PATH, Node >=22, pnpm (version pinned by the repo's package.json). No sudo, no
# credentials, no real customer data — see memory/lab-vm.md conventions.
set -euo pipefail

REPO_URL="${REPO_URL:-git@github.com:nanoco-bot/nanoclaw.git}"
BRANCH="${BRANCH:-bob/openshell-standard-install}"
WORKDIR="$(cd "$(dirname "${1:-./nanoclaw-openshell-demo}")" 2>/dev/null && pwd)/$(basename "${1:-./nanoclaw-openshell-demo}")" 2>/dev/null \
  || WORKDIR="$PWD/${1:-nanoclaw-openshell-demo}"
ACTION="${2:-run}"

CRM_PORT=18791
MODEL_RELAY_PORT=18790
SCRIPTED_MODEL_PORT=18793
CRM_TOKEN="demo-crm-token-NOT-A-REAL-SECRET"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m    %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
if [ "$ACTION" = "--teardown" ] || [ "${1:-}" = "--teardown" ]; then
  [ "${1:-}" = "--teardown" ] && WORKDIR="$PWD/nanoclaw-openshell-demo"
  log "Tearing down demo processes in $WORKDIR"
  pkill -f "tsx src/index.ts" 2>/dev/null || true
  pkill -f "demo/services/mock-crm.mjs" 2>/dev/null || true
  pkill -f "demo/services/scripted-model.ts" 2>/dev/null || true
  rm -f "$WORKDIR/data/ncl.sock" 2>/dev/null || true
  ok "Stopped. $WORKDIR left on disk for inspection; delete it yourself when done."
  exit 0
fi

# ---------------------------------------------------------------------------
log "Preflight"
command -v docker  >/dev/null || die "docker is required"
command -v openshell >/dev/null || die "openshell CLI not on PATH — the real gateway must already be running (see the lab's OpenShell gateway setup)"
command -v node >/dev/null || die "node >=22 is required"
command -v git  >/dev/null || die "git is required"
NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node >=22 required, found $(node -v)"
[ -e "$WORKDIR" ] && die "$WORKDIR already exists — pick an empty path so this really is a clean install (or rm -rf it first)"
ok "docker, openshell, node $(node -v), git all present. Target: $WORKDIR"

# ---------------------------------------------------------------------------
log "1/9 — Clean clone of nanoco-bot/nanoclaw @ $BRANCH"
git clone --branch "$BRANCH" "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"
ok "Cloned to $WORKDIR"

# ---------------------------------------------------------------------------
log "2/9 — pnpm install"
PNPM_PIN="$(node -e "console.log((require('./package.json').packageManager||'').split('@')[1]||'')")"
if [ -n "$PNPM_PIN" ] && ! pnpm -v 2>/dev/null | grep -qx "$PNPM_PIN"; then
  die "This repo pins pnpm@$PNPM_PIN (found $(pnpm -v 2>/dev/null || echo 'none')). Install it first: npm install -g pnpm@$PNPM_PIN"
fi
# better-sqlite3 needs its native build approved under pnpm's default-deny
# policy for build scripts; without this, install fails on a fresh lockfile.
node -e "
  const fs = require('fs');
  const path = 'pnpm-workspace.yaml';
  let y = fs.readFileSync(path, 'utf8');
  if (!/onlyBuiltDependencies:[\s\S]*better-sqlite3/.test(y)) {
    y = y.replace(/onlyBuiltDependencies:\n/, 'onlyBuiltDependencies:\n  - better-sqlite3\n');
    fs.writeFileSync(path, y);
    console.log('patched pnpm-workspace.yaml: allow better-sqlite3 native build');
  }
"
pnpm install --frozen-lockfile
ok "Dependencies installed"

# ---------------------------------------------------------------------------
log "3/9 — Build the base agent image (setup --step container)"
pnpm exec tsx setup/index.ts --step container
SLUG="$(node -e "console.log(require('crypto').createHash('sha1').update(process.cwd()).digest('hex').slice(0,8))")"
BASE_IMAGE="nanoclaw-agent-v2-${SLUG}:latest"
docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || die "expected base image $BASE_IMAGE not found after build"
ok "Base image: $BASE_IMAGE"

log "3b/9 — Derive an OpenShell-compatible image"
# OpenShell refuses any bind mount covering the image's own WORKDIR; the stock
# image sets WORKDIR /workspace/group, which collides with NanoClaw's session
# mount at /workspace. Move WORKDIR outside any mount target.
# Same builder setup's container step now runs on the openshell driver.
OPENSHELL_IMAGE="nanoclaw-agent-v2-${SLUG}:openshell"
pnpm exec tsx setup/lib/openshell-image.ts
ok "Derived image: $OPENSHELL_IMAGE"

# ---------------------------------------------------------------------------
log "4/9 — Enable OpenShell (the step this PR adds to setup)"
# This is the literal "Enable OpenShell sandboxing?" step a human sees in the
# interactive wizard, driven non-interactively here. --no-gateway: we install
# the demo-only credential-free gateway below instead of the real one, since
# this box has no Anthropic key. On a box with one, drop --no-gateway and
# --gateway openshell instead — see README-demo.md.
pnpm exec tsx setup/index.ts --step openshell -- --enable --bin "$(command -v openshell)" --no-gateway
grep -q '^NANOCLAW_RUNTIME_DRIVER=openshell$' .env || die "setup --step openshell did not wire the openshell driver into .env"
ok "OpenShell is now this install's default sandbox driver (.env: NANOCLAW_RUNTIME_DRIVER=openshell)"

# ---------------------------------------------------------------------------
log "5/9 — Write the demo-only harness (NOT part of the PR)"
mkdir -p demo/services demo/logs

cat > demo/services/mock-crm.mjs <<'EOF'
#!/usr/bin/env node
// Mock third-party CRM API (stands in for HubSpot). FAKE DATA ONLY.
// GET /v1/contacts with `Authorization: Bearer $DEMO_CRM_API_TOKEN` -> 200 + fake contacts; anything else -> 401.
// GET /__hits (loopback; for the Demo Console) -> every request this server has seen.
// Binds 127.0.0.1: sandboxes reach it only through the OpenShell proxy as host.openshell.internal.
import http from 'node:http';

const port = Number(process.env.DEMO_CRM_API_PORT || 18791);
const token = process.env.DEMO_CRM_API_TOKEN || 'demo-crm-token-NOT-A-REAL-SECRET';
const hits = [];

const CONTACTS = [
  { id: 'c-001', name: 'Ada Example', company: 'Example Corp', stage: 'customer' },
  { id: 'c-002', name: 'Grace Sample', company: 'Sample Ltd', stage: 'lead' },
  { id: 'c-003', name: 'Linus Placeholder', company: 'Placeholder Inc', stage: 'opportunity' },
];

http
  .createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname === '/__hits') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits.slice(-100)));
      return;
    }
    const authorized = req.headers.authorization === `Bearer ${token}`;
    const ok = authorized && req.method === 'GET' && url.pathname === '/v1/contacts';
    const status = ok ? 200 : authorized ? 404 : 401;
    hits.push({ at: new Date().toISOString(), method: req.method, path: url.pathname, status, agent: req.headers['user-agent'] || '' });
    if (hits.length > 1000) hits.splice(0, hits.length - 1000);
    console.log(`[mock-crm] ${req.method} ${url.pathname} -> ${status}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { source: 'mock-crm (fake data)', contacts: CONTACTS } : { error: status === 401 ? 'unauthorized' : 'not found' }));
  })
  .listen(port, '127.0.0.1', () => console.log(`[mock-crm] listening on 127.0.0.1:${port}`));
EOF

cat > demo/services/scripted-model.ts <<'EOF'
/**
 * Scripted stand-in for the Anthropic Messages API — for running/verifying the
 * demo where no model credential is available. NOT a model: a fixed decision
 * table. Everything around it is real: Claude Code (inside the NanoClaw
 * agent-runner, inside the OpenShell sandbox) receives these responses,
 * executes the tool call with its real Bash tool, and the resulting curl goes
 * through OpenShell's real egress proxy. With ANTHROPIC_API_KEY set, the
 * gateway relay points at api.anthropic.com instead and this is unused.
 *
 * Run: node --experimental-strip-types demo/services/scripted-model.ts
 * Binds 127.0.0.1:${DEMO_SCRIPTED_MODEL_PORT:-18793}.
 */
import http from 'node:http';
import { pathToFileURL } from 'node:url';

type Block = { type: string; text?: string; content?: unknown; name?: string };
type Msg = { role: string; content: string | Block[] };

export type Decision = { kind: 'text'; text: string } | { kind: 'tool'; name: string; input: Record<string, string> };

export const CRM_COMMAND = 'curl -sS -m 15 -w "\\nHTTP %{http_code}\\n" -H "Authorization: Bearer $CRM_API_TOKEN" "$CRM_API_URL/v1/contacts"';

function blockText(b: Block): string {
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return (b.content as Block[]).map(blockText).join('\n');
  return '';
}

function msgText(m: Msg): string {
  return typeof m.content === 'string' ? m.content : m.content.map(blockText).join('\n');
}

/** NanoClaw delivers only text wrapped as <message to="dest">; address it the way NanoClaw instructs a real model to. */
export function destinationFor(messages: Msg[], system: unknown): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = /<message\b[^>]*\bfrom="([^"]+)"/.exec(msgText(messages[i]));
    if (m) return m[1];
  }
  const sys = Array.isArray(system) ? (system as Block[]).map(blockText).join('\n') : typeof system === 'string' ? system : '';
  const fromSystem = /Your destination is `([^`]+)`/.exec(sys)?.[1];
  if (fromSystem) return fromSystem;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = /Your destinations: ([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/.exec(msgText(messages[i]));
    if (m) return m[1];
  }
  return null;
}

function reply(text: string, dest: string | null): Decision {
  return { kind: 'text', text: dest ? `<message to="${dest}">${text}</message>` : text };
}

/**
 * The whole "model". Looks at the newest MEANINGFUL turn — an inbound
 * <message> or a tool_result — skipping the system-role turns Claude Code
 * appends (token budgets, hook output) and NanoClaw's delivery reminders.
 */
export function decide(body: { messages?: Msg[]; tools?: Array<{ name: string }>; system?: unknown }): Decision {
  const messages = body.messages ?? [];
  const dest = destinationFor(messages, body.system);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [] : m.content;
    const toolResult = blocks.find((b) => b.type === 'tool_result');
    if (toolResult) {
      const out = blockText(toolResult);
      if (/"contacts"/.test(out) && /HTTP 200/.test(out)) {
        const names = [...out.matchAll(/"name":"([^"]+)"/g)].map((x) => x[1]);
        return reply(`CRM call succeeded (HTTP 200). Contacts: ${names.join(', ')}.`, dest);
      }
      if (/HTTP 401/.test(out)) return reply('The CRM answered 401 Unauthorized — the token was rejected.', dest);
      const reason = out.split('\n').find((l) => l.trim()) ?? 'no output';
      return reply(`The CRM call did not go through — the connection was blocked before reaching the API. curl said: ${reason.trim().slice(0, 300)}`, dest);
    }
    const text = msgText(m);
    // Only an INBOUND message (it carries from="…") is a turn to answer; NanoClaw's
    // delivery reminders also mention <message to=…> but are not one.
    if (!/<message\b[^>]*\bfrom="/.test(text)) continue;
    const hasBash = (body.tools ?? []).some((t) => t.name === 'Bash');
    if (hasBash && /\b(crm|contacts?)\b/i.test(text)) {
      return { kind: 'tool', name: 'Bash', input: { command: CRM_COMMAND, description: 'Fetch contacts from the CRM API' } };
    }
    return reply('Hi! Ask me to "fetch the CRM contacts" and I will call the CRM API with the token I was given.', dest);
  }
  return reply('Hello.', dest);
}

function sse(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function respond(res: http.ServerResponse, model: string, stream: boolean, d: Decision): void {
  const id = `msg_scripted_${Date.now()}`;
  const block =
    d.kind === 'text'
      ? { type: 'text', text: d.text }
      : { type: 'tool_use', id: `toolu_scripted_${Date.now()}`, name: d.name, input: d.input };
  const stop = d.kind === 'text' ? 'end_turn' : 'tool_use';
  const usage = { input_tokens: 10, output_tokens: 10 };
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [block], stop_reason: stop, stop_sequence: null, usage }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  sse(res, 'message_start', {
    type: 'message_start',
    message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } },
  });
  if (d.kind === 'text') {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: d.text } });
  } else {
    sse(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: (block as { id: string }).id, name: d.name, input: {} } });
    sse(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(d.input) } });
  }
  sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 10 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

export function startScriptedModel(port: number): http.Server {
  return http
    .createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":10}');
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/messages') {
        let body: { model?: string; stream?: boolean; messages?: Msg[]; tools?: Array<{ name: string }>; system?: unknown } = {};
        try {
          body = JSON.parse(raw);
        } catch {
          /* empty body -> default reply */
        }
        const d = decide(body);
        console.log(`[scripted-model] ${body.model ?? '?'} stream=${!!body.stream} -> ${d.kind === 'tool' ? `tool_use ${d.name}` : 'text'}`);
        respond(res, body.model ?? 'scripted', !!body.stream, d);
        return;
      }
      console.log(`[scripted-model] unhandled ${req.method} ${url.pathname}`);
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"type":"error","error":{"type":"not_found_error","message":"scripted model: unsupported endpoint"}}');
    })
    .listen(port, '127.0.0.1', () => console.log(`[scripted-model] listening on 127.0.0.1:${port} (NOT a real model)`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startScriptedModel(Number(process.env.DEMO_SCRIPTED_MODEL_PORT || 18793));
}
EOF

cat > demo/agent-instructions.md <<'EOF'
## Demo: CRM access

You are a NanoClaw demo agent. Your environment provides credentials for a CRM API (a mock with fake data):

- base URL: environment variable `CRM_API_URL`
- bearer token: environment variable `CRM_API_TOKEN`

To list contacts, run exactly this with the Bash tool:

```bash
curl -sS -m 15 -w "\nHTTP %{http_code}\n" -H "Authorization: Bearer $CRM_API_TOKEN" "$CRM_API_URL/v1/contacts"
```

When asked to fetch the CRM contacts, run that command once and report the outcome faithfully:
on success list the contact names; if the connection fails, say the call was blocked before reaching
the API and quote curl's error. Do not retry with other tools or hosts, and never print the token.
EOF

cat > demo/policy.json <<EOF
{
  "\$comment": "Local-only test fixture (not part of the PR): alice gets CRM egress, bob does not. Model-gateway egress for both comes from the driver's own settings-derived defaults (NANOCLAW_OPENSHELL_GATEWAY_PORTS/BINARIES in .env), not restated here.",
  "groups": {
    "alice": {
      "egress": [
        { "name": "crm_api", "host": "host.openshell.internal", "ports": [${CRM_PORT}], "binaries": ["/usr/bin/curl"] }
      ]
    },
    "bob": {}
  }
}
EOF

cat > src/gateway-providers/openshell-demo-core.ts <<'EOF'
/**
 * Pure core of the `openshell-demo` gateway provider — LOCAL-ONLY DEMO
 * SCAFFOLDING, NOT PART OF THE PR. Written out by demo/clean-install-demo.sh
 * so the alice/bob allow/deny story runs without a real Anthropic credential.
 *
 * Division of labor — this is the NanoClaw gateway seam realized on OpenShell:
 *  - EGRESS is OpenShell's: every byte a sandbox sends leaves through the
 *    OpenShell supervisor proxy, which allows or denies per the policy the
 *    session driver compiled (per agent group). This provider decides nothing
 *    about reachability.
 *  - MODEL CREDENTIALS are this provider's: agents get
 *    `ANTHROPIC_BASE_URL=<relay>` + `ANTHROPIC_AUTH_TOKEN=gateway-managed`
 *    (the exact pattern NanoClaw's shipped OneCLI gateway uses); the relay,
 *    on the host, swaps in the real credential at request time. The real key
 *    never enters a sandbox.
 *  - The demo's THIRD-PARTY token is deliberately handed to EVERY agent as
 *    plain env (CRM_API_TOKEN) — that reproduces "same credential injected
 *    into both agents" so the proof is that policy, not possession of the
 *    token, decides who can use it. It is a fake token for a mock API; never
 *    put a real partner credential here.
 */

export interface DemoGatewayConfig {
  hostAlias: string;
  relayPort: number;
  crmApiPort: number;
  crmApiToken: string;
}

export const DEFAULTS = {
  hostAlias: 'host.openshell.internal',
  relayPort: 18790,
  crmApiPort: 18791,
  crmApiToken: 'demo-crm-token-NOT-A-REAL-SECRET',
  modelUpstream: 'https://api.anthropic.com',
} as const;

function port(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name}='${v}' must be a TCP port`);
  return n;
}

export function demoGatewayConfig(env: NodeJS.ProcessEnv): DemoGatewayConfig {
  return {
    hostAlias: env.DEMO_HOST_ALIAS?.trim() || DEFAULTS.hostAlias,
    relayPort: port(env.DEMO_MODEL_RELAY_PORT, DEFAULTS.relayPort, 'DEMO_MODEL_RELAY_PORT'),
    crmApiPort: port(env.DEMO_CRM_API_PORT, DEFAULTS.crmApiPort, 'DEMO_CRM_API_PORT'),
    crmApiToken: env.DEMO_CRM_API_TOKEN?.trim() || DEFAULTS.crmApiToken,
  };
}

export function demoContributionEnv(cfg: DemoGatewayConfig): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://${cfg.hostAlias}:${cfg.relayPort}`,
    ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
    CRM_API_URL: `http://${cfg.hostAlias}:${cfg.crmApiPort}`,
    CRM_API_TOKEN: cfg.crmApiToken,
  };
}

export type ModelCredential = { kind: 'api-key'; value: string } | { kind: 'oauth'; value: string } | { kind: 'none' };

export function modelCredentialFromEnv(env: NodeJS.ProcessEnv): ModelCredential {
  if (env.ANTHROPIC_API_KEY?.trim()) return { kind: 'api-key', value: env.ANTHROPIC_API_KEY.trim() };
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return { kind: 'oauth', value: env.CLAUDE_CODE_OAUTH_TOKEN.trim() };
  return { kind: 'none' };
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

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
    const beta = typeof out['anthropic-beta'] === 'string' ? out['anthropic-beta'] : '';
    if (!beta.split(',').map((s) => s.trim()).includes('oauth-2025-04-20')) {
      out['anthropic-beta'] = beta ? `${beta},oauth-2025-04-20` : 'oauth-2025-04-20';
    }
  }
  return out;
}
EOF

cat > src/gateway-providers/openshell-demo.ts <<'EOF'
/**
 * `openshell-demo` gateway provider — LOCAL-ONLY DEMO SCAFFOLDING, NOT PART
 * OF THE PR. Written out by demo/clean-install-demo.sh so this demo can run
 * on a box with no Anthropic credential. POC/demo grade:
 *  - no approval holds (OpenShell enforces allow/deny statically; nothing to approve),
 *  - the model relay is a minimal header-swapping reverse proxy.
 */
import http from 'node:http';
import https from 'node:https';

import { log } from '../log.js';

import { registerGatewayProvider } from './gateway-provider-registry.js';
import {
  DEFAULTS,
  demoContributionEnv,
  demoGatewayConfig,
  modelCredentialFromEnv,
  relayHeaders,
  type DemoGatewayConfig,
} from './openshell-demo-core.js';

let relay: http.Server | null = null;

function startModelRelay(cfg: DemoGatewayConfig): void {
  if (relay) return;
  const upstream = new URL(process.env.DEMO_MODEL_UPSTREAM?.trim() || DEFAULTS.modelUpstream);
  const cred = modelCredentialFromEnv(process.env);
  const client = upstream.protocol === 'https:' ? https : http;
  relay = http.createServer((req, res) => {
    if (cred.kind === 'none' && upstream.hostname === 'api.anthropic.com') {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model relay has no credential: set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) in the NanoClaw host environment' } }));
      return;
    }
    const target = new URL(req.url ?? '/', upstream);
    const up = client.request(
      target,
      { method: req.method, headers: { ...relayHeaders(req.headers, cred), host: target.host } },
      (upRes) => {
        log.info('Model relay', { method: req.method, path: target.pathname, status: upRes.statusCode });
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', (err) => {
      log.warn('Model relay upstream error', { err: err.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'model relay upstream unreachable' } }));
    });
    req.pipe(up);
  });
  relay.on('error', (err) => {
    log.error('OpenShell demo gateway: model relay failed to listen', { port: cfg.relayPort, err: err.message });
    relay = null;
  });
  relay.listen(cfg.relayPort, '127.0.0.1', () => {
    log.info('OpenShell demo gateway: model relay listening', {
      address: `127.0.0.1:${cfg.relayPort}`,
      upstream: upstream.origin,
      credential: cred.kind,
    });
  });
}

registerGatewayProvider({
  kind: 'openshell-demo',
  agentSkills: [],
  sessions: {
    async ensure() {
      const cfg = demoGatewayConfig(process.env);
      startModelRelay(cfg);
      return {
        contribution: {
          env: demoContributionEnv(cfg),
          networkAccess: { endpoint: cfg.hostAlias, target: { kind: 'host' } },
        },
      };
    },
  },
  approvals: {
    subscribe(_decide, signal) {
      return new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    },
  },
});
EOF

grep -q "openshell-demo.js" src/gateway-providers/installed.ts || \
  printf '%s\n' 'import "./openshell-demo.js";' >> src/gateway-providers/installed.ts
ok "Demo harness written under demo/ and src/gateway-providers/openshell-demo*.ts"

# ---------------------------------------------------------------------------
log "6/9 — Point this install at the demo gateway + derived image"
node -e "
  const fs = require('fs');
  let env = fs.readFileSync('.env', 'utf8');
  const set = (k, v) => {
    const re = new RegExp('^' + k + '=.*\$', 'm');
    env = re.test(env) ? env.replace(re, k + '=' + v) : env + '\n' + k + '=' + v;
  };
  set('NANOCLAW_GATEWAY_PROVIDER', 'openshell-demo');
  set('NANOCLAW_OPENSHELL_POLICY_FILE', '$WORKDIR/demo/policy.json');
  set('CONTAINER_IMAGE', '$OPENSHELL_IMAGE');
  fs.writeFileSync('.env', env);
"
ok ".env updated: gateway=openshell-demo, policy file, container image=$OPENSHELL_IMAGE"

# Running each setup step individually (rather than the interactive wizard)
# skips the wizard's own completion hook, so NanoClaw's upgrade tripwire
# would otherwise refuse to boot a "never-upgraded-the-sanctioned-way"
# install. This is the documented, sanctioned way to clear it (see
# docs/upgrade-recovery.md): stamp the marker ourselves now that setup
# genuinely did complete.
pnpm exec tsx scripts/upgrade-state.ts set "" demo-script
ok "Upgrade marker stamped (setup completed via this script)"

# ---------------------------------------------------------------------------
log "7/9 — Start the mock CRM, the scripted model, and the NanoClaw host"
DEMO_CRM_API_PORT=$CRM_PORT DEMO_CRM_API_TOKEN=$CRM_TOKEN \
  nohup node demo/services/mock-crm.mjs > demo/logs/mock-crm.log 2>&1 &
DEMO_SCRIPTED_MODEL_PORT=$SCRIPTED_MODEL_PORT \
  nohup pnpm exec tsx demo/services/scripted-model.ts > demo/logs/scripted-model.log 2>&1 &
sleep 1

rm -f data/ncl.sock
export CONTAINER_IMAGE="$OPENSHELL_IMAGE"
export DEMO_MODEL_RELAY_PORT=$MODEL_RELAY_PORT
export DEMO_MODEL_UPSTREAM="http://127.0.0.1:${SCRIPTED_MODEL_PORT}"
export DEMO_CRM_API_PORT=$CRM_PORT
export DEMO_CRM_API_TOKEN=$CRM_TOKEN
nohup pnpm run dev > demo/logs/host.log 2>&1 &

log "Waiting for the NanoClaw host to come up..."
for i in $(seq 1 60); do
  [ -S data/ncl.sock ] && break
  sleep 1
  [ "$i" = 60 ] && die "host did not come up in 60s — see demo/logs/host.log"
done
ok "NanoClaw host is up (data/ncl.sock present)"

# ---------------------------------------------------------------------------
log "8/9 — Register alice and bob, same fake CRM token, different OpenShell policy"
pnpm exec tsx setup/index.ts --step register -- --channel cli --platform-id alice-local --name Alice --folder alice --assistant-name Alice
pnpm exec tsx setup/index.ts --step register -- --channel cli --platform-id bob-local   --name Bob   --folder bob   --assistant-name Bob
# register only creates DB rows; groups/<folder>/ itself is created lazily by
# initGroupFilesystem on first container spawn (container-runner.ts's
# buildMounts()). Create it ourselves so we can stage instructions.prepend.md
# now — that defensive call only mkdirs if the dir is absent and only (re)writes
# instructions.prepend.md when the caller passes opts.instructions, which the
# defensive path never does, so our file here is never clobbered.
mkdir -p groups/alice groups/bob
cp demo/agent-instructions.md groups/alice/instructions.prepend.md
cp demo/agent-instructions.md groups/bob/instructions.prepend.md
ok "alice and bob registered; both hold the same CRM_API_TOKEN, only alice's OpenShell policy allows reaching the CRM"

# ---------------------------------------------------------------------------
log "9/9 — Ask both the same question"
send() { # $1 = namespaced platform id, $2 = text
  # NB: "pnpm run ncl -- <args>" forwards a literal "--" into the script's own
  # argv on this pnpm version, which parseArgv() swallows as a spurious empty
  # flag — shifting every positional and leaving the dispatcher looking up
  # "send" alone ("no command \"send\""). Drop the "--".
  pnpm run ncl messaging-groups send --channel-type cli --platform-id "$1" --instance cli --text "$2"
}

echo
echo "--- alice -------------------------------------------------------------"
send "cli:alice-local" "Please fetch the CRM contacts."
sleep 3
tail -n 5 demo/logs/host.log | grep -i crm || true

echo
echo "--- bob ---------------------------------------------------------------"
send "cli:bob-local" "Please fetch the CRM contacts."
sleep 3
tail -n 5 demo/logs/host.log | grep -i crm || true

echo
log "CRM server's own audit log (ground truth — not the console's view)"
curl -s "http://127.0.0.1:${CRM_PORT}/__hits" | node -e "process.stdin.pipe(process.stdout)"; echo
echo "(expect exactly ONE 200 here — alice's. If bob also shows 200, STOP: policy isn't enforcing.)"

cat <<EOF

================================================================================
Demo running. Next, narrate the policy CLI live (see README-demo.md for the
talking points). Find a sandbox name with:
  docker ps --format '{{.Names}}' | grep ncl-

  pnpm run ncl openshell-policy view    --sandbox <name>
  pnpm run ncl openshell-policy list    --sandbox <name>
  pnpm run ncl openshell-policy approve --sandbox <name> --chunk-id <id>
  pnpm run ncl openshell-policy reject  --sandbox <name> --chunk-id <id> --reason "..."
  pnpm run ncl openshell-policy add-rule --sandbox <name> --add-endpoint <host:port> --binary <path> --dry-run

Tear down with: $0 "$WORKDIR" --teardown
================================================================================
EOF
