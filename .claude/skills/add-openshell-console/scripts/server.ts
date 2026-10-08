/**
 * OpenShell console — entry point.
 *
 *   node --import <repo>/node_modules/tsx/dist/loader.mjs .claude/skills/add-openshell-console/scripts/server.ts
 *
 * Installed as a background service by `scripts/service.ts --enable`. Plain
 * node:http, same-origin JSON + one static page. Binds
 * NANOCLAW_OPENSHELL_UI_HOST (default 127.0.0.1) : NANOCLAW_OPENSHELL_UI_PORT
 * (default 8790), from the environment or `.env`. No login of its own: reach
 * it over an SSH tunnel, or through a password-gated proxy whose host name is
 * listed in NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS (requests for any other host
 * name are refused).
 */
import http from 'node:http';

import { readEnvFile } from '../../../../src/env.js';
import { PROJECT_ROOT, preloadVerify, realDeps } from './exec.js';
import { createHandler } from './routes.js';

export const DEFAULT_UI_PORT = 8790;

export function uiListenAddress(
  env: NodeJS.ProcessEnv = process.env,
  fromFile: Record<string, string> = readEnvFile(
    ['NANOCLAW_OPENSHELL_UI_PORT', 'NANOCLAW_OPENSHELL_UI_HOST', 'NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS'],
    PROJECT_ROOT,
  ),
): { host: string; port: number; allowedHosts: string[] } {
  const rawPort =
    env.NANOCLAW_OPENSHELL_UI_PORT?.trim() || fromFile.NANOCLAW_OPENSHELL_UI_PORT?.trim() || String(DEFAULT_UI_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`NANOCLAW_OPENSHELL_UI_PORT='${rawPort}' is not a TCP port`);
  const host = env.NANOCLAW_OPENSHELL_UI_HOST?.trim() || fromFile.NANOCLAW_OPENSHELL_UI_HOST?.trim() || '127.0.0.1';
  const allowedHosts = (env.NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS || fromFile.NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return { host, port, allowedHosts };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  // config.ts and .env resolution key off the working directory.
  process.chdir(PROJECT_ROOT);
  const { host, port, allowedHosts } = uiListenAddress();
  await preloadVerify();
  const server = http.createServer(createHandler({ ...realDeps(), allowedHosts }));
  server.on('error', (err) => {
    console.error(`OpenShell console could not listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`OpenShell console listening on http://${host}:${port}/ (project ${PROJECT_ROOT})`);
  });
}
