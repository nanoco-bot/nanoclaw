---
name: add-openshell
description: Install or refresh NVIDIA OpenShell as NanoClaw's gateway provider. Use when setup enables OpenShell sandboxing, when an OpenShell-driver copy needs its model relay, approval stub, and agent guidance restored, or after selecting the openshell runtime driver by hand.
---

# Add OpenShell gateway

This gateway pairs with the in-tree `openshell` session driver (`src/drivers/openshell/`). The driver runs each session in an NVIDIA OpenShell sandbox and compiles its policy; OpenShell enforces egress and filesystem access. This gateway adds the one thing the sandbox still needs: a model relay on the host that injects the Anthropic credential, so no credential enters a sandbox. Read `docs/gateway-seam.md` before changing the integration.

Enable the driver first. `pnpm exec tsx setup/index.ts --step openshell` installs OpenShell itself when it is missing (see below), writes `NANOCLAW_RUNTIME_DRIVER=openshell` and the policy settings to `.env`, and then applies this skill. Selecting this gateway on a Docker-driver copy is refused, because agents there cannot reach the relay.

## OpenShell itself

Two different things are called a gateway here. OpenShell's gateway is its control plane, the `openshell-gateway` service on `127.0.0.1:17670` that creates and polices sandboxes. This skill is NanoClaw's `openshell` gateway, the model relay. Setup installs the first with NVIDIA's installer and applies the second through the gateway step, so neither is installed twice.

`setup/install-openshell.sh` runs NVIDIA's installer at the release pinned as `openshell` in the root `versions.json`, the release the driver is verified against. Set `OPENSHELL_VERSION` to install another release. On Linux it installs the Debian or RPM package and starts the gateway as a systemd user service. On an Apple silicon Mac it installs the Homebrew formula and its `brew services` gateway. Intel Macs are not supported, because NVIDIA publishes no Intel build, and setup stops there with that reason. When `openshell` is already on `PATH`, the script changes nothing. The setup wizard runs it as the `openshell-install` step after the container step, because OpenShell's gateway needs Docker.

After installing, `setup --step openshell-install` checks three things. The gateway must answer `openshell status`. Its supervisor image, `ghcr.io/nvidia/openshell/supervisor:<gateway version>`, must be in Docker, and the step pulls it when it is missing. The gateway must also accept a sandbox with a host bind mount. The verify step checks the gateway and the supervisor image again on every run. The gateway resolves that image only when it starts, so after an `image prune -a` every sandbox create fails until `docker pull` restores it. If your gateway config overrides `supervisor_image`, set `OPENSHELL_SUPERVISOR_IMAGE` in `.env` to the same reference.

NanoClaw mounts each session into its sandbox. A gateway with default settings refuses that, and setup stops with these lines to add to `~/.config/openshell/gateway.toml`. A new file starts with `[openshell]` and `version = 2`. Restart the gateway afterwards with `systemctl --user restart openshell-gateway` on Linux or `brew services restart nvidia/openshell/openshell` on macOS. OpenShell documents host bind mounts as an operator override that weakens its isolation, and its resource admission refuses raw bind mounts, so setup leaves this choice to the operator.

```toml
[openshell.drivers.docker]
allow_driver_config = true
enable_bind_mounts = true

[openshell.drivers.docker.resource_admission]
enabled = false
```

## Check the configuration

Before anything is copied, the check confirms this copy runs the `openshell` driver, that the relay port is set and matches the sandbox egress allow-list, and that no other process holds it. It warns when the `openshell` CLI cannot be found. Run `pnpm exec tsx setup/index.ts --step openshell-install` to install it, or point `OPENSHELL_BIN` at the absolute path of your own install, because the background service has a fixed `PATH`.

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

The relay reads `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` from the NanoClaw service environment. The sign-in step (`scripts/auth.ts`) writes it where the service reads its environment. On Linux that is this install's systemd drop-in, `<unit>.service.d/credential.conf`, with mode `0600`. On macOS it is the `EnvironmentVariables` of the NanoClaw LaunchAgent plist (owner-only), so the setup wizard installs the service before the sign-in on macOS. It is never written to `.env`. Agents receive only `ANTHROPIC_AUTH_TOKEN=gateway-managed`. Only the Claude provider is supported, on Linux with systemd or on macOS. Without a credential, sessions are refused and the chat is told why.

## Policy operations

OpenShell allow and deny decisions happen in OpenShell, not in NanoClaw approval cards. The operator reviews them on the host with `ncl openshell-policy-list`, `-view`, `-approve`, `-reject` and `-add-rule`. Live proposals cover network rules only. Filesystem and process policy is fixed when a sandbox starts.

## Setup UI

`scripts/ui/` is a small operator web page for this install. It sets or replaces the relay's Claude credential, creates OpenShell providers, reviews and approves egress-rule proposals, and keeps a history of those decisions. It only runs the existing commands: `scripts/auth.ts`, the `openshell` binary, and the `ncl openshell-policy` resource. Install it as a service with `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable`, which prints the URL. It runs as a launchd agent on macOS and a systemd unit on Linux. The setup wizard starts it without asking at the end of every run where OpenShell sandboxing is enabled, and prints its URL. `NANOCLAW_SKIP=openshell-ui` leaves it out. The page has no login of its own. Expose it only through a password-gated reverse proxy and keep its port firewalled. See `scripts/ui/README.md`.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/openshell-core.test.ts src/gateway-providers/openshell.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/drivers/openshell
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=openshell` only after every step above succeeds.
