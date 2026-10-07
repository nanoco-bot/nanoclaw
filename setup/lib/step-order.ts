/**
 * Where the setup wizard (setup/auto.ts) runs the agent-auth step relative to
 * the service step.
 *
 * Default — every gateway, every platform: auth BEFORE service. That order is
 * load-bearing: when auth installs a non-Claude provider (applyProviderSkill
 * copies its payload into src/ and appends barrels), the service step's
 * `pnpm run build` must compile it in.
 *
 * Exception — OpenShell on macOS: auth AFTER service. OpenShell's credential
 * goes into the NanoClaw host's LaunchAgent plist (there is no launchd
 * equivalent of the systemd drop-in, which may precede its unit), so the
 * plist the service step writes has to exist first. Safe there because
 * OpenShell's runtime is always Claude — auth installs nothing for the build
 * to miss.
 */
export function authRunsAfterService(input: { openshellEnabled: boolean; platform: string }): boolean {
  return input.openshellEnabled && input.platform === 'macos';
}
