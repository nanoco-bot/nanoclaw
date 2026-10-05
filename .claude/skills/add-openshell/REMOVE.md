# Remove OpenShell gateway

Use NanoClaw's journal-derived skill removal first. It removes the copied provider files, the agent guidance, and the `import './openshell.js';` line in `src/gateway-providers/installed.ts`.

Then return this copy to Docker sandboxing. In `.env`, remove `NANOCLAW_RUNTIME_DRIVER=openshell` (Docker is the default) and the `OPENSHELL_*` / `NANOCLAW_OPENSHELL_*` settings. Select and install another gateway before restarting NanoClaw, for example `pnpm exec tsx setup/index.ts --step gateway -- onecli`.

If you added `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` to the service environment for the relay, remove that drop-in with `systemctl --user revert <unit>`.

Running OpenShell sandboxes belong to the OpenShell gateway, not to this copy's Docker daemon. List them with `openshell sandbox list` and delete only those labelled with this install's `nanoclaw-install` slug. Do not change the OpenShell gateway itself or other users' sandboxes.
