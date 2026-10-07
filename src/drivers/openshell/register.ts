/**
 * Registration of the `openshell` session driver.
 *
 * Imported from the driver barrel `src/drivers/installed.ts`. `drivers/index.ts`
 * side-effect-imports that barrel before its body runs, so this registration
 * lands in the registry (its own module, `driver-registry.ts`, precisely so
 * this is not a TDZ error) before `createSessionDriver(configuredDriverKind())`
 * looks up `NANOCLAW_RUNTIME_DRIVER=openshell`.
 *
 * Registering is inert: an install that never selects `openshell` never runs
 * the factory below, so it never reads (or fails on) these settings and the
 * default `docker` selection is unchanged.
 *
 * The factory receives the fully-resolved MountPolicy; everything else the
 * driver owns (here: operator settings from `.env` / the environment).
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { listGroupEgressRules, listGroupProviders } from '../../db/openshell-group-resources.js';
import { realOpenShellCli } from './cli.js';
import { openShellGatewayEnv, openShellSettingsEnv } from './config.js';
import { OpenShellSessionDriver } from './driver.js';
import type { EgressRule } from './policy.js';
import { registerSessionDriver } from './seam.js';
import { settingsFromEnv } from './settings.js';

export const OPENSHELL_DRIVER_KIND = 'openshell';

/** OpenShell provider names attached to the group with this folder (openshell_group_providers). */
export async function dbGroupProviders(folder: string): Promise<string[]> {
  const group = await getAgentGroupByFolder(folder);
  return group ? (await listGroupProviders(group.id)).map((p) => p.name) : [];
}

/** The group's raw network paths (openshell_group_egress), as EgressRules. */
export async function dbGroupEgress(folder: string): Promise<EgressRule[]> {
  const group = await getAgentGroupByFolder(folder);
  if (!group) return [];
  return (await listGroupEgressRules(group.id)).map(({ name, host, ports, binaries }) => ({
    name,
    host,
    ports,
    binaries,
  }));
}

registerSessionDriver(OPENSHELL_DRIVER_KIND, (policy) => {
  // Read at selection time, not import time: an install that never selects
  // this driver never parses (or fails on) its settings.
  const settingsEnv = openShellSettingsEnv();
  const settings = settingsFromEnv(settingsEnv);
  return new OpenShellSessionDriver({
    ...policy,
    cli: realOpenShellCli(settings.bin, openShellGatewayEnv(settingsEnv)),
    policy: settings.policy,
    ...(settings.groupPolicy ? { groupPolicy: settings.groupPolicy } : {}),
    // Durable per-group resources from the central DB, read at every sandbox
    // creation (ncl openshell-provider / openshell-network write them).
    groupProviders: dbGroupProviders,
    groupEgress: dbGroupEgress,
    ...(settings.pollIntervalMs ? { pollIntervalMs: settings.pollIntervalMs } : {}),
  });
});
