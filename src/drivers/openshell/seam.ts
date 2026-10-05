/**
 * The one file in this directory that names NanoClaw's driver seam.
 *
 * In-tree, this simply re-exports the host's own modules (`../types.js`,
 * `../driver-registry.js`, `../../log.js`), so the OpenShell driver and
 * `drivers/index.ts` share ONE registry module instance. Kept as a single
 * indirection (rather than importing the seam from every file) so the driver
 * sources stay byte-comparable with the POC package they were ported from
 * (nanoco-bot/poc-nvidia-openshell, packages/openshell-driver).
 */
export * from '../types.js';
export { registerSessionDriver, getSessionDriverFactory, listSessionDriverKinds } from '../driver-registry.js';
export type { SessionDriverFactory } from '../driver-registry.js';
export { log } from '../../log.js';
