/**
 * Host-side mount checks that need the FILESYSTEM, run by the driver's
 * prepare() right after the shared, pure validateSpec(). `types.ts` and
 * `policy.ts` stay pure by design; anything that touches the disk lives here.
 *
 * Pattern borrowed from NVIDIA/NemoClaw (Apache-2.0),
 * `src/lib/state/registry/host-mount.ts` (`assertNoSymlinkComponents`,
 * `parseReadOnlyHostMount`).
 *
 * Why a symlink check on top of validateSpec: hostPathCanonical() is lexical.
 * `<groupsRoot>/agent-one/data` passes every class/scope prefix rule — and if
 * `agent-one` (or any parent) is a symlink, Docker binds wherever it points,
 * e.g. the operator's home. The class rules judged one path; the runtime
 * mounts another. Refusing symlink components makes them the same path again.
 * (TOCTOU: a component swapped for a symlink between prepare() and start()
 * is not caught here; this narrows the window, it does not close it.)
 *
 * What does NOT exist is accepted: a missing component cannot be a symlink,
 * and a source missing at create time is the gateway's error to report.
 */
import fs from 'node:fs';
import path from 'node:path';

import { specInvalid, type MountClass, type SessionSpec } from './seam.js';

export type Lstat = (p: string) => Pick<fs.Stats, 'isSymbolicLink'>;

/** Every component of `hostPath` (an absolute path), lstat'ed root-down; throws naming the first symlink. */
export function assertNoSymlinkComponents(hostPath: string, lstat: Lstat = fs.lstatSync): void {
  let current = path.parse(hostPath).root;
  for (const segment of hostPath.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let isLink: boolean;
    try {
      isLink = lstat(current).isSymbolicLink();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing below a missing component can be a symlink either.
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw specInvalid(
        `mount source ${hostPath}: cannot inspect ${current} (${code ?? (error instanceof Error ? error.message : String(error))})`,
      );
    }
    if (isLink) {
      throw specInvalid(
        `mount source ${hostPath} has a symlink component at ${current}; mount sources must be real paths ` +
          '(a symlink would bind wherever it points, outside the root the mount rules checked)',
      );
    }
  }
}

/**
 * Container paths a non-pinned mount may not cover: the image's own system
 * tree. A read-write `allowlisted-extra` bound over `/usr` could replace
 * `/usr/local/bin/node` — one of the binaries the gateway egress rule trusts —
 * and over `/etc` the resolver or passwd. Fixed list, not the operator's
 * NANOCLAW_OPENSHELL_BASE_RO, because that one includes `/app`, where core
 * legitimately mounts `/app/.nanoclaw-session.json` as group-state.
 */
export const PROTECTED_CONTAINER_ROOTS: readonly string[] = [
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/etc',
  '/proc',
  '/sys',
  '/dev',
];

/**
 * The two classes whose container path is a composition choice:
 * classRequiredByPath() pins gateway-trust / identity-material / install-surface
 * by HOST root, and those have fixed, core-chosen targets. group-state and
 * allowlisted-extra (operator allowlist, provider contributions) do not.
 */
const UNPINNED_CLASSES: ReadonlySet<MountClass> = new Set(['group-state', 'allowlisted-extra']);

function covers(root: string, p: string): boolean {
  return p === root || p.startsWith(`${root}/`);
}

export function assertContainerTarget(mount: { class: MountClass; containerPath: string }): void {
  if (!UNPINNED_CLASSES.has(mount.class)) return;
  if (mount.containerPath === '/') throw specInvalid(`${mount.class} mount may not target '/'`);
  const hit = PROTECTED_CONTAINER_ROOTS.find((root) => covers(root, mount.containerPath));
  if (hit) {
    throw specInvalid(
      `${mount.class} mount target ${mount.containerPath} is inside the image's system tree (${hit}); ` +
        'mount it under /workspace (allowlisted mounts land in /workspace/extra) instead',
    );
  }
}

/** prepare()'s filesystem pass over every mount of every container. */
export function assertHostMounts(spec: SessionSpec, lstat: Lstat = fs.lstatSync): void {
  for (const container of spec.containers) {
    for (const mount of container.mounts) {
      assertNoSymlinkComponents(mount.hostPath, lstat);
      assertContainerTarget(mount);
    }
  }
}
