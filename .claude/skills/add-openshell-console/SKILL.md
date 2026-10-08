---
name: add-openshell-console
description: Add a local web console for an OpenShell-sandboxed NanoClaw install — per agent group, attach OpenShell providers, manage network rules, allow or deny blocked requests, create service types, and replace the Claude credential. Use when the operator wants a UI for OpenShell instead of the openshell CLI and the policy file.
---

# Add the OpenShell console

A small web page for an install that runs its agents in NVIDIA OpenShell sandboxes (`NANOCLAW_RUNTIME_DRIVER=openshell`, set up by `/add-openshell`). It edits the OpenShell policy file and runs the `openshell` CLI; it holds no state of its own beyond an activity log. What each tab does is in `scripts/README.md`; the policy file and the `openshell` commands it stands in for are in [docs/openshell-operations.md](../../../docs/openshell-operations.md#daily-tasks).

It has **no login of its own**. It binds `127.0.0.1` by default and answers only to local host names, so it is reached over an SSH tunnel: `ssh -L 8790:127.0.0.1:8790 <host>`, then `http://127.0.0.1:8790/`.

## Requirements

The install must run the OpenShell driver and the `openshell` credential gateway. Check `.env`:

```bash
grep -E '^(NANOCLAW_RUNTIME_DRIVER|NANOCLAW_GATEWAY_PROVIDER)=' .env
```

Both must be `openshell`. If not, run `/add-openshell` first.

## Install the service

```bash
pnpm exec tsx .claude/skills/add-openshell-console/scripts/service.ts --enable
```

It installs the console as a background service — a LaunchAgent on macOS, a systemd unit on Linux (`openshell-setup-ui-<install slug>`) — starts it, waits until it listens, and prints its URL. `--port <n>` picks the port (default 8790, the next free one if taken); the choice is saved as `NANOCLAW_OPENSHELL_UI_PORT` in `.env`. Linux without systemd is refused.

Re-running it is safe: it rewrites the service definition and restarts it.

## Behind a proxy instead of a tunnel

To reach it through a reverse proxy, the proxy must require a password, and the console must be told the proxy's host name, or it refuses the requests:

```bash
# in .env
NANOCLAW_OPENSHELL_UI_HOST=0.0.0.0          # only if the proxy connects over the network
NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS=console.example.com
```

Then re-run the install command. Keep the port firewalled from everything but the proxy.

## Validate

```bash
pnpm exec vitest run .claude/skills/add-openshell-console/scripts
```

## Troubleshooting

- **The page does not load.** Check the service: `systemctl --user status openshell-setup-ui-<slug>` (Linux) or `launchctl list | grep openshell-setup-ui` (macOS), and `logs/openshell-ui.error.log`.
- **"host … is not allowed".** The browser used a host name other than `127.0.0.1` / `localhost`; add it to `NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS` and re-run the install command.
- **The gateway pill is red.** OpenShell's gateway is down: `openshell status`.
