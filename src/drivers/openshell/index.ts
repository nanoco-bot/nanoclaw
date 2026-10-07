// Library surface. Importing this does NOT register the driver — the driver
// barrel (`../installed.ts`) imports `./register.js` for that.
export {
  OpenShellSessionDriver,
  diffSnapshots,
  type OpenShellCapabilities,
  type OpenShellDriverOptions,
  type Logger,
} from './driver.js';
export { realOpenShellCli, OpenShellCliError, type OpenShellCli } from './cli.js';
export { configuredOpenShellCli, openShellSettingsEnv, openShellGatewayEnv } from './config.js';
export * from './policy.js';
export * from './group-policy.js';
export * from './realize.js';
export { settingsFromEnv, OPENSHELL_SETTING_KEYS, type EnvDriverSettings } from './settings.js';
