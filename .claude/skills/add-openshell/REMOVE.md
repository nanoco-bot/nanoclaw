# Remove OpenShell gateway

Use NanoClaw's journal-derived skill removal first. It removes the copied provider files, the agent guidance, and the `import './openshell.js';` line in `src/gateway-providers/installed.ts`.

Then return this copy to Docker sandboxing. In `.env`, remove `NANOCLAW_RUNTIME_DRIVER=openshell` (Docker is the default) and the `OPENSHELL_*` / `NANOCLAW_OPENSHELL_*` settings. Select and install another gateway before restarting NanoClaw, for example `pnpm exec tsx setup/index.ts --step gateway -- onecli`.

The agents' Claude credential is an OpenShell provider named `nanoclaw-<install slug>-claude`. Delete it with `openshell provider delete nanoclaw-<slug>-claude`; the profiles `nanoclaw-claude-oauth` and `nanoclaw-claude-api-key` can go with `openshell provider profile delete` once no other install uses them.

Running OpenShell sandboxes belong to the OpenShell gateway, not to this copy's Docker daemon. List them with `openshell sandbox list` and delete only those labelled with this install's `nanoclaw-install` slug. Do not change the OpenShell gateway itself or other users' sandboxes.

If the setup UI was installed, remove its service with `pnpm exec tsx setup/index.ts --step openshell-ui -- --disable`. Its decision log is `data/openshell-setup-ui/decisions.jsonl`; delete it if you no longer need the history.
