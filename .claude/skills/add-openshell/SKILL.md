---
name: add-openshell
description: Install or refresh NanoClaw's OpenShell credential gateway, which keeps the agents' Claude credential in NVIDIA OpenShell. Use when OpenShell sandboxing is enabled, when an OpenShell-driver copy needs the gateway and agent guidance restored, or after selecting the openshell runtime driver by hand.
---

# Add OpenShell gateway

This skill installs NanoClaw's `openshell` credential gateway. It pairs with the in-tree `openshell` session driver (`src/drivers/openshell/`), which runs each session in an NVIDIA OpenShell sandbox. OpenShell enforces the sandbox's egress and filesystem policy, and it holds the agents' Claude credential as an OpenShell provider that the driver attaches to every sandbox. So the gateway runs no proxy and stores no credential. It declares the model API as each session's destination, and it refuses sessions that can't work: on a runtime other than the OpenShell driver, or before the credential has been stored.

How it fits together, the security model, the policy file and every setting are described in [docs/openshell.md](../../../docs/openshell.md). Daily tasks, the gateway configuration, logs and troubleshooting are in [docs/openshell-operations.md](../../../docs/openshell-operations.md).

## Prerequisites

The copy must run the OpenShell session driver, and OpenShell must be installed with its gateway answering. One command does both:

```bash
pnpm exec tsx setup/index.ts --step openshell -- --enable
```

That command installs OpenShell at the release pinned in `versions.json` and checks its gateway. It then writes `NANOCLAW_RUNTIME_DRIVER=openshell` and the sandbox defaults to `.env`, builds the `:openshell` agent image, and applies this skill. If the OpenShell gateway refuses session bind mounts, the command stops and prints the `gateway.toml` lines to add (see [Gateway configuration](../../../docs/openshell-operations.md#gateway-configuration)).

## Check the configuration

The check confirms that this copy runs the `openshell` driver. It also warns when the `openshell` CLI can't be found; set `OPENSHELL_BIN` to its absolute path, because the background service has a fixed `PATH`.

```nc:run effect:check
pnpm exec tsx .claude/skills/add-openshell/scripts/setup.ts
```

## Install the provider payload

Copy the provider, its test and the agent guidance into their usual NanoClaw paths.

```nc:copy
payload/src/gateway-providers/openshell.ts -> src/gateway-providers/openshell.ts
payload/src/gateway-providers/openshell.test.ts -> src/gateway-providers/openshell.test.ts
payload/container/skills/openshell-gateway/SKILL.md -> container/skills/openshell-gateway/SKILL.md
payload/container/skills/openshell-gateway/instructions.md -> container/skills/openshell-gateway/instructions.md
```

## Register once

The provider file makes the only registration call.

```nc:append to:src/gateway-providers/installed.ts
import './openshell.js';
```

## Store the Claude credential

```bash
pnpm exec tsx setup/index.ts --step gateway-auth
```

This stores the credential in OpenShell as the provider `nanoclaw-<install slug>-claude`. You can sign in with a Claude subscription, paste an OAuth token, or paste an API key. With `NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN` or `NANOCLAW_ANTHROPIC_API_KEY` set in the environment, no prompt is shown. The value reaches `openshell` only through a child process's environment, and NanoClaw keeps no copy. Running the step again replaces the credential.

Only the Claude agent provider is supported.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/openshell.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/drivers/openshell .claude/skills/add-openshell/scripts
```

`NANOCLAW_GATEWAY_PROVIDER=openshell` is written only after every step above succeeds. Restart NanoClaw afterwards.

## Optional: the console

`/add-openshell-console` adds a local web page for per-group providers, network rules, blocked requests, service types and the Claude credential.

## Troubleshooting

- **Sessions are refused, naming a missing provider `nanoclaw-…-claude`.** Run the credential step above.
- **Selecting this gateway fails on a Docker-driver copy.** That is expected: only the OpenShell driver attaches the credential. Enable the driver first (see Prerequisites).
- **An agent stops answering after printing an environment variable.** A credential placeholder is now in its conversation, and OpenShell refuses those model requests. Send `/clear` in that chat.
- Everything else: [docs/openshell-operations.md#troubleshooting](../../../docs/openshell-operations.md#troubleshooting).
