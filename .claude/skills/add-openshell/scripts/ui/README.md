# OpenShell setup UI

A small operator web page for a NanoClaw install that runs on OpenShell. It uses plain `node:http`, one HTML page and vanilla JS, with no build step. It does not implement any OpenShell client logic; every action runs a command that already exists:

The Claude credential is install-wide and has its own section. Everything else is per agent group: pick the group at the top, then one of four tabs.

| Panel | What runs | Confirmation shown |
|---|---|---|
| Claude credential (install-wide) | `scripts/auth.ts claude`, with exactly one of `NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN` or `NANOCLAW_ANTHROPIC_API_KEY` set (the other inputs are cleared) | The credential kind read back by `setup/verify.ts` `checkCredentials()`: the service's `/proc/<pid>/environ`, else the unit's Environment, else the drop-in |
| Providers tab | `ncl openshell-provider attach/detach/list --group <id>` in-process; attach with a type runs `openshell provider create --name … --type … [--credential KEY]…` first. Templates: OpenShell's shipped profile hints plus `ncl openshell-provider-profile` custom ones | The group's attached providers (names, types, credential key names) read back from the central DB |
| Network paths tab | `ncl openshell-network add/remove/list --group <id>` in-process; add/remove are also applied live (`openshell policy update`) to each of the group's running sandboxes | The group's rules read back from the central DB, plus applied/failed per running sandbox |
| Pending approvals tab | `ncl openshell-policy list/approve/reject` on one of the group's live sandboxes: by default the newest active session whose container is running (others offered in a select) | The command's output, the `agent_policy_proposals_enabled` note, and parsed chunks |
| Audit log tab | — | The group's entries from `data/openshell-policy/changes.jsonl` (provider, network-path, add-rule and preset changes) and `data/openshell-setup-ui/decisions.jsonl` (approve/reject, now recording the group), plus decisions OpenShell lists for the default sandbox that neither log has; approved and denied/failed alike |

The per-group tabs open the central DB (`data/v2.db`) as a `tool` client. They need the host to have applied its migrations (026, 027); until then they say so.

Credential values for `provider create` are passed with OpenShell's `--credential KEY` env-lookup form. The value is in the child's environment, not its argv, so it never appears in the process table.

**Run it.** `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]` installs and starts the UI as a background service and prints the URL. On macOS that is the `openshell-setup-ui-<slug>` LaunchAgent in `~/Library/LaunchAgents`. On Linux it is a systemd unit of the same name. The setup wizard (`bash nanoclaw.sh`) runs the same step without asking at the end of every run where OpenShell sandboxing is enabled, and prints only the URL. `NANOCLAW_OPENSHELL_UI_PORT` picks the port; `NANOCLAW_SKIP=openshell-ui` skips it. A UI that fails to start is a warning, not a setup failure. To run it by hand from the project root instead: `node --import ./node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell/scripts/ui/server.ts`. The address comes from `NANOCLAW_OPENSHELL_UI_HOST` (default `0.0.0.0`) and `NANOCLAW_OPENSHELL_UI_PORT` (default `8790`), read from the environment or `.env`.

**Security.** The page has no login. It can replace the model credential and approve egress. Reach it only through your password-gated reverse proxy, and block direct access to the port. POSTs must be JSON, so a third-party page cannot submit to it through a logged-in proxy session. That is a CSRF backstop, not authentication.
