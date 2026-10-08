/**
 * Agent-provider sign-in for the OpenShell gateway.
 *
 * Collects the Claude credential — supplied in the environment
 * (NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN /
 * NANOCLAW_ANTHROPIC_API_KEY / ANTHROPIC_API_KEY), a Claude subscription
 * sign-in, or a pasted token or key — and stores it in OpenShell as this
 * install's Claude provider (credential-store.ts). NanoClaw keeps no copy.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as p from '@clack/prompts';

import { storeModelCredential, storedModelCredentialKind, type ModelCredential } from './credential-store.js';

type Method = 'subscription' | 'oauth' | 'api' | 'skip';

const OAUTH_PREFIX = 'sk-ant-oat';
const API_KEY_PREFIX = 'sk-ant-api';

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) throw new Error('Authentication cancelled');
  return value as T;
}

/** A credential supplied in the environment (non-interactive setup), if any. */
export function suppliedCredential(env: NodeJS.ProcessEnv = process.env): ModelCredential | undefined {
  const token = (env.NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN)?.trim();
  if (token) return { kind: 'oauth', value: token };
  const key = (env.NANOCLAW_ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY)?.trim();
  if (!key) return undefined;
  return { kind: key.startsWith(OAUTH_PREFIX) ? 'oauth' : 'api-key', value: key };
}

function capturedSubscriptionToken(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-openshell-auth-'));
  const output = path.join(dir, 'token');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'capture-claude-token.sh');
  try {
    const result = spawnSync('bash', [script, output], { stdio: 'inherit' });
    if (result.status !== 0 || !fs.existsSync(output)) throw new Error('Claude subscription sign-in failed');
    const token = fs.readFileSync(output, 'utf8').trim();
    if (!token.startsWith(OAUTH_PREFIX)) throw new Error('Claude subscription sign-in returned an invalid token');
    return token;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function promptCredential(): Promise<ModelCredential | undefined> {
  const method = answer<Method>(
    await p.select({
      message: 'How should your agents connect to Claude?',
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
  const prefix = method === 'oauth' ? OAUTH_PREFIX : API_KEY_PREFIX;
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

export async function run(agentProvider = process.argv[2] || 'claude', root = process.cwd()): Promise<void> {
  if (agentProvider !== 'claude') {
    throw new Error(`The OpenShell gateway supports the Claude agent provider only, not '${agentProvider}'.`);
  }
  const supplied = suppliedCredential();
  if (!supplied) {
    const existing = await storedModelCredentialKind(root);
    if (existing) {
      p.log.success(`Claude credential already stored in OpenShell (${existing}).`);
      return;
    }
  }
  const cred = supplied ?? (process.stdin.isTTY ? await promptCredential() : undefined);
  if (!cred) {
    throw new Error(
      'No Claude credential for the OpenShell gateway. Supply one with CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY ' +
        '(or NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN / NANOCLAW_ANTHROPIC_API_KEY) and re-run, or run setup interactively. ' +
        'Agents cannot reach the model until it is set.',
    );
  }
  const outcome = await storeModelCredential(cred, root);
  p.log.success(
    outcome === 'replaced'
      ? `Claude credential stored in OpenShell (${cred.kind}, replacing the previous kind); new sandboxes use it.`
      : `Claude credential ${outcome === 'updated' ? 'updated' : 'stored'} in OpenShell (${cred.kind}).`,
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  void run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
