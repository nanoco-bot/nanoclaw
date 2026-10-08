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
 * driver owns comes from `.env` / the environment and the policy file, which
 * is re-read for every new sandbox.
 */
import { INSTALL_SLUG } from '../../config.js';
import { registerSessionDriver } from '../driver-registry.js';
import { realOpenShellCli } from './cli.js';
import { openShellGatewayEnv, openShellSettingsEnv } from './config.js';
import { OpenShellSessionDriver } from './driver.js';
import { modelProviderName } from './model-provider.js';
import { DEFAULT_POLICY_FILE } from './policy-file.js';
import { settingsFromEnv } from './settings.js';

export const OPENSHELL_DRIVER_KIND = 'openshell';

registerSessionDriver(OPENSHELL_DRIVER_KIND, (policy) => {
  // Read at selection time, not import time: an install that never selects
  // this driver never parses (or fails on) its settings.
  const settingsEnv = openShellSettingsEnv();
  const settings = settingsFromEnv(settingsEnv, undefined, DEFAULT_POLICY_FILE);
  return new OpenShellSessionDriver({
    ...policy,
    cli: realOpenShellCli(settings.bin, openShellGatewayEnv(settingsEnv)),
    loadPolicy: () => {
      const fresh = settingsFromEnv(openShellSettingsEnv(), undefined, DEFAULT_POLICY_FILE);
      return { policy: fresh.policy, ...(fresh.groupPolicy ? { groupPolicy: fresh.groupPolicy } : {}) };
    },
    modelProvider: modelProviderName(INSTALL_SLUG),
    ...(settings.pollIntervalMs ? { pollIntervalMs: settings.pollIntervalMs } : {}),
  });
});
