# Remove the OpenShell console

Stop and remove the service:

```bash
pnpm exec tsx .claude/skills/add-openshell-console/scripts/service.ts --disable
```

Then delete what it left behind, if you no longer need it: `NANOCLAW_OPENSHELL_UI_PORT`, `NANOCLAW_OPENSHELL_UI_HOST` and `NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS` in `.env`, the activity log `data/openshell-console/activity.jsonl`, and `logs/openshell-ui.log` / `logs/openshell-ui.error.log`. The OpenShell policy file and everything the console created in OpenShell (providers, service types, approved rules) stay; they belong to the install.
