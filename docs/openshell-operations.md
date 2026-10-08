# OpenShell operations

How to install, run and remove NanoClaw on OpenShell. For how the integration works and what it
protects against, read [openshell.md](openshell.md) first.

## Install

**New install.** Run `bash nanoclaw.sh` and answer yes to *"Enable OpenShell sandboxing?"*. For a
non-interactive install, pass `--openshell` or set `NANOCLAW_OPENSHELL=true`. Setup then does
the following:

1. Installs OpenShell with NVIDIA's installer, at the release pinned as `openshell` in
   `versions.json`. On Linux that is the Debian or RPM package, with the OpenShell gateway as a
   systemd user service. On Apple silicon it is the Homebrew formula and its `brew services`
   gateway. Set `OPENSHELL_VERSION` to install a different release. When an `openshell` is already
   on `PATH`, setup uses it. If it is older than the pin, setup stops and says how to remove it.
2. Checks the OpenShell gateway:
   - it must answer `openshell status`;
   - it must use the Docker compute driver;
   - its supervisor image must be in Docker (setup pulls it when missing);
   - it must accept a sandbox with a host bind mount (see
     [Gateway configuration](#gateway-configuration)).
3. Writes `NANOCLAW_RUNTIME_DRIVER=openshell`, `OPENSHELL_BIN` and the filesystem defaults to
   `.env`, and builds the `:openshell` agent image.
4. Applies `/add-openshell` (the credential gateway) and writes
   `NANOCLAW_GATEWAY_PROVIDER=openshell`.
5. Stores the Claude credential in OpenShell. You can sign in with your Claude subscription, paste
   an OAuth token, or paste an API key. To supply it without prompts, set
   `NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN` or `NANOCLAW_ANTHROPIC_API_KEY` in the environment.

**An existing install**, moving from Docker:

```bash
pnpm exec tsx setup/index.ts --step openshell -- --enable   # steps 1–4
pnpm exec tsx setup/index.ts --step gateway-auth            # step 5
```

Then restart NanoClaw. This replaces the install's current credential gateway (OneCLI, for
example), because one install runs one gateway. Existing agent groups keep their folders and
memory.

## Gateway configuration

NanoClaw mounts each session into its sandbox. An OpenShell gateway with default settings refuses
that, so the gateway config needs these lines:

```toml
[openshell.drivers.docker]
allow_driver_config = true
enable_bind_mounts = true

[openshell.drivers.docker.resource_admission]
enabled = false
```

| Platform | Which file | Restart |
|---|---|---|
| Linux | `~/.config/openshell/gateway.toml`. When no file exists there (and nothing redirects the config), setup creates it with exactly these settings. Setup never edits an existing file. If one exists, setup stops and prints the lines to add. | `systemctl --user restart openshell-gateway` |
| macOS | `~/.config/openshell/gateway.toml` if you have one. Otherwise the Homebrew service reads `$(brew --prefix)/var/openshell/gateway.toml`, so add the lines there. Creating a new `~/.config` file would replace the Homebrew config instead of extending it. Setup prints the lines and leaves the edit to you. | `brew services restart nvidia/openshell/openshell` |

A new file starts with `[openshell]` and `version = 2`. These settings weaken OpenShell's
isolation for every sandbox on that gateway. See [openshell.md](openshell.md#what-to-know-before-relying-on-it).

## Daily tasks

Each agent group's providers and network rules belong in the
[policy file](openshell.md#the-policy-file) (`data/openshell/policy.yaml`). The file applies to
every new sandbox. The `openshell` commands below also change sandboxes that are already
running. You can do all of this in [the console](#the-console) instead.

**Find a group's sandboxes.** Get the group id from `ncl groups list`, then run:

```bash
openshell sandbox list --selector nanoclaw-group=<group id>
```

**Give a group a key for a service.** If OpenShell doesn't yet have a service type for the
service, create one first. A service type sets the service's hosts, how the key is sent, and
which programs may connect. Use `openshell provider profile import -f <profile.yaml>`, or the
console's form.

```bash
KEY=… openshell provider create --name granola-jensen --type <service type> --credential KEY
# add granola-jensen to groups.<folder>.providers in the policy file, then for running sandboxes:
openshell sandbox provider attach <sandbox> granola-jensen --wait
ncl groups restart --id <group id>      # the agent's own process picks the key up on restart
```

`--credential KEY` reads the value from the `KEY` environment variable, so the key never appears
in the command line.

**Let a group reach a host without a key.** Add a rule under `groups.<folder>.egress` in the
policy file. For running sandboxes, also run:

```bash
openshell policy update <sandbox> --add-endpoint www.apple.com:443 --binary /usr/bin/curl --rule-name apple
openshell policy update <sandbox> --remove-rule apple      # to take it away again
```

**Replace the Claude credential.** Run `pnpm exec tsx setup/index.ts --step gateway-auth`.
Re-running it updates the provider in place, and running sandboxes pick up the new value.
Switching between a subscription token and an API key recreates the provider.

### Blocked requests

When an agent tries a host it isn't allowed to reach, OpenShell blocks the request and records
it. NanoClaw sends no approval card.

```bash
openshell rule get <sandbox> --status pending
openshell rule approve <sandbox> --chunk-id <id>
openshell rule reject <sandbox> --chunk-id <id> --reason "…"
```

An approval applies only to that sandbox and lasts until the sandbox is recreated. To keep it,
add the rule to the group in the policy file. The console's **Always allow** does both.

## The console

`/add-openshell-console` installs an optional local web page for everything above. It is not
installed by default.

```bash
pnpm exec tsx .claude/skills/add-openshell-console/scripts/service.ts --enable [--port 8790]
pnpm exec tsx .claude/skills/add-openshell-console/scripts/service.ts --disable
```

- It runs as a LaunchAgent on macOS or a systemd unit on Linux, named
  `openshell-setup-ui-<install slug>`. It logs to `logs/openshell-ui.log` and
  `logs/openshell-ui.error.log`.
- It **has no login**. It binds `127.0.0.1`. From another machine, use a tunnel:
  `ssh -L 8790:127.0.0.1:8790 <host>`, then open `http://127.0.0.1:8790/`.
- To serve it through a reverse proxy instead:
  1. Put a password on the proxy.
  2. Set `NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS=<proxy host name>` in `.env`, and
     `NANOCLAW_OPENSHELL_UI_HOST=0.0.0.0` if the proxy connects over the network.
  3. Re-run `--enable`.
  4. Firewall the port from everything except the proxy.

  The console refuses any other `Host`, and refuses state-changing requests from another origin.

Its tabs are described in the skill's
[README](../.claude/skills/add-openshell-console/scripts/README.md).

## Upgrades

- **NanoClaw.** Update as usual with `/update-nanoclaw`. `container/build.sh` re-derives the
  `:openshell` image after every build, so a rebuild covers both images. Setup's verify step
  re-checks the OpenShell gateway, the supervisor image and the Claude provider.
- **OpenShell.** The pin moves with NanoClaw releases. When it moves past your installed version,
  setup reports the older CLI. Upgrade it the way it was installed: `brew upgrade
  nvidia/openshell/openshell` on macOS, or the package manager on Linux. Then restart the OpenShell
  gateway. After an `image prune -a`, every sandbox create fails until the supervisor image is
  pulled again. The verify step reports it missing, and
  `pnpm exec tsx setup/index.ts --step openshell-install` pulls it.

## Logs

| What | Where |
|---|---|
| Sandbox create, stop and policy errors | `logs/nanoclaw.error.log`, then `logs/nanoclaw.log` |
| A sandbox's network decisions (allowed, denied, credential injection) | `openshell logs <sandbox>` |
| The OpenShell gateway | `journalctl --user -u openshell-gateway` (Linux), `$(brew --prefix)/var/log/openshell/` (macOS) |
| Setup | `logs/setup.log`, `logs/setup-steps/` |
| The console | `logs/openshell-ui.log`, `logs/openshell-ui.error.log` |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| The host log shows sessions refused with *"OpenShell has no provider 'nanoclaw-…-claude'"* | The Claude credential was never stored, or was deleted. Run `pnpm exec tsx setup/index.ts --step gateway-auth`. |
| An agent stops answering after it printed an environment variable | A credential placeholder is in its conversation history, and OpenShell refuses those requests (`body credential rewriting is disabled` in `openshell logs`). Send `/clear` in that chat. |
| Sandbox create fails with *"provider '…' not found"* | The policy file names a provider that OpenShell doesn't have. Create it, or remove it from the file. |
| Sandbox create fails on a bind mount or driver config | The gateway config is missing the [settings above](#gateway-configuration), or the gateway wasn't restarted after the edit. |
| Every sandbox create fails after a Docker cleanup | The supervisor image is gone. Run `pnpm exec tsx setup/index.ts --step openshell-install`. |
| The host refuses to start, or sandboxes fail, with *policy file … is not readable* or *OpenShell policy config: …* | The policy file has a syntax error, an unknown key or an invalid rule. The message names the field. The host reads the file at start, and the driver reads it again for every sandbox. |
| A host the agent needs is blocked | Check `openshell rule get <sandbox> --status pending`. Approve the request, or add a rule. Each rule also restricts which programs may connect, so check the `binaries` list. |
| A newly attached key isn't seen by the agent | A key attached to a running sandbox reaches only processes that start afterwards. Run `ncl groups restart --id <group id>`. |

## Removal

To move an install back to Docker:

1. Remove the console first, if you added it: `service.ts --disable`, then follow
   `/add-openshell-console`'s `REMOVE.md`.
2. Run `pnpm exec tsx setup/index.ts --step openshell -- --disable`. This removes
   `NANOCLAW_RUNTIME_DRIVER` and the `openshell` gateway selection. The other `OPENSHELL_*`
   settings stay, in case you re-enable later.
3. Remove the credential gateway (`/add-openshell`'s `REMOVE.md`), then install another gateway:
   `pnpm exec tsx setup/index.ts --step gateway`.
4. In OpenShell:
   - delete this install's sandboxes: `openshell sandbox list`, then the ones labelled with its
     `nanoclaw-install` slug;
   - delete its Claude provider: `openshell provider delete nanoclaw-<slug>-claude`;
   - delete the `nanoclaw-claude-*` profiles if no other install uses them.
5. Restart NanoClaw.

OpenShell itself stays installed. To remove it, use NVIDIA's instructions for how it was installed
(the Linux package and the `openshell-gateway` user service, or `brew uninstall` plus `brew
services stop`).
