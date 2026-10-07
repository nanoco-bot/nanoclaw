# OpenShell setup UI

A small operator web page for a NanoClaw install that runs on OpenShell. It uses plain `node:http`, one HTML page and vanilla JS, with no build step. It does not implement any OpenShell client logic; every action runs a command that already exists. The page has three tabs; **Agent groups** has a group selector (and a sandbox picker filled with the group's live sandboxes) and four sub-tabs:

| Tab | What runs | Confirmation shown |
|---|---|---|
| Providers · profiles (system-wide) | `ncl openshell-provider profile-list` / `profile-import` (pasted or uploaded YAML, staged in a private temp file) | The command's output |
| Providers · instances (system-wide) | `openshell provider create --name … --type … [--credential KEY]… [--config K=V]… [--global-profile]`, then `openshell provider get <name>`; `openshell provider list` | Raw stdout and stderr of both commands |
| Agent groups · Attach / Detach | `ncl openshell-provider list / attach / detach --group <id>`: saved to the group's config (every new sandbox gets `--provider`), and applied at once to the group's live sandboxes | The group's provider list and which live sandboxes were changed |
| Agent groups · Network paths | `ncl openshell-policy view / add-rule / apply-preset` on the selected sandbox (dry run by default) | The command's output |
| Agent groups · Pending approvals | `ncl openshell-policy list / approve / reject` | The command's output, the `agent_policy_proposals_enabled` note, and parsed chunks |
| Agent groups · Audit log | — | For the group, newest first: `data/openshell-provider/changes.jsonl` (attach/detach), `data/openshell-setup-ui/decisions.jsonl` (approve/reject, append-only, 0600) and `data/openshell-policy/changes.jsonl` (add-rule/apply-preset) on any of its sandboxes, plus decisions OpenShell lists for its live sandboxes that no log has |
| Claude credential | `scripts/auth.ts claude`, with exactly one of `NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN` or `NANOCLAW_ANTHROPIC_API_KEY` set (the other inputs are cleared) | The credential kind read back by `setup/verify.ts` `checkCredentials()`: the service's `/proc/<pid>/environ`, else the unit's Environment, else the drop-in |

The `ncl` commands are dispatched in-process as the host caller. The policy commands touch no database. The provider commands, the group selector and the audit open the central DB (`data/v2.db`) lazily, in the same `tool` role the repo's own scripts use. The host stays the only process that runs migrations, so after an update restart the host once before attaching providers here.

Credential values for `provider create` are passed with OpenShell's `--credential KEY` env-lookup form. The value is in the child's environment, not its argv, so it never appears in the process table.

**Run it.** `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]` installs and starts the UI as a background service and prints the URL. On macOS that is the `openshell-setup-ui-<slug>` LaunchAgent in `~/Library/LaunchAgents`. On Linux it is a systemd unit of the same name. The setup wizard (`bash nanoclaw.sh`) runs the same step without asking at the end of every run where OpenShell sandboxing is enabled, and prints only the URL. `NANOCLAW_OPENSHELL_UI_PORT` picks the port; `NANOCLAW_SKIP=openshell-ui` skips it. A UI that fails to start is a warning, not a setup failure. To run it by hand from the project root instead: `node --import ./node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell/scripts/ui/server.ts`. The address comes from `NANOCLAW_OPENSHELL_UI_HOST` (default `0.0.0.0`) and `NANOCLAW_OPENSHELL_UI_PORT` (default `8790`), read from the environment or `.env`.

**Security.** The page has no login. It can replace the model credential and approve egress. Reach it only through your password-gated reverse proxy, and block direct access to the port. POSTs must be JSON, so a third-party page cannot submit to it through a logged-in proxy session. That is a CSRF backstop, not authentication.
