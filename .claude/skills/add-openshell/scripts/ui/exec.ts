/**
 * The real side effects behind the UI (routes.ts takes them as `UiDeps`).
 *
 *  - `openshell`: the binary and gateway selection this install is configured
 *    with (src/drivers/openshell/config.ts — the same settings the session
 *    driver and `ncl openshell-policy` use), run with the same environment
 *    realOpenShellCli() sets (OPENSHELL_COLOR=never, NO_COLOR=1). Unlike
 *    realOpenShellCli this keeps stderr on success too: the UI shows both.
 *  - `ncl openshell-policy-*`: dispatched IN-PROCESS through the CLI's own
 *    dispatcher as the host caller — exactly what the repo's CLI tests do. No
 *    `ncl`/pnpm subprocess (and so no stray-`--` argv problem), and no need
 *    for the host to be running: with --sandbox these commands touch no DB.
 *  - credential: the skill's `scripts/auth.ts claude`, as a child `node`
 *    process with tsx's loader (no pnpm on the service PATH required).
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { openShellGatewayEnv, openShellSettingsEnv } from '../../../../../src/drivers/openshell/config.js';
import { settingsFromEnv } from '../../../../../src/drivers/openshell/settings.js';
import { readEnvFile } from '../../../../../src/env.js';
import { credentialScriptArgs, type PolicyFrame } from './commands.js';
import type { DispatchResult, ExecResult, UiDeps } from './routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, '..', '..');
export const PROJECT_ROOT = path.resolve(SKILL_DIR, '..', '..', '..');
export const AUTH_SCRIPT = path.join(SKILL_DIR, 'scripts', 'auth.ts');
export const STATIC_DIR = path.join(HERE, 'public');

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

let policyDispatch: ((frame: PolicyFrame) => Promise<DispatchResult>) | undefined;

async function loadPolicyDispatch(): Promise<(frame: PolicyFrame) => Promise<DispatchResult>> {
  if (!policyDispatch) {
    // Registers only the openshell-policy-* commands; dispatch() applies the
    // same guard / arg validation `ncl` gets over the socket.
    await import('../../../../../src/cli/resources/openshell-policy.js');
    const { dispatch } = await import('../../../../../src/cli/dispatch.js');
    policyDispatch = async (frame) => {
      const res = await dispatch({ id: randomUUID(), command: frame.command, args: frame.args }, { caller: 'host' });
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    };
  }
  return policyDispatch;
}

let nclDispatch: ((frame: PolicyFrame) => Promise<DispatchResult>) | undefined;

/**
 * Commands that read or write the central DB (custom provider profiles,
 * per-group providers / network paths). Opens `data/v2.db` once as a `tool`
 * client — the same SQLite file the host has open (WAL; better-sqlite3 waits
 * out a busy lock). The host owns migrations: before it has run the ones these
 * tables need, the commands fail and the UI shows why.
 */
async function loadNclDispatch(projectRoot: string): Promise<(frame: PolicyFrame) => Promise<DispatchResult>> {
  if (!nclDispatch) {
    const { initDb } = await import('../../../../../src/db/connection.js');
    await initDb(path.join(projectRoot, 'data', 'v2.db'), { role: 'tool' });
    await import('../../../../../src/cli/resources/openshell-provider-profile.js');
    const { dispatch } = await import('../../../../../src/cli/dispatch.js');
    nclDispatch = async (frame) => {
      const res = await dispatch({ id: randomUUID(), command: frame.command, args: frame.args }, { caller: 'host' });
      return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error };
    };
  }
  return nclDispatch;
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
    async dispatchPolicy(frame) {
      return (await loadPolicyDispatch())(frame);
    },
    async dispatchNcl(frame) {
      try {
        return (await loadNclDispatch(projectRoot))(frame);
      } catch (err) {
        return { ok: false, error: { code: 'unavailable', message: (err as Error).message } };
      }
    },
    runCredentialScript(env) {
      return execCapture(run, process.execPath, credentialScriptArgs(tsxLoaderUrl(projectRoot), AUTH_SCRIPT), {
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
    decisionLog: path.join(projectRoot, 'data', 'openshell-setup-ui', 'decisions.jsonl'),
    staticDir: STATIC_DIR,
  };
}

let checkCredentialsImpl: ((root: string) => { credentials: string; credentialSource: string }) | undefined;
function checkCredentialsSync(root: string): { credentials: string; credentialSource: string } {
  if (!checkCredentialsImpl) throw new Error('checkCredentials not loaded; call preloadVerify() first');
  return checkCredentialsImpl(root);
}

/** setup/verify.ts's checkCredentials — the same read-back verify uses. */
export async function preloadVerify(): Promise<void> {
  const { checkCredentials } = await import('../../../../../setup/verify.js');
  checkCredentialsImpl = (root) => checkCredentials(root);
}
