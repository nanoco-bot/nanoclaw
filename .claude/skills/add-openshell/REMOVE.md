# Remove OpenShell gateway

If the console was added, remove it first (`/add-openshell-console`'s `REMOVE.md`).

1. Use NanoClaw's journal-derived skill removal. It removes the copied provider files, the agent guidance, and the `import './openshell.js';` line in `src/gateway-providers/installed.ts`.
2. Return this copy to Docker sandboxing: `pnpm exec tsx setup/index.ts --step openshell -- --disable`. This removes `NANOCLAW_RUNTIME_DRIVER` and the `openshell` gateway selection from `.env`. It keeps the other `OPENSHELL_*` and `NANOCLAW_OPENSHELL_*` settings; delete them if you won't re-enable.
3. Install another gateway before restarting NanoClaw, for example `pnpm exec tsx setup/index.ts --step gateway -- onecli`.
4. In OpenShell, remove what belongs to this install only:
   - its sandboxes: `openshell sandbox list`, then delete the ones labelled with this install's `nanoclaw-install` slug;
   - its Claude provider: `openshell provider delete nanoclaw-<slug>-claude`;
   - the profiles `nanoclaw-claude-oauth` and `nanoclaw-claude-api-key`, with `openshell provider profile delete`, once no other install uses them.

   Don't change the OpenShell gateway itself or other installs' sandboxes.

The policy file (`data/openshell/policy.yaml`) and any providers created for agent groups are left in place. Delete them if you no longer need them.
