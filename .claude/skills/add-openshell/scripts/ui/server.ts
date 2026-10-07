/**
 * OpenShell setup UI — entry point.
 *
 *   node --import <repo>/node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell/scripts/ui/server.ts
 *
 * Installed as a systemd unit by `pnpm exec tsx setup/index.ts --step openshell-ui`.
 * Plain node:http, same-origin JSON + one static page. Binds
 * NANOCLAW_OPENSHELL_UI_HOST (default 0.0.0.0) : NANOCLAW_OPENSHELL_UI_PORT
 * (default 8790), from the environment or `.env`. No app-level auth: put it
 * behind the password-gated reverse proxy and keep the port firewalled from
 * everything else.
 */
import http from 'node:http';

import { readEnvFile } from '../../../../../src/env.js';
import { PROJECT_ROOT, preloadVerify, realDeps } from './exec.js';
import { createHandler } from './routes.js';

export const DEFAULT_UI_PORT = 8790;

export function uiListenAddress(
  env: NodeJS.ProcessEnv = process.env,
  fromFile: Record<string, string> = readEnvFile(
    ['NANOCLAW_OPENSHELL_UI_PORT', 'NANOCLAW_OPENSHELL_UI_HOST'],
    PROJECT_ROOT,
  ),
): { host: string; port: number } {
  const rawPort =
    env.NANOCLAW_OPENSHELL_UI_PORT?.trim() || fromFile.NANOCLAW_OPENSHELL_UI_PORT?.trim() || String(DEFAULT_UI_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`NANOCLAW_OPENSHELL_UI_PORT='${rawPort}' is not a TCP port`);
  const host = env.NANOCLAW_OPENSHELL_UI_HOST?.trim() || fromFile.NANOCLAW_OPENSHELL_UI_HOST?.trim() || '0.0.0.0';
  return { host, port };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // config.ts and .env resolution key off the working directory.
  process.chdir(PROJECT_ROOT);
  const { host, port } = uiListenAddress();
  await preloadVerify();
  const server = http.createServer(createHandler(realDeps()));
  server.on('error', (err) => {
    console.error(`OpenShell setup UI could not listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`OpenShell setup UI listening on http://${host}:${port}/ (project ${PROJECT_ROOT})`);
  });
}
