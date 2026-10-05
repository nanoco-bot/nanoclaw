/**
 * Agent-provider authentication for the OpenShell gateway.
 *
 * The gateway has no vault: its model relay reads ANTHROPIC_API_KEY or
 * CLAUDE_CODE_OAUTH_TOKEN from the NanoClaw host SERVICE environment at
 * request time. This step collects the Claude credential the same ways the
 * other gateway skills do — supplied non-interactively
 * (NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN /
 * NANOCLAW_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY), a legacy value found in
 * `.env` (moved out of it), a Claude subscription sign-in, or a pasted token
 * or key — and writes it to this install's 0600 systemd drop-in
 * (`<unit>.service.d/credential.conf`). Never to `.env`, never to an agent.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '@clack/prompts';

import {
  CREDENTIAL_ENV,
  inspectServiceCredential,
  suppliedCredential,
  unitLocation,
  writeCredentialDropIn,
  type ModelCredential,
  type UnitLocation,
} from '../../../../setup/lib/openshell-credential.js';
import { getServiceManager } from '../../../../setup/platform.js';

type Method = 'subscription' | 'oauth' | 'api' | 'skip';

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Authentication cancelled');
  return value as T;
}

/** A credential an older setup left in `.env`: used once, then removed from the file. */
export function takeLegacyEnvCredential(root = process.cwd()): ModelCredential | undefined {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return undefined;
  const current = fs.readFileSync(file, 'utf8');
  const keys = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  const found = keys.flatMap((key) => {
    const value = current
      .match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, '$2');
    return value ? [{ key, value }] : [];
  });
  if (found.length === 0) return undefined;
  if (found.length > 1)
    throw new Error('Both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are in .env; keep one and retry');
  const { key, value } = found[0];
  fs.writeFileSync(
    file,
    current
      .split('\n')
      .filter((line) => !line.startsWith(`${key}=`))
      .join('\n'),
    { mode: 0o600 },
  );
  return { kind: key === 'ANTHROPIC_API_KEY' && !value.startsWith('sk-ant-oat') ? 'api-key' : 'oauth', value };
}

function capturedSubscriptionToken(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-openshell-auth-'));
  const output = path.join(dir, 'token');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture-claude-token.sh');
  try {
    const result = spawnSync('bash', [script, output], { stdio: 'inherit' });
    if (result.status !== 0 || !fs.existsSync(output)) throw new Error('Claude subscription sign-in failed');
    const token = fs.readFileSync(output, 'utf8').trim();
    if (!token.startsWith('sk-ant-oat')) throw new Error('Claude subscription sign-in returned an invalid token');
    return token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function promptCredential(): Promise<ModelCredential | undefined> {
  const method = answer<Method>(
    await p.select({
      message: 'How should the OpenShell gateway connect to Claude?',
      options: [
        { value: 'subscription', label: 'Claude subscription', hint: 'recommended for Pro or Max' },
        { value: 'oauth', label: 'Paste an OAuth token' },
        { value: 'api', label: 'Paste an Anthropic API key' },
        { value: 'skip', label: 'Skip for now' },
      ],
    }),
  );
  if (method === 'skip') return undefined;
  if (method === 'subscription') return { kind: 'oauth', value: capturedSubscriptionToken() };
  const prefix = method === 'oauth' ? 'sk-ant-oat' : 'sk-ant-api';
  const token = answer<string>(
    await p.password({
      message: method === 'oauth' ? 'Paste your OAuth token' : 'Paste your API key',
      clearOnError: true,
      validate: (raw) => {
        const value = (raw ?? '').replace(/\s+/g, '');
        if (!value) return 'Required';
        if (!value.startsWith(prefix)) return `Must start with ${prefix}`;
        return undefined;
      },
    }),
  ).replace(/\s+/g, '');
  return { kind: method === 'oauth' ? 'oauth' : 'api-key', value: token };
}

/** Make systemd see the new drop-in; restart a running service so its relay does too. */
function applyToService(loc: UnitLocation): string {
  const [cmd, ...prefix] = loc.systemctl;
  try {
    execFileSync(cmd, [...prefix, 'daemon-reload'], { stdio: 'ignore' });
  } catch {
    return 'systemd was not reachable; the service picks the credential up when it is installed.';
  }
  try {
    execFileSync(cmd, [...prefix, 'try-restart', loc.unit], { stdio: 'ignore' });
    return 'If the service was running it has been restarted with the credential.';
  } catch {
    return `Restart it to apply: ${loc.systemctl.join(' ')} restart ${loc.unit}`;
  }
}

export async function run(agentProvider = process.argv[2] || 'claude', root = process.cwd()): Promise<void> {
  if (agentProvider !== 'claude') {
    throw new Error(
      `The OpenShell gateway relays Anthropic model credentials only; provider '${agentProvider}' is not supported with it.`,
    );
  }
  if (getServiceManager() !== 'systemd') {
    throw new Error(
      'The OpenShell gateway installs its model credential as a systemd drop-in; this host has no systemd service manager. ' +
        'This version supports OpenShell on Linux with systemd only.',
    );
  }
  const loc = unitLocation(root);
  const fresh = suppliedCredential() ?? takeLegacyEnvCredential(root);
  if (!fresh) {
    const existing = inspectServiceCredential(loc);
    if (existing.kind !== 'none') {
      p.log.success(
        `Claude credential already configured for the OpenShell relay (${existing.kind}, ${existing.source}).`,
      );
      return;
    }
  }
  const cred = fresh ?? (process.stdin.isTTY ? await promptCredential() : undefined);
  if (!cred) {
    throw new Error(
      'No Claude credential for the OpenShell gateway. Supply one with CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY ' +
        '(or NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN / NANOCLAW_ANTHROPIC_API_KEY) and re-run, or run setup interactively. ' +
        'Agents cannot reach the model until it is set.',
    );
  }
  writeCredentialDropIn(loc, cred);
  const note = applyToService(loc);
  p.log.success(
    `Claude credential (${CREDENTIAL_ENV[cred.kind]}) stored for the OpenShell relay in ${loc.dropInPath} (0600). ${note}`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
