---
name: add-openshell
description: Install or refresh NanoClaw's OpenShell credential gateway, which keeps the agents' Claude credential in NVIDIA OpenShell. Use when setup enables OpenShell sandboxing, when an OpenShell-driver copy needs the gateway and agent guidance restored, or after selecting the openshell runtime driver by hand.
---

# Add OpenShell gateway

This gateway pairs with the in-tree `openshell` session driver (`src/drivers/openshell/`). The driver runs each session in an NVIDIA OpenShell sandbox and compiles its policy; OpenShell enforces egress and filesystem access. This gateway keeps the agents' Claude credential in OpenShell too, as an OpenShell provider the driver attaches to every sandbox, so no credential is stored by NanoClaw or enters a sandbox. Read `docs/gateway-seam.md` before changing the integration.

Enable the driver first. `pnpm exec tsx setup/index.ts --step openshell` installs OpenShell itself when it is missing (see below), writes `NANOCLAW_RUNTIME_DRIVER=openshell` and the policy settings to `.env`, and then applies this skill. Selecting this gateway on a Docker-driver copy is refused, because only the OpenShell driver attaches the credential.

## OpenShell itself

Two different things are called a gateway here. OpenShell's gateway is its control plane, the `openshell-gateway` service on `127.0.0.1:17670` that creates and polices sandboxes. This skill is NanoClaw's `openshell` gateway, the model relay. Setup installs the first with NVIDIA's installer and applies the second through the gateway step, so neither is installed twice.

`setup/openshell/install.sh` runs NVIDIA's installer at the release pinned as `openshell` in the root `versions.json`, the release the driver is verified against. Set `OPENSHELL_VERSION` to install another release. On Linux it installs the Debian or RPM package and starts the gateway as a systemd user service. On an Apple silicon Mac it installs the Homebrew formula and its `brew services` gateway. Intel Macs are not supported, because NVIDIA publishes no Intel build, and setup stops there with that reason. When `openshell` is already on `PATH`, the script changes nothing. The setup wizard runs it as the `openshell-install` step after the container step, because OpenShell's gateway needs Docker.

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

Before anything is copied, the check confirms this copy runs the `openshell` driver. It warns when the `openshell` CLI cannot be found. Run `pnpm exec tsx setup/index.ts --step openshell-install` to install it, or point `OPENSHELL_BIN` at the absolute path of your own install, because the background service has a fixed `PATH`.

```nc:run effect:check
pnpm exec tsx .claude/skills/add-openshell/scripts/setup.ts
```

## Install the provider payload

Copy the provider, its tests, and the agent guidance into their normal NanoClaw paths.

```nc:copy
payload/src/gateway-providers/openshell.ts -> src/gateway-providers/openshell.ts
payload/src/gateway-providers/openshell.test.ts -> src/gateway-providers/openshell.test.ts
payload/container/skills/openshell-gateway/SKILL.md -> container/skills/openshell-gateway/SKILL.md
payload/container/skills/openshell-gateway/instructions.md -> container/skills/openshell-gateway/instructions.md
```

## Register once

The provider file makes the only product registration call.

```nc:append to:src/gateway-providers/installed.ts
import './openshell.js';
```

## Model credentials

The sign-in step (`scripts/auth.ts`) stores the Claude credential in OpenShell as the provider `nanoclaw-<install slug>-claude`, using one of two provider profiles NanoClaw imports for it: `nanoclaw-claude-oauth` (a Claude subscription token, sent as `Authorization: Bearer`) or `nanoclaw-claude-api-key` (sent as `x-api-key`). The value reaches `openshell` only through the child process environment. NanoClaw keeps no copy. Re-running the step with a new credential updates the provider in place, and running sandboxes pick it up.

Inside a sandbox, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` holds an `openshell:resolve:env:…` placeholder; OpenShell swaps in the real value on requests to `api.anthropic.com` from Claude Code, node or bun. Only the Claude agent provider is supported. Without the provider, sessions are refused and the host log says why.

OpenShell refuses to forward a model request whose body contains a placeholder (`403 … body credential rewriting is disabled`), so an agent that prints a credential variable cannot reach the model again in that conversation; `/clear` starts a fresh one. The agent guidance tells agents never to print credential variables.

## Per-group providers and network rules

Each agent group's OpenShell providers and network rules live in the OpenShell policy file: `NANOCLAW_OPENSHELL_POLICY_FILE`, or `data/openshell/policy.yaml` when that is not set. YAML or JSON, keyed by the group's folder:

```yaml
default:
  providers: [shared-search]        # attached to every group's sandboxes
groups:
  dm-with-asaf:
    providers: [granola-jensen]     # OpenShell providers (create them with `openshell provider create`)
    egress:                         # hosts reachable without a provider
      - { name: apple, host: www.apple.com, ports: [443], binaries: [/usr/bin/curl] }
```

`providers` and `egress` add up: the defaults, then the group's own. The driver reads the file for every new sandbox, so an edit reaches the group's next sandbox without a restart. A provider the file names but OpenShell does not have fails sandbox creation with a message naming it.

To change a running sandbox as well, use the `openshell` CLI. Every sandbox carries its agent group's id as a label, so `openshell sandbox list --selector nanoclaw-group=<group id>` finds them; then `openshell policy update <sandbox> --add-endpoint host:port --binary <path> --rule-name <name>` (or `--remove-rule <name>`) changes its network rules, and `openshell sandbox provider attach|detach <sandbox> <provider> --wait` its providers. A provider attached to a running sandbox reaches the processes OpenShell starts afterwards, not the agent's own running process; the agent picks the key up once its sandbox restarts (`ncl groups restart --id <group id>`).

## Blocked requests

OpenShell allows and denies network requests itself, not through NanoClaw's approval cards. When an agent tries a host it may not reach, OpenShell records the request: `openshell rule get <sandbox> --status pending` lists them, `openshell rule approve <sandbox> --chunk-id <id>` allows one for that sandbox, and `openshell rule reject <sandbox> --chunk-id <id> --reason …` denies it. An approval lasts until the sandbox is recreated; to keep it, add the rule to the group in the policy file. Proposals cover network rules only. Filesystem and process policy is fixed when a sandbox starts.

## Web console

`/add-openshell-console` adds an optional local web page for everything above: per-group providers and network rules, blocked requests, service types and the Claude credential.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/openshell-core.test.ts src/gateway-providers/openshell.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/drivers/openshell
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=openshell` only after every step above succeeds.
