---
name: add-openshell
description: Install or refresh NVIDIA OpenShell as NanoClaw's gateway provider. Use when setup enables OpenShell sandboxing, when an OpenShell-driver copy needs its model relay, approval stub, and agent guidance restored, or after selecting the openshell runtime driver by hand.
---

# Add OpenShell gateway

This gateway pairs with the in-tree `openshell` session driver (`src/drivers/openshell/`). The driver runs each session in an NVIDIA OpenShell sandbox and compiles its policy; OpenShell enforces egress and filesystem access. This gateway adds the one thing the sandbox still needs: a model relay on the host that injects the Anthropic credential, so no credential enters a sandbox. Read `docs/gateway-seam.md` before changing the integration.

Enable the driver first. `pnpm exec tsx setup/index.ts --step openshell` asks for the OpenShell CLI path, writes `NANOCLAW_RUNTIME_DRIVER=openshell` and the policy settings to `.env`, and then applies this skill. Selecting this gateway on a Docker-driver copy is refused, because agents there cannot reach the relay.

## Check the configuration

Before anything is copied, the check confirms this copy runs the `openshell` driver, that the relay port is set and matches the sandbox egress allow-list, and that no other process holds it. It warns when the `openshell` CLI cannot be found; install it from https://github.com/NVIDIA/OpenShell and point `OPENSHELL_BIN` at its absolute path, because the background service has a fixed `PATH`.

```nc:run effect:check
pnpm exec tsx .claude/skills/add-openshell/scripts/setup.ts
```

## Install the provider payload

Copy the provider, its tests, and the agent guidance into their normal NanoClaw paths.

```nc:copy
payload/src/gateway-providers/openshell.ts -> src/gateway-providers/openshell.ts
payload/src/gateway-providers/openshell-core.ts -> src/gateway-providers/openshell-core.ts
payload/src/gateway-providers/openshell.test.ts -> src/gateway-providers/openshell.test.ts
payload/src/gateway-providers/openshell-core.test.ts -> src/gateway-providers/openshell-core.test.ts
payload/container/skills/openshell-gateway/SKILL.md -> container/skills/openshell-gateway/SKILL.md
payload/container/skills/openshell-gateway/instructions.md -> container/skills/openshell-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call.

```nc:append to:src/gateway-providers/installed.ts
import './openshell.js';
```

## Model credentials

The relay listens on `127.0.0.1` at this install's own port, `NANOCLAW_OPENSHELL_MODEL_RELAY_PORT`. Setup picks a free port per install and writes the same value to `NANOCLAW_OPENSHELL_GATEWAY_PORTS`, the sandbox egress allow-list. Sandboxes reach the relay as `host.openshell.internal`. If the relay cannot bind its port, the gateway reports itself unavailable and NanoClaw admits no sessions, so a sandbox is never pointed at a port another copy holds.

The relay reads `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from the NanoClaw service environment. The sign-in step (`scripts/auth.ts`) writes it to this install's systemd drop-in, `<unit>.service.d/credential.conf`, with mode `0600`. It is never written to `.env`. Agents receive only `ANTHROPIC_AUTH_TOKEN=gateway-managed`. Only the Claude provider is supported, on Linux with systemd. Without a credential, sessions are refused and the chat is told why.

## Policy operations

OpenShell allow and deny decisions happen in OpenShell, not in NanoClaw approval cards. The operator reviews them on the host with `ncl openshell-policy-list`, `-view`, `-approve`, `-reject` and `-add-rule`. Live proposals cover network rules only. Filesystem and process policy is fixed when a sandbox starts.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/openshell-core.test.ts src/gateway-providers/openshell.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/drivers/openshell
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=openshell` only after every step above succeeds.
