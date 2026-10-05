# OpenShell setup UI

A small operator web page for a NanoClaw install that runs on OpenShell. It uses plain `node:http`, one HTML page and vanilla JS, with no build step. It does not implement any OpenShell client logic; every action runs a command that already exists:

| Panel | What runs | Confirmation shown |
|---|---|---|
| Claude credential | `scripts/auth.ts claude`, with exactly one of `NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN` or `NANOCLAW_ANTHROPIC_API_KEY` set (the other inputs are cleared) | The credential kind read back by `setup/verify.ts` `checkCredentials()`: the service's `/proc/<pid>/environ`, else the unit's Environment, else the drop-in |
| Provider | `openshell provider create --name … --type … [--credential KEY]… [--config K=V]… [--global-profile]`, then `openshell provider get <name>` | Raw stdout and stderr of both commands |
| Proposals | `ncl openshell-policy list/approve/reject/view`, dispatched in-process as the host caller | The command's output, the `agent_policy_proposals_enabled` note, and parsed chunks |
| History | — | `data/openshell-setup-ui/decisions.jsonl` (append-only, 0600), plus decisions OpenShell lists as approved or rejected that the log has no record of |

Credential values for `provider create` are passed with OpenShell's `--credential KEY` env-lookup form. The value is in the child's environment, not its argv, so it never appears in the process table.

**Run it.** `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]` installs and starts the UI as a background service and prints the URL. On macOS that is the `openshell-setup-ui-<slug>` LaunchAgent in `~/Library/LaunchAgents`. On Linux it is a systemd unit of the same name. The setup wizard (`bash nanoclaw.sh`) offers the same step right after OpenShell sandboxing is enabled. It is a separate yes/no prompt, defaulting to no. Non-interactive runs use `NANOCLAW_OPENSHELL_UI=true` and optionally `NANOCLAW_OPENSHELL_UI_PORT`; `NANOCLAW_SKIP=openshell-ui` skips it. To run it by hand from the project root instead: `node --import ./node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell/scripts/ui/server.ts`. The address comes from `NANOCLAW_OPENSHELL_UI_HOST` (default `0.0.0.0`) and `NANOCLAW_OPENSHELL_UI_PORT` (default `8790`), read from the environment or `.env`.

**Security.** The page has no login. It can replace the model credential and approve egress. Reach it only through your password-gated reverse proxy, and block direct access to the port. POSTs must be JSON, so a third-party page cannot submit to it through a logged-in proxy session. That is a CSRF backstop, not authentication.
