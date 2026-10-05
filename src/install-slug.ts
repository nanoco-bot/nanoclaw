/**
 * Per-checkout install identifiers. Lets two NanoClaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared `nanoclaw-agent:latest` docker image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 *
 * NANOCLAW_INSTALL_ID overrides the cwd derivation for deployments where
 * the checkout path is not a stable identity (copied or ephemeral trees), so
 * identity can come from the environment instead. The value flows into
 * docker labels, image names, and service unit names — hence the
 * conservative charset. Unset = today's behavior, byte-identical.
 */
import { createHash } from 'crypto';

const INSTALL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  const override = process.env.NANOCLAW_INSTALL_ID;
  if (override) {
    if (!INSTALL_ID_PATTERN.test(override)) {
      throw new Error(`NANOCLAW_INSTALL_ID must be 1-32 chars of [a-z0-9_-] starting alphanumeric (got '${override}')`);
    }
    return override;
  }
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `com.nanoclaw-v2-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return `com.nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** systemd unit name (no .service suffix). e.g. `nanoclaw-v2-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return `nanoclaw-v2-${getInstallSlug(projectRoot)}`;
}

/** Docker image base (no tag). e.g. `nanoclaw-agent-v2-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `nanoclaw-agent-v2-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}

/**
 * Tag of the OpenShell-compatible agent image, derived from the base image by
 * setup (`setup/lib/openshell-image.ts`). OpenShell refuses any bind mount that
 * covers the image's WORKDIR; the stock image's WORKDIR is /workspace/group and
 * the session is always mounted at /workspace, so OpenShell needs its own tag.
 */
export function getOpenShellContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:openshell`;
}

/**
 * The agent image sessions spawn from (before any per-group `image_tag`).
 * An explicit CONTAINER_IMAGE always wins; otherwise the runtime driver picks
 * the base (`:latest`) or the OpenShell-derived (`:openshell`) tag. Callers
 * pass values already resolved with process-env-over-.env precedence.
 */
export function resolveContainerImage(
  settings: { CONTAINER_IMAGE?: string; CONTAINER_IMAGE_BASE?: string; NANOCLAW_RUNTIME_DRIVER?: string },
  projectRoot?: string,
): string {
  const explicit = settings.CONTAINER_IMAGE?.trim();
  if (explicit) return explicit;
  const base = settings.CONTAINER_IMAGE_BASE?.trim() || getContainerImageBase(projectRoot);
  return settings.NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() === 'openshell'
    ? `${base}:openshell`
    : `${base}:latest`;
}
