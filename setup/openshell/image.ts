/**
 * The OpenShell-compatible agent image, derived from the base agent image.
 *
 * OpenShell refuses any bind mount that covers the image's WORKDIR
 * ("mount target '/workspace' is reserved for the OpenShell workspace"). The
 * stock image (locally built or the pulled hardened one) sets
 * WORKDIR /workspace/group, and core always mounts the session at /workspace,
 * so every OpenShell sandbox create fails. The derived image moves WORKDIR to
 * /sandbox and changes nothing else.
 *
 * Extracted from docs/openshell-demo/clean-install-demo.sh (step 3b), which
 * did this by hand; that script now calls this module. Built by:
 *   - setup's `container` step, after the base is built or pulled,
 *   - `setup --step openshell` when it enables OpenShell on a copy that already
 *     has a base image,
 *   - container/build.sh after every rebuild (`--if-configured`).
 * `src/config.ts` (resolveContainerImage) selects it on the openshell driver.
 *
 *   pnpm exec tsx setup/openshell/image.ts [--if-configured]
 */
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { openShellImage as getOpenShellContainerImage } from '../../src/drivers/openshell/image.js';
import { getDefaultContainerImage } from '../../src/install-slug.js';

export const OPENSHELL_WORKDIR = '/sandbox';

/**
 * Every container path core binds into the agent (src/container-runner.ts,
 * buildMounts). The derived WORKDIR must not overlap any of them; a test
 * keeps this list in step with container-runner.ts.
 */
export const AGENT_MOUNT_TARGETS: readonly string[] = [
  '/workspace',
  '/workspace/agent',
  '/workspace/agent/CLAUDE.md',
  '/workspace/agent/container.json',
  '/app/.nanoclaw-session.json',
  '/app/src',
  '/app/skills',
  '/home/node/.claude',
];

const under = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith('/') ? parent : `${parent}/`);

/** Mount targets that cover, or sit inside, `workdir`. Empty means OpenShell will accept it. */
export function workdirConflicts(workdir: string, targets: readonly string[] = AGENT_MOUNT_TARGETS): string[] {
  const wd = path.posix.normalize(workdir || '/');
  return targets.filter((t) => under(wd, t) || under(t, wd));
}

/** Same Dockerfile the demo script piped into `docker build -`, plus honest provenance labels. */
export function openShellImageDockerfile(baseImage: string, baseId = ''): string {
  return [
    `FROM ${baseImage}`,
    'USER root',
    `RUN mkdir -p ${OPENSHELL_WORKDIR} && chown node:node ${OPENSHELL_WORKDIR}`,
    'USER node',
    `WORKDIR ${OPENSHELL_WORKDIR}`,
    // A derived build inherits the base's labels; say what this is (same rule
    // as buildAgentGroupImage in src/container-runner.ts).
    'LABEL dev.nanoclaw.image-source="derived"',
    'LABEL dev.nanoclaw.derived-for="openshell"',
    ...(baseId ? [`LABEL dev.nanoclaw.derived-from="${baseId}"`] : []),
    '',
  ].join('\n');
}

export interface DockerRunner {
  (args: string[], input?: string): { status: number | null; stdout: string; stderr: string };
}

export const realDocker: DockerRunner = (args, input) => {
  const res = spawnSync(process.env.CONTAINER_RUNTIME || 'docker', args, {
    input,
    encoding: 'utf-8',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return {
    status: res.status,
    stdout: res.stdout ?? '',
    stderr: (res.stderr ?? '') + (res.error ? res.error.message : ''),
  };
};

export type OpenShellImageResult =
  | { ok: true; image: string; base: string; workdir: string }
  | {
      ok: false;
      reason: 'base-missing' | 'build-failed' | 'workdir-conflict';
      image: string;
      base: string;
      detail: string;
    };

export function buildOpenShellImage(
  projectRoot: string = process.cwd(),
  docker: DockerRunner = realDocker,
  base: string = getDefaultContainerImage(projectRoot),
  image: string = getOpenShellContainerImage(projectRoot),
): OpenShellImageResult {
  const inspect = docker(['image', 'inspect', '--format', '{{.Id}}', base]);
  if (inspect.status !== 0) {
    return { ok: false, reason: 'base-missing', image, base, detail: `base image ${base} not found` };
  }
  const build = docker(['build', '-t', image, '-'], openShellImageDockerfile(base, inspect.stdout.trim()));
  if (build.status !== 0) {
    return { ok: false, reason: 'build-failed', image, base, detail: build.stderr.trim().slice(-800) };
  }
  const wd = docker(['image', 'inspect', '--format', '{{.Config.WorkingDir}}', image]);
  const workdir = wd.stdout.trim();
  const conflicts = wd.status === 0 ? workdirConflicts(workdir) : ['<inspect failed>'];
  if (conflicts.length > 0) {
    return {
      ok: false,
      reason: 'workdir-conflict',
      image,
      base,
      detail: `WORKDIR '${workdir}' overlaps mount target(s) ${conflicts.join(', ')}`,
    };
  }
  return { ok: true, image, base, workdir };
}

/** `.env`/environment says this copy runs on OpenShell (process env wins). */
export function openShellConfigured(projectRoot: string = process.cwd()): boolean {
  const fromEnv = process.env.NANOCLAW_RUNTIME_DRIVER?.trim();
  if (fromEnv) return fromEnv.toLowerCase() === 'openshell';
  try {
    const m = readFileSync(path.join(projectRoot, '.env'), 'utf-8').match(/^NANOCLAW_RUNTIME_DRIVER=(.*)$/m);
    return (
      m?.[1]
        .trim()
        .replace(/^["']|["']$/g, '')
        .toLowerCase() === 'openshell'
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ifConfigured = process.argv.includes('--if-configured');
  if (ifConfigured && !openShellConfigured()) process.exit(0);
  const result = buildOpenShellImage();
  if (result.ok) {
    console.log(`OpenShell image: ${result.image} (WORKDIR ${result.workdir}, from ${result.base})`);
  } else {
    console.error(`Could not build the OpenShell image ${result.image}: ${result.detail}`);
    process.exit(1);
  }
}
