/**
 * The real side effects behind the console (routes.ts takes them as `UiDeps`).
 *
 *  - `openshell`: the binary and gateway selection this install is configured
 *    with (src/drivers/openshell/config.ts — the same settings the session
 *    driver uses), with colour off; stdout and stderr are both kept.
 *  - the central DB, opened once as a `tool` client, for agent groups and
 *    their sessions (read-only);
 *  - credential: setup's `gateway-auth` step, as a child `node` process
 *    with tsx's loader (no pnpm on the service PATH required);
 *  - restart: `groups-restart` on the HOST over its ncl socket.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openShellGatewayEnv, openShellSettingsEnv } from '../../../../src/drivers/openshell/config.js';
import { sandboxName } from '../../../../src/drivers/openshell/realize.js';
import { policyFilePath } from '../../../../src/drivers/openshell/policy-file.js';
import { settingsFromEnv } from '../../../../src/drivers/openshell/settings.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { readEnvFile } from '../../../../src/env.js';
import { SocketTransport } from '../../../../src/cli/socket-client.js';
import type { ExecResult } from './openshell-ops.js';
import type { UiDeps } from './routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..');
export const PROJECT_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
export const STATIC_DIR = path.join(HERE, 'public');

/** `node --import <tsx loader> setup/index.ts --step gateway-auth` — setup's own sign-in; no pnpm on the service PATH needed. */
export function credentialScriptArgs(loaderUrl: string, projectRoot: string): string[] {
  return ['--import', loaderUrl, path.join(projectRoot, 'setup', 'index.ts'), '--step', 'gateway-auth'];
}

/** Stable across tsx upgrades (node_modules/tsx is a symlink into the pnpm store). */
export function tsxLoaderUrl(projectRoot: string = PROJECT_ROOT): string {
  return pathToFileURL(path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
}

const TIMEOUT_MS = 180_000;

export type ExecFileLike = typeof execFile;

/** Promise wrapper that never rejects: exit code + both streams, or code null with the spawn error. */
export function execCapture(
  run: ExecFileLike,
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    run(
      file,
      args,
      { env: options.env, cwd: options.cwd, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const code = !err ? 0 : typeof err.code === 'number' ? err.code : null;
        const spawnError = err && typeof err.code !== 'number' ? `${err.message}\n` : '';
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + spawnError });
      },
    );
  });
}

/** Environment for an `openshell` child: configured gateway selection, caller extras, never colour. */
export function openShellChildEnv(
  extra: Record<string, string>,
  base: NodeJS.ProcessEnv = process.env,
  settingsEnv: NodeJS.ProcessEnv = openShellSettingsEnv(),
): NodeJS.ProcessEnv {
  return { ...base, ...openShellGatewayEnv(settingsEnv), ...extra, OPENSHELL_COLOR: 'never', NO_COLOR: '1' };
}

let dbReady: Promise<void> | undefined;
/** Open the central DB once for this process, read-only use (agent groups and sessions). */
function ensureDb(projectRoot: string): Promise<void> {
  dbReady ??= (async () => {
    const { initDb } = await import('../../../../src/db/connection.js');
    await initDb(path.join(projectRoot, 'data', 'v2.db'), { role: 'tool' });
  })().catch((err) => {
    dbReady = undefined; // retry on the next request
    throw err;
  });
  return dbReady;
}

export function realDeps(projectRoot: string = PROJECT_ROOT, run: ExecFileLike = execFile): UiDeps {
  return {
    async runOpenShell(args, env) {
      const settingsEnv = openShellSettingsEnv();
      let bin: string;
      try {
        bin = settingsFromEnv(settingsEnv).bin;
      } catch (err) {
        return { code: null, stdout: '', stderr: `OpenShell settings are invalid: ${(err as Error).message}\n` };
      }
      return execCapture(run, bin, args, { env: openShellChildEnv(env, process.env, settingsEnv), cwd: projectRoot });
    },
    async restartGroup(agentGroupId, message) {
      // The host owns the containers; this process does not. Ask it over the
      // ncl socket, as the host caller (filesystem access to data/ is the gate).
      try {
        const res = await new SocketTransport(path.join(projectRoot, 'data', 'ncl.sock')).sendFrame({
          id: `ui-restart-${randomUUID()}`,
          command: 'groups-restart',
          args: { id: agentGroupId, ...(message ? { message } : {}) },
        });
        return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
      } catch (err) {
        return { ok: false, error: { code: 'host-unreachable', message: (err as Error).message } };
      }
    },
    runCredentialScript(env) {
      return execCapture(run, process.execPath, credentialScriptArgs(tsxLoaderUrl(projectRoot), projectRoot), {
        env,
        cwd: projectRoot,
      });
    },
    checkCredentials() {
      // Imported lazily: verify.ts pulls in the whole setup surface.
      return checkCredentialsSync(projectRoot);
    },
    gatewayKind() {
      return (
        process.env.NANOCLAW_GATEWAY_PROVIDER?.trim() ||
        readEnvFile(['NANOCLAW_GATEWAY_PROVIDER'], projectRoot).NANOCLAW_GATEWAY_PROVIDER?.trim() ||
        ''
      ).toLowerCase();
    },
    async listGroups() {
      await ensureDb(projectRoot);
      const { getAllAgentGroups } = await import('../../../../src/db/agent-groups.js');
      return (await getAllAgentGroups()).map(({ id, name, folder }) => ({ id, name, folder }));
    },
    async groupSessions(agentGroupId) {
      await ensureDb(projectRoot);
      const { getSessionsByAgentGroup } = await import('../../../../src/db/sessions.js');
      return (await getSessionsByAgentGroup(agentGroupId)).map(({ id, status, container_status, created_at }) => ({
        id,
        status,
        container_status,
        created_at,
      }));
    },
    sandboxName(agentGroupId, sessionId) {
      return sandboxName({ installSlug: getInstallSlug(projectRoot), agentGroupId, sessionId });
    },
    policyFile: policyFilePath(openShellSettingsEnv()),
    activityLog: path.join(projectRoot, 'data', 'openshell-console', 'activity.jsonl'),
    staticDir: STATIC_DIR,
  };
}

let checkCredentialsImpl: ((root: string) => { credentials: string; credentialSource: string }) | undefined;
function checkCredentialsSync(root: string): { credentials: string; credentialSource: string } {
  if (!checkCredentialsImpl) throw new Error('checkCredentials not loaded; call preloadVerify() first');
  return checkCredentialsImpl(root);
}

/** The same read-back setup's verify uses (setup/openshell/verify.ts). */
export async function preloadVerify(): Promise<void> {
  const { openShellCredentials } = await import('../../../../setup/openshell/verify.js');
  checkCredentialsImpl = (root) =>
    openShellCredentials(root) ?? { credentials: 'missing', credentialSource: 'not-openshell:none' };
}
