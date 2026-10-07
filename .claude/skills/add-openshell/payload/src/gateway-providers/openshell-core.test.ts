/**
 * Ported from the POC's demo gateway-core tests (nanoco-bot/poc-nvidia-openshell,
 * demo/nanoclaw/test/demo.test.ts), minus the demo-only CRM pieces.
 */
import { describe, expect, it } from 'vitest';

import { looksLikeCredential } from '../drivers/types.js';
import {
  DEFAULTS,
  contributionEnv,
  modelCredentialFromEnv,
  openShellGatewayConfig,
  relayHeaders,
} from './openshell-core.js';

describe('openshell gateway core', () => {
  it('contributes the OneCLI-style model env, acceptable to core', () => {
    const env = contributionEnv(openShellGatewayConfig({ NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '23456' }));
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: `http://${DEFAULTS.hostAlias}:23456`,
      ANTHROPIC_AUTH_TOKEN: 'gateway-managed',
    });
    // The contributed lane is exempt from the key-NAME check but never from the
    // credential-VALUE check: nothing here may look like a real credential.
    for (const value of Object.values(env)) expect(looksLikeCredential(value)).toBe(false);
  });

  it('honors alias / port / upstream overrides and refuses bad values', () => {
    const cfg = openShellGatewayConfig({
      NANOCLAW_OPENSHELL_HOST_ALIAS: 'gw',
      NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '9000',
      NANOCLAW_OPENSHELL_MODEL_UPSTREAM: 'https://models.example.invalid/ignored/path',
    });
    expect(cfg).toEqual({ hostAlias: 'gw', relayPort: 9000, modelUpstream: 'https://models.example.invalid' });
    expect(contributionEnv(cfg)).toMatchObject({ ANTHROPIC_BASE_URL: 'http://gw:9000' });
    expect(() => openShellGatewayConfig({ NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '99999' })).toThrow(
      /must be a TCP port/,
    );
    const port = { NANOCLAW_OPENSHELL_MODEL_RELAY_PORT: '23456' };
    expect(() => openShellGatewayConfig({ ...port, NANOCLAW_OPENSHELL_MODEL_UPSTREAM: 'ftp://x' })).toThrow(
      /must be http/,
    );
    expect(() => openShellGatewayConfig({ ...port, NANOCLAW_OPENSHELL_MODEL_UPSTREAM: 'not a url' })).toThrow(
      /is not a URL/,
    );
  });

  it('has no fixed relay port: an unset port is a configuration error, not a shared default', () => {
    expect(() => openShellGatewayConfig({})).toThrow(/NANOCLAW_OPENSHELL_MODEL_RELAY_PORT is not set/);
  });

  it('relay drops the agent-side placeholder auth and injects the host credential', () => {
    const incoming = {
      authorization: 'Bearer gateway-managed',
      'x-api-key': 'whatever-the-agent-sent',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      host: 'host.openshell.internal:18790',
      connection: 'keep-alive',
    };
    expect(relayHeaders(incoming, { kind: 'api-key', value: 'REAL' })).toEqual({
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'REAL',
    });
    const oauth = relayHeaders({ ...incoming, 'anthropic-beta': 'foo' }, { kind: 'oauth', value: 'TOK' });
    expect(oauth.authorization).toBe('Bearer TOK');
    expect(oauth['x-api-key']).toBeUndefined();
    expect(oauth['anthropic-beta']).toBe('foo,oauth-2025-04-20');
    const none = relayHeaders(incoming, { kind: 'none' });
    expect(none.authorization).toBeUndefined();
    expect(none['x-api-key']).toBeUndefined();
  });

  it('prefers an API key over an OAuth token; reports none when neither is set', () => {
    expect(modelCredentialFromEnv({ ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({
      kind: 'api-key',
      value: 'k',
    });
    expect(modelCredentialFromEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({ kind: 'oauth', value: 't' });
    expect(modelCredentialFromEnv({})).toEqual({ kind: 'none' });
  });
});
