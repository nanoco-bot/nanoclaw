# OpenShell sandboxing

NanoClaw can run each agent session in an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell)
sandbox instead of a plain Docker container. OpenShell then enforces what the agent can reach on
the network and on disk, and holds the agent's credentials so that no real key enters the sandbox.

This page covers how the integration works, what it protects and what it doesn't, the policy
file, and the settings. To install it, change it day to day, or troubleshoot it, see
[openshell-operations.md](openshell-operations.md).

## Terms

Several things here have similar names.

| Term | What it is |
|---|---|
| **OpenShell gateway** | OpenShell's control plane: the `openshell-gateway` service (default `127.0.0.1:17670`) that creates sandboxes and enforces their policy. It is NVIDIA's code, installed by setup. |
| **Session driver** | NanoClaw's `openshell` runtime driver, `src/drivers/openshell/`. It turns a session into an OpenShell sandbox through the `openshell` CLI. It is in-tree, and `NANOCLAW_RUNTIME_DRIVER=openshell` selects it. |
| **Credential gateway** | NanoClaw's `openshell` gateway provider, installed by the `/add-openshell` skill (see [gateway-seam.md](gateway-seam.md)). It runs no proxy. It only refuses sessions that can't work. |
| **OpenShell provider** | A credential that OpenShell holds, such as the Claude credential or a Granola key. When one is attached, the sandbox sees a placeholder in place of the key, and OpenShell swaps in the real value on the way out. |
| **Service type** | An OpenShell *provider profile*: which hosts a provider's key may reach, how it is sent, and which programs may send it. |
| **Policy file** | `data/openshell/policy.yaml`: the operator's per-agent-group providers and network rules. |
| **Console** | An optional local web page for the above, installed by `/add-openshell-console`. |

## How it fits together

```
 NanoClaw host (Node)                                   OpenShell gateway (127.0.0.1:17670)
 ├─ router / container-runner                               │  holds providers (credentials)
 ├─ session driver: src/drivers/openshell ── openshell CLI ─┤  compiles + enforces policy
 │    reads data/openshell/policy.yaml per sandbox          │
 └─ credential gateway: openshell (ensure only)             ▼
                                                     Docker: one sandbox per session
                                                     ├─ agent image :openshell
                                                     ├─ session mounts (bind)
                                                     ├─ Landlock filesystem policy
                                                     └─ egress: default deny + allowed rules,
                                                        placeholders swapped for real keys at L7
```

**One sandbox per session.** When a session wakes, the driver's `prepare()` validates the spec,
reads the policy file and compiles two things that must agree: the sandbox's filesystem and
network policy, and the Docker bind-mount list. `start()` runs `openshell sandbox create` with:

- `--from <agent image>:openshell`;
- `--policy <compiled yaml>`;
- `--driver-config-json <binds>`;
- a `--provider` for the install's Claude provider and each of the group's providers;
- labels.

OpenShell has no create-without-start, so nothing is allocated before `start()`.

**Names and labels.** Sandbox names are `ncl-<15 hex>`, a hash of the install, group and session,
because OpenShell names are limited to 19 bytes. Ownership comes from the labels: every sandbox
carries `nanoclaw-install`, `nanoclaw-group` (the agent group id), `nanoclaw-session`,
`nanoclaw-role` and `nanoclaw-group-folder`. To find a group's sandboxes, run
`openshell sandbox list --selector nanoclaw-group=<group id>`.

**Lifecycle.** The OpenShell CLI has no watch command, so the driver polls the sandbox list
(every 2 s by default, set by `NANOCLAW_OPENSHELL_POLL_MS`) to see sandboxes end. Stopping a
session deletes its sandbox. Adoption after a host restart, residue cleanup and lost-create races
are handled on labels, as in the Docker driver.

**The `:openshell` image.** OpenShell refuses a bind mount over the image's `WORKDIR`. The stock
agent image's `WORKDIR` is under `/workspace`, which is where the session is mounted. So setup
derives a `:openshell` image with `WORKDIR /sandbox`, and `container/build.sh` re-derives it after
every build. The driver maps `<base>:latest` to `<base>:openshell` and uses any other tag as
given.

**The Claude credential.** Setup stores the Claude credential in OpenShell as the provider
`nanoclaw-<install slug>-claude`. It uses one of two profiles that NanoClaw imports:
`nanoclaw-claude-oauth` (a subscription token, sent as `Authorization: Bearer`) or
`nanoclaw-claude-api-key` (sent as `x-api-key`).

- The value reaches `openshell` only through a child process's environment, never through argv.
- NanoClaw keeps no copy.
- Inside the sandbox, `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` holds a placeholder.
  OpenShell replaces it on requests to `api.anthropic.com:443`, and only for Claude Code, `node`
  and `bun`.
- The credential gateway refuses a session when this provider is missing, and the error names
  the sign-in step that fixes it.

## Security model

### What OpenShell enforces

| Area | How |
|---|---|
| **Network** | Default deny. A sandbox can reach only three kinds of destination: the model API, through the Claude provider's rule; each attached provider's hosts, through that provider's rules; and the group's network rules from the policy file. Each rule names a host, ports and the programs allowed to connect. Everything else is blocked and recorded for review (see [Blocked requests](openshell-operations.md#blocked-requests)). |
| **Credentials** | Providers. The sandbox only ever sees placeholders. A real key is inserted only on requests to its provider's hosts, and only from that provider's allowed programs. |
| **Filesystem** | Landlock, from the compiled policy. Read-only access covers the base system paths (`NANOCLAW_OPENSHELL_BASE_RO`) and the read-only session mounts. Read-write access covers `NANOCLAW_OPENSHELL_BASE_RW` and the read-write mounts. Everything else is denied, including the parts of a bind mount the policy doesn't grant. |
| **Process** | The session's `runAs` user and group. Root is refused. |

### What NanoClaw checks before creating a sandbox

These checks run in the driver, on the host, for every sandbox:

- Mount classes and paths are validated as on Docker (`validateSpec`). In addition, the driver
  refuses:
  - a mount source with a symlink anywhere in its path;
  - a group-state or allowlisted-extra mount that targets the image's system tree (`/usr`,
    `/etc` and the like);
  - any mount path containing control or format characters.
- The Docker bind list and the Landlock policy are compiled from the same rule. Any mismatch in
  access between them is refused rather than realized.
- The policy file is parsed strictly. An unknown key, a wrong type or an invalid rule fails the
  sandbox loudly instead of being ignored, because the file grants network access.

### What to know before relying on it

- **The OpenShell gateway must allow host bind mounts.** NanoClaw mounts each session into its
  sandbox, which requires `enable_bind_mounts` and `allow_driver_config` and turning off
  `resource_admission` in `gateway.toml` (see [operations](openshell-operations.md#gateway-configuration)).
  OpenShell describes bind mounts as an operator override that weakens its isolation. These are
  gateway-wide settings, so they apply to every sandbox on that gateway.
- **The mount checks are not repeated by anything else.** With `resource_admission` off, nothing
  outside the NanoClaw process re-checks the mounts, which is why the driver reports
  `admissionEnforced: false`.
- **Landlock is `best_effort` by default.** On a kernel that can't enforce Landlock, OpenShell
  runs the sandbox without filesystem rules and logs it. Set
  `NANOCLAW_OPENSHELL_LANDLOCK=hard_requirement` to fail the sandbox instead.
- **Sandboxes are containers, not VMs.** The integration targets OpenShell's Docker compute
  driver.
- **The console has no login.** It can replace the Claude credential, attach keys and allow
  network access. It listens on `127.0.0.1` and answers only to local or explicitly allowed host
  names. See [the console](openshell-operations.md#the-console).

## The policy file

The policy file is `NANOCLAW_OPENSHELL_POLICY_FILE`, or `data/openshell/policy.yaml` when that
variable is not set. It is YAML or JSON. Groups are keyed by the agent group's **folder**, which
is the stable name, not the generated id.

```yaml
default:                            # applies to every group
  providers: [shared-search]
groups:
  dm-with-asaf:
    providers: [granola-jensen]     # OpenShell providers (create them with `openshell provider create`)
    egress:                         # hosts reachable without a provider
      - name: apple
        host: www.apple.com
        ports: [443]
        binaries: [/usr/bin/curl]
```

| Key | Meaning |
|---|---|
| `providers` | OpenShell provider names to attach. When a name OpenShell doesn't know is listed, sandbox creation fails with a message that names it. |
| `egress` | Network rules. Each rule has a `name` matching `[A-Za-z0-9][A-Za-z0-9_-]*` (up to 63 characters; `_provider_*` is reserved by OpenShell), a `host`, `ports` and `binaries`. Binaries are absolute paths, or globs, where `*` matches one path component and `**` any number. An empty `binaries` list is refused, because it would allow nothing. |
| `baseReadOnly`, `baseReadWrite` | Replace the base filesystem grants (normally set with the `.env` keys below). |
| `landlockCompatibility` | `best_effort` or `hard_requirement`. |
| `includeWorkdir` | `filesystem_policy.include_workdir`, true by default. |
| `gatewayEgress` | Leave this unset. It emits an extra rule for the credential gateway's endpoint, and OpenShell refuses a plain rule for an endpoint a provider already covers. |

**Precedence.** A group's settings are merged over `default`, field by field. `providers` and
`egress` **add up** instead: a group gets the default's entries plus its own. The `.env` settings
override the file's `default` for the fields they cover.

**When changes apply.** The driver reads the file again for every new sandbox. An edit therefore
reaches each group's next sandbox without a restart, but it doesn't change a sandbox that is
already running. To change a running sandbox as well, use the `openshell` CLI or the console (see
[operations](openshell-operations.md#daily-tasks)).

## Settings

These keys live in `.env`. Setup writes the first four. The rest are optional.

| Key | Default | Meaning |
|---|---|---|
| `NANOCLAW_RUNTIME_DRIVER` | `docker` | `openshell` selects the session driver. |
| `NANOCLAW_GATEWAY_PROVIDER` | — | `openshell` selects the credential gateway. Setup writes it only after `/add-openshell` applies. |
| `OPENSHELL_BIN` | `openshell` | Path to the CLI. Setup stores an absolute path, because the background service has a fixed `PATH`. |
| `NANOCLAW_OPENSHELL_BASE_RO` | `/usr,/bin,/lib,/lib64,/etc` | Read-only base paths. Setup writes `/usr,/bin,/lib,/lib64,/etc,/app,/pnpm,/opt`, which the shipped agent image needs. |
| `NANOCLAW_OPENSHELL_BASE_RW` | none | Read-write base paths. Setup writes `/tmp,/home/node`. |
| `NANOCLAW_OPENSHELL_LANDLOCK` | OpenShell's `best_effort` | `hard_requirement` fails a sandbox on a kernel that can't enforce Landlock. |
| `NANOCLAW_OPENSHELL_POLICY_FILE` | `data/openshell/policy.yaml` | The policy file. |
| `NANOCLAW_OPENSHELL_POLL_MS` | `2000` | How often the driver lists sandboxes (at least 250). |
| `OPENSHELL_GATEWAY`, `OPENSHELL_GATEWAY_ENDPOINT` | the CLI's default | Point the CLI at a different OpenShell gateway. |
| `OPENSHELL_SUPERVISOR_IMAGE` | the gateway's version | Set it when your `gateway.toml` overrides `supervisor_image`, so setup checks the image you actually use. |
| `NANOCLAW_OPENSHELL_UI_PORT`, `_UI_HOST`, `_UI_ALLOWED_HOSTS` | `8790`, `127.0.0.1`, none | The console's port, address and extra allowed host names. |

## Limitations

- **Claude only.** OpenShell can hold only the Claude agent provider's credential. Other agent
  providers, such as OpenCode, aren't supported on this gateway.
- **Platforms.** Linux (amd64 or arm64, Debian or RPM based) and Apple silicon Macs. NVIDIA
  publishes no Intel Mac build. Docker is still required, because the OpenShell gateway runs
  sandboxes in it.
- **Pinned release.** NanoClaw is verified against the OpenShell release pinned in `versions.json`
  (currently v0.1.2). Setup stops on an older `openshell` and warns on a newer one.
- **Per-group state lives in NanoClaw's file.** OpenShell has no notion of agent groups, and its
  sandbox templates can't carry providers or policy in v0.1.2. That is why the policy file exists.
- **A key attached to a running sandbox doesn't reach the running agent.** It reaches processes
  that start afterwards. The agent picks it up when its sandbox restarts.
- **A printed placeholder blocks the conversation.** OpenShell refuses to forward a model request
  whose body contains a credential placeholder (`403 … body credential rewriting is disabled`).
  If an agent prints a credential variable, the placeholder enters its conversation history and
  every later request fails. `/clear` starts a new conversation. The agent guidance tells agents
  never to print these variables.
- **Blocked requests are approved in OpenShell, not in chat.** NanoClaw's approval cards aren't
  used. An approval lasts until the sandbox is recreated. To keep it, add the rule to the group
  in the policy file.
- **Not realized:** per-sandbox `pidsLimit` (OpenShell has only a gateway-wide limit) and
  `shmSizeMb`. Filesystem and process policy are fixed when a sandbox starts.
