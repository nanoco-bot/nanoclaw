# Remove OpenShell gateway

Use NanoClaw's journal-derived skill removal first. It removes the copied provider files, the agent guidance, and the `import './openshell.js';` line in `src/gateway-providers/installed.ts`.

Then return this copy to Docker sandboxing. In `.env`, remove `NANOCLAW_RUNTIME_DRIVER=openshell` (Docker is the default) and the `OPENSHELL_*` / `NANOCLAW_OPENSHELL_*` settings. Select and install another gateway before restarting NanoClaw, for example `pnpm exec tsx setup/index.ts --step gateway -- onecli`.

Setup stored the relay's Claude credential in `~/.config/systemd/user/<unit>.service.d/credential.conf` (`/etc/systemd/system/…` for root installs). Delete that file, then run `systemctl --user daemon-reload`.

Running OpenShell sandboxes belong to the OpenShell gateway, not to this copy's Docker daemon. List them with `openshell sandbox list` and delete only those labelled with this install's `nanoclaw-install` slug. Do not change the OpenShell gateway itself or other users' sandboxes.

If the setup UI was installed, remove its service with `pnpm exec tsx setup/index.ts --step openshell-ui -- --disable`. Its decision log is `data/openshell-setup-ui/decisions.jsonl`; delete it if you no longer need the history.
