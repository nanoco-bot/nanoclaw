---
name: add-openshell
description: Install or refresh NanoClaw's OpenShell credential gateway, which keeps the agents' Claude credential in NVIDIA OpenShell. Use when setup enables OpenShell sandboxing, when an OpenShell-driver copy needs the gateway and agent guidance restored, or after selecting the openshell runtime driver by hand.
---

# Add OpenShell gateway

This gateway pairs with the in-tree `openshell` session driver (`src/drivers/openshell/`). The driver runs each session in an NVIDIA OpenShell sandbox and compiles its policy; OpenShell enforces egress and filesystem access. This gateway keeps the agents' Claude credential in OpenShell too, as an OpenShell provider the driver attaches to every sandbox, so no credential is stored by NanoClaw or enters a sandbox. Read `docs/gateway-seam.md` before changing the integration.

Enable the driver first. `pnpm exec tsx setup/index.ts --step openshell` installs OpenShell itself when it is missing (see below), writes `NANOCLAW_RUNTIME_DRIVER=openshell` and the policy settings to `.env`, and then applies this skill. Selecting this gateway on a Docker-driver copy is refused, because only the OpenShell driver attaches the credential.

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

Inside a sandbox, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` holds an `openshell:resolve:env:…` placeholder; OpenShell swaps in the real value on requests to `api.anthropic.com` from Claude Code, node or bun. Only the Claude agent provider is supported. Without the provider, sessions are refused and the chat is told why.

## Policy operations

OpenShell allow and deny decisions happen in OpenShell, not in NanoClaw approval cards. The operator reviews them on the host with `ncl openshell-policy-list`, `-view`, `-approve`, `-reject` and `-add-rule`. Live proposals cover network rules only. Filesystem and process policy is fixed when a sandbox starts.

## Per-group providers and network paths

`ncl openshell-provider attach --group <group> --openshell-provider <name> [--type <t> --credentials '{…}']` attaches an OpenShell gateway provider to an agent group. Every sandbox the group gets from then on is created with `--provider <name>`. The flag is `--openshell-provider` because `--provider` on `ncl groups config` is the AI model provider, a different thing. With `--type`, the provider is first created in the OpenShell gateway, and the credential values go only there; pass them with `--stdin-json`. NanoClaw's DB keeps the key names and a hash, never a value. `ncl openshell-network add --group <group> --name <rule> --host <host> --ports <p> --binary <path>` adds a raw network path for the group, independent of any provider. Both are stored in the central DB and read at every sandbox creation. A network path added or removed, or a provider attached or detached, this way is also applied live to every sandbox the group has running (`openshell policy update` for a path, `openshell sandbox provider attach|detach --wait` for a provider), and each sandbox is reported as applied or failed. A failed live apply never undoes the saved change. A live provider attach reaches the sandbox's credentials, policy and processes OpenShell starts afterwards, but not the agent's own running process, which keeps the environment it started with; add `--restart` (run from a host shell) to also restart the group's running containers so the agent uses the key at once. The setup UI's attach does this by default, asking the host over `data/ncl.sock`. OpenShell v0.1.2 ships no provider profiles in the gateway, so a type's profile has to exist first: create it in the setup UI (Providers → Service types), or import it with `openshell provider profile import -f <profile.yaml>`. Inside a sandbox the credential variable holds an `openshell:resolve:env:…` placeholder; OpenShell substitutes the real value on the way out. `ncl openshell-provider-profile` keeps install-wide form hints only; the setup UI no longer uses them.

## Setup UI

`scripts/ui/` is a small operator web page for this install. A status bar shows the OpenShell gateway, the relay's Claude credential (install-wide, replaceable from there) and the group's running sandboxes. Per agent group it attaches OpenShell providers, creates and deletes service types (OpenShell provider profiles, from a short form or pasted YAML), manages network access, lets the operator allow a blocked request for the running sandbox or always (saved as a group network path) or deny it, and shows the group's activity. It only runs existing commands: `scripts/auth.ts`, the `openshell` binary, and the `ncl openshell-policy`, `openshell-provider` and `openshell-network` resources. Install it as a service with `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable`, which prints the URL. It runs as a launchd agent on macOS and a systemd unit on Linux. The setup wizard starts it without asking at the end of every run where OpenShell sandboxing is enabled, and prints its URL. `NANOCLAW_SKIP=openshell-ui` leaves it out. The page has no login of its own. Expose it only through a password-gated reverse proxy and keep its port firewalled. See `scripts/ui/README.md`.

## Validate

```nc:run effect:build
pnpm run build
```

```nc:run effect:test
pnpm exec vitest run src/gateway-providers/openshell-core.test.ts src/gateway-providers/openshell.test.ts src/gateway-providers/gateway-provider-registry.test.ts src/drivers/openshell
```

The setup consumer writes `NANOCLAW_GATEWAY_PROVIDER=openshell` only after every step above succeeds.
