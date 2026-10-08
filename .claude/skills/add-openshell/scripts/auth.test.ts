/**
 * The OpenShell gateway's sign-in step: it collects the Claude credential and
 * hands it to OpenShell (credential-store.ts, mocked here); it writes no file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  stored: null as 'oauth' | 'api-key' | null,
  saved: [] as { kind: string; value: string }[],
}));
vi.mock('./credential-store.js', () => ({
  storedModelCredentialKind: async () => store.stored,
  storeModelCredential: async (cred: { kind: string; value: string }) => {
    store.saved.push(cred);
    return store.stored ? 'updated' : 'created';
  },
}));
vi.mock('@clack/prompts', () => ({ log: { success: vi.fn(), warn: vi.fn() }, isCancel: () => false }));

import { run, suppliedCredential } from './auth.js';

const SUPPLY_KEYS = [
  'NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'NANOCLAW_ANTHROPIC_API_KEY',
  'ANTHROPIC_API_KEY',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  store.stored = null;
  store.saved = [];
  for (const key of SUPPLY_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SUPPLY_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('suppliedCredential', () => {
  it('reads an OAuth token or an API key; an OAuth token in the key variable stays OAuth', () => {
    expect(suppliedCredential({ CLAUDE_CODE_OAUTH_TOKEN: ' sk-ant-oat01-x ' })).toEqual({
      kind: 'oauth',
      value: 'sk-ant-oat01-x',
    });
    expect(suppliedCredential({ NANOCLAW_ANTHROPIC_API_KEY: 'sk-ant-api03-y' })).toEqual({
      kind: 'api-key',
      value: 'sk-ant-api03-y',
    });
    expect(suppliedCredential({ ANTHROPIC_API_KEY: 'sk-ant-oat01-z' })).toEqual({
      kind: 'oauth',
      value: 'sk-ant-oat01-z',
    });
    expect(suppliedCredential({})).toBeUndefined();
  });
});

describe('OpenShell gateway sign-in', () => {
  it('stores a supplied credential in OpenShell', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-test';
    await run('claude');
    expect(store.saved).toEqual([{ kind: 'api-key', value: 'sk-ant-api03-test' }]);
  });

  it('a supplied credential replaces a stored one (rotation)', async () => {
    store.stored = 'oauth';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-new';
    await run('claude');
    expect(store.saved).toEqual([{ kind: 'oauth', value: 'sk-ant-oat01-new' }]);
  });

  it('keeps a stored credential when nothing new is supplied', async () => {
    store.stored = 'oauth';
    await run('claude');
    expect(store.saved).toEqual([]);
  });

  it('non-interactive with nothing supplied or stored fails loudly', async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      await expect(run('claude')).rejects.toThrow(/No Claude credential for the OpenShell gateway/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('refuses other agent providers', async () => {
    await expect(run('codex')).rejects.toThrow(/Claude agent provider only/);
  });
});
