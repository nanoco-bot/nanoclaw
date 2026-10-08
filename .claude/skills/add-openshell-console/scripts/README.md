# OpenShell console

A small operator web page for a NanoClaw install that runs on OpenShell. It is plain `node:http`, one HTML page and vanilla JavaScript, with no build step. It doesn't call OpenShell's API: every action edits the OpenShell policy file or runs the `openshell` CLI. Install, exposure and troubleshooting are covered in the skill's [SKILL.md](../SKILL.md).

The header shows three things:

- the OpenShell gateway (connected, and its version);
- the Claude credential, which is install-wide (**Change** opens a dialog);
- the selected group's running sandboxes.

Everything else is per agent group: pick the group at the top right, then one of four tabs.

| Tab | What it does |
|---|---|
| Providers | Lists the group's providers from the policy file, with their type and key names from `openshell provider list`. **Attach** does up to four things: creates the provider when a service type is chosen (`openshell provider create --credential KEY`, with the value only in the child process's environment); adds it to the group in the policy file; attaches it to the group's running sandboxes (`openshell sandbox provider attach --wait`); and, by default, restarts the agent so its own process gets the key. **Service types** lists OpenShell's provider profiles. It creates one from a short form (rendered to profile YAML by `provider-types.ts`) or from pasted YAML (`openshell provider profile import`). |
| Network access | The group's network rules from the policy file. Adding or removing a rule saves the file, then applies the change to each running sandbox (`openshell policy update --add-endpoint` / `--remove-rule`), with the result shown per sandbox. |
| Approvals | `openshell rule get <sandbox> --status pending\|approved\|rejected` for the group's newest running sandbox; the others can be selected. **Always allow** approves the request (`openshell rule approve`) and saves the host as a group network rule. **Just this sandbox** only approves it. **Deny** runs `openshell rule reject`. |
| Activity | The console's activity log, `data/openshell-console/activity.jsonl`: every change and decision it made for the group, per sandbox, allowed and denied alike. |

## Code

| File | Role |
|---|---|
| `server.ts` | The HTTP server. It reads `NANOCLAW_OPENSHELL_UI_HOST` (default `127.0.0.1`), `NANOCLAW_OPENSHELL_UI_PORT` (default `8790`) and `NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS` from the environment or `.env`. |
| `routes.ts` | The API, including the Host and Origin checks. |
| `openshell-ops.ts` | The `openshell` commands the console runs, and the parsing of their output. |
| `provider-types.ts` | Service types (provider profiles). |
| `group-view.ts`, `activity.ts`, `http.ts` | The group view, the activity log, and the HTTP helpers. |
| `exec.ts` | The real side effects (CLI, policy file, credential step, group restart). Tests replace it. |
| `service.ts` | Installs or removes the background service. |
| `public/` | The page. |

To run it in the foreground from the project root:

```bash
node --import ./node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell-console/scripts/server.ts
```

## Security

The page has no login, and it can replace the model credential, attach credentials and allow network access. These protections apply:

- It binds loopback by default.
- It answers only to `127.0.0.1`, `localhost`, `::1` and the host names listed in `NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS`. That blocks DNS rebinding.
- A state-changing request that carries an `Origin` must come from the same host it is addressed to.
- POST bodies must be JSON.
- Static files are served with a Content-Security-Policy header.

None of these replace authentication. Reach the page through an SSH tunnel, or through a reverse proxy that requires a password.
