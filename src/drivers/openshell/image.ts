/**
 * The agent image OpenShell sandboxes run.
 *
 * OpenShell refuses a bind mount that covers the image's WORKDIR. The stock
 * agent image's WORKDIR is /workspace/group and the session is mounted at
 * /workspace, so OpenShell needs a derived image with WORKDIR /sandbox, tagged
 * `:openshell` next to the stock `:latest` (setup builds it, see
 * setup/openshell/image.ts). The driver swaps the tag; any other image
 * (an explicit CONTAINER_IMAGE, a group's own tag) is used as given.
 */
import { getContainerImageBase } from '../../install-slug.js';

export const OPENSHELL_IMAGE_TAG = 'openshell';

/** The derived image for this install's agent image base. */
export function openShellImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:${OPENSHELL_IMAGE_TAG}`;
}

/** `<base>:latest` → `<base>:openshell`; anything else unchanged. */
export function sandboxImage(image: string): string {
  return image.endsWith(':latest') ? `${image.slice(0, -':latest'.length)}:${OPENSHELL_IMAGE_TAG}` : image;
}
