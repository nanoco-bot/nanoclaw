# OpenShell setup console

A small operator web page for a NanoClaw install that runs on OpenShell: plain `node:http`, one HTML page and vanilla JS, no build step. It does not talk to OpenShell's API; every action edits the OpenShell policy file or runs the `openshell` CLI.

The header shows the OpenShell gateway (connected, version), the Claude credential (install-wide; **Change** opens a dialog) and the selected group's running sandboxes. Everything else is per agent group: pick the group at the top right, then one of four tabs.

| Tab | What it does |
|---|---|
| Providers | Lists the group's providers from the policy file, with their type and key names from `openshell provider list`. **Attach** creates the provider when a service type is chosen (`openshell provider create --credential KEY`, the value in the child's environment only), adds it to the group in the policy file, attaches it to the group's running sandboxes (`openshell sandbox provider attach --wait`) and, by default, asks the host to restart the agent so its own process gets the key. **Service types** lists OpenShell's provider profiles and creates one from a short form (rendered to profile YAML by `provider-types.ts`) or pasted YAML (`openshell provider profile import`). |
| Network access | The group's network rules from the policy file. Add and remove save to the file, then apply to each running sandbox (`openshell policy update --add-endpoint` / `--remove-rule`), reported per sandbox. |
| Approvals | `openshell rule get <sandbox> --status pending\|approved\|rejected` for the group's newest running sandbox (others selectable). **Always allow** approves (`openshell rule approve`) and saves the host as a group network rule; **Just this sandbox** only approves; **Deny** runs `openshell rule reject`. |
| Activity | The console's activity log, `data/openshell-console/activity.jsonl`: every change and decision it made for the group, per sandbox, allowed and denied alike. |

Code: `routes.ts` (the API), `openshell-ops.ts` (the `openshell` commands it runs and their parsing), `provider-types.ts` (service types), `activity.ts`, `http.ts`, `exec.ts` (the real side effects), `server.ts`, and `public/`.

**Run it.** `pnpm exec tsx setup/index.ts --step openshell-ui -- --enable [--port 8790]` installs and starts it as a background service and prints the URL: the `openshell-setup-ui-<slug>` LaunchAgent on macOS, a systemd unit of the same name on Linux. To run it by hand from the project root: `node --import ./node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell/scripts/ui/server.ts`. The address comes from `NANOCLAW_OPENSHELL_UI_HOST` and `NANOCLAW_OPENSHELL_UI_PORT` (default `8790`), read from the environment or `.env`.

**Security.** The page has no login. It can replace the model credential, attach credentials and allow network access. Reach it only through an SSH tunnel or a password-gated reverse proxy, and keep the port firewalled. POST bodies must be JSON, so a third-party page cannot submit to it through a logged-in proxy session; that is a backstop, not authentication.
