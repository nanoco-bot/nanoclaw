# OpenShell standard-install demo

What this proves: on `nanoco-bot/nanoclaw` branch `bob/openshell-standard-install` (PR #1,
draft, not merged), OpenShell is wired in as a first-class, standard-install sandbox driver —
not a bolt-on. `clean-install-demo.sh` starts from nothing but a git clone and non-interactively
drives the same setup steps a human sees in the interactive wizard, ending with two live agents
(alice, bob) whose OpenShell egress policy — not which credentials they hold — decides whether
a tool call reaches a third-party API.

## What's real vs. what's demo scaffolding

- **Real, shipped PR code:** the OpenShell driver, the `openshell` setup step (`setup --step
  openshell`), the `openshell` gateway provider, and the `ncl openshell-policy` CLI. Nothing
  about those is faked for this demo.
- **Demo-only scaffolding, written fresh by the script into the clone, NOT part of the PR:**
  everything under `demo/` (mock CRM, scripted "model", agent instructions, policy fixture) plus
  `src/gateway-providers/openshell-demo*.ts`. This box (bob-lab) has no Anthropic credential, so
  the script swaps in a scripted decision table instead of a real model call. Point the same
  script at a box with `ANTHROPIC_API_KEY` set and pass `--real-model` (see below) and the real
  `openshell` gateway carries the identical scene with actual Claude Code reasoning — nothing
  else changes.

## Prerequisites

- Docker (no sudo), Node ≥22, pnpm (corepack will activate the repo's pinned version
  automatically).
- An OpenShell gateway configured for NanoClaw's bind mounts (see "OpenShell itself" in
  `.claude/skills/add-openshell/SKILL.md`). Step 4 now installs OpenShell when it is missing
  (`setup --step openshell -- --enable` runs `setup/install-openshell.sh` at the `versions.json`
  pin) and stops with the exact `gateway.toml` lines when the gateway refuses the mounts. On a
  box like the lab VM, where OpenShell already runs, it only checks.
- A read-only deploy key for `nanoco-bot/nanoclaw` on the machine (see `memory/lab-vm.md`
  conventions) — the script clones over SSH.
- ~3 GB free disk for the image builds; more headroom if other images/containers already sit on
  the box.

## Running it

```bash
./clean-install-demo.sh [workdir]              # clone + enable OpenShell + run the demo
./clean-install-demo.sh [workdir] --teardown    # stop the services this script started
```

`workdir` must not already exist — that's what makes this a clean install, not a reused clone.
Default is `./nanoclaw-openshell-demo`.

The script is self-narrating: each of 9 numbered steps prints what it's doing and why. Let it
run to the end before touching anything (~3-5 minutes once the images are cached, longer on the
very first image build).

## What each phase proves

| Step | What it does | What it proves |
|---|---|---|
| 1 | Clean clone of the branch | Nothing pre-exists; this is a real from-scratch install |
| 2 | `pnpm install` | Standard dependency install, no special-casing |
| 3 | Build base agent image, derive a `:openshell` variant | OpenShell's WORKDIR requirement is a documented, scriptable image step, not a manual hack |
| 4 | `setup --step openshell -- --enable` | The literal "Enable OpenShell sandboxing?" step from the interactive wizard, driven headlessly — proves it's a standard setup step, not a side door |
| 5 | Write the demo-only harness | Clearly separates what's shipped (the driver/gateway/CLI) from what's scaffolding (mock CRM, scripted model) |
| 6 | Patch `.env`, stamp the upgrade marker | Wires the derived image + demo gateway in; the upgrade-marker stamp is the documented recovery step for an install that completed setup via individual `--step` calls rather than the interactive wizard (see `scripts/upgrade-state.ts`) |
| 7 | Start mock CRM, scripted model, NanoClaw host | A real NanoClaw host comes up with `driver="openshell"` selected as the session runtime |
| 8 | Register alice and bob with the **same** fake CRM token but different OpenShell egress policy (alice: allowed; bob: denied) | Sets up the controlled comparison |
| 9 | Ask both the identical question, show the CRM's own hit log | **Policy, not possession of the credential, decides access** — alice's call reaches the mock CRM (HTTP 200), bob's is blocked at the OpenShell egress proxy before it ever reaches the API |

## Suggested narration for presenting this to the team

1. Open with the one-liner: "Same code, same credential, two agents — only the policy differs."
2. Walk steps 1-4 fast (`"this is just `setup --step openshell --enable`, the real wizard step,
   run headlessly"`) — don't dwell on the demo harness in step 5, just flag it as a credential
   stand-in.
3. Pause on step 9's output: point at the CRM's own `/__hits` log (ground truth, not something
   the agents can spoof) and show exactly one `200` (alice) and bob's call never arriving.
4. Finish live with the policy CLI the script prints at the end:
   ```bash
   docker ps --format '{{.Names}}' | grep ncl-      # find a running sandbox
   pnpm run ncl openshell-policy view    --sandbox <name>
   pnpm run ncl openshell-policy list    --sandbox <name>
   pnpm run ncl openshell-policy approve --sandbox <name> --chunk-id <id>
   pnpm run ncl openshell-policy reject  --sandbox <name> --chunk-id <id> --reason "..."
   pnpm run ncl openshell-policy add-rule --sandbox <name> --add-endpoint <host:port> --binary <path> --dry-run
   ```
   This shows the policy surface is a real, inspectable, changeable thing at runtime — not just
   a static file nobody can see.
5. Caveat to state out loud (don't let it pass silently): "The model answering alice/bob here is
   scripted, not Claude — this box has no API key. The sandboxing, the egress proxy, and the
   policy enforcement you just watched are all real; only the 'brain' is a stand-in."

## Tearing down

```bash
./clean-install-demo.sh <workdir> --teardown
```

Stops the NanoClaw host, the mock CRM, and the scripted model. Leaves `<workdir>` on disk for
inspection — remove it yourself when done (`rm -rf <workdir>`), and consider `docker image
prune` / `docker system prune` afterward since each clean run builds a fresh, uniquely-named
image (clone path changes → image slug changes, see `src/install-slug.ts`).

## Known rough edges on a fresh box (not specific to this PR)

- **pnpm resolution**: if `pnpm` isn't already on PATH, `corepack enable` then `corepack prepare
  pnpm@<version-from-package.json> --activate` — don't let corepack auto-fetch "latest", a
  recent pnpm major (12.x) ships ESM-only bins that an older bundled corepack can't resolve.
- **Disk headroom**: a fresh image build needs noticeably more headroom than the final image
  size during the build/export/unpack phase. If a build fails with `no space left on device`,
  check for stale containers pinning old image layers (`docker rm -f $(docker ps -aq)` before
  `docker image prune`/`docker system prune`).
