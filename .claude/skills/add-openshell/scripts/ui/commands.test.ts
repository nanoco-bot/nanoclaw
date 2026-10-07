import { describe, expect, it } from 'vitest';

import {
  CREDENTIAL_INPUT_VARS,
  credentialScriptArgs,
  credentialScriptEnv,
  missingDeclaredCredentials,
  parseCredentialSource,
  parseRuleChunks,
  policyApproveFrame,
  policyListFrame,
  policyRejectFrame,
  policyViewFrame,
  providerCreateInvocation,
  providerGetArgs,
  providerListArgs,
} from './commands.js';
import { PROVIDER_PROFILES, isGenericType } from './profiles.js';

describe('openshell provider create argv', () => {
  it('builtin type: name, type, one --credential KEY per credential; values only in the child env', () => {
    const inv = providerCreateInvocation({
      name: 'anthropic-main',
      type: 'anthropic',
      credentials: [{ key: 'ANTHROPIC_API_KEY', value: 'sk-ant-api03-FAKE' }],
    });
    expect(inv.args).toEqual([
      'provider',
      'create',
      '--name',
      'anthropic-main',
      '--type',
      'anthropic',
      '--credential',
      'ANTHROPIC_API_KEY',
    ]);
    expect(inv.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-FAKE' });
    expect(inv.args.join(' ')).not.toContain('sk-ant');
  });

  it('generic type with a custom env name, repeated --credential and --config, and --global-profile', () => {
    const inv = providerCreateInvocation({
      name: 'internal-pkg',
      type: 'pypi',
      credentials: [
        { key: 'PIP_INDEX_TOKEN', value: 'tok-1' },
        { key: 'EXTRA_SECRET', value: 'tok=2' },
      ],
      config: [
        { key: 'index_url', value: 'https://pkgs.example.invalid/simple' },
        { key: 'region', value: 'eu' },
      ],
      globalProfile: true,
    });
    expect(inv.args).toEqual([
      'provider',
      'create',
      '--name',
      'internal-pkg',
      '--type',
      'pypi',
      '--credential',
      'PIP_INDEX_TOKEN',
      '--credential',
      'EXTRA_SECRET',
      '--config',
      'index_url=https://pkgs.example.invalid/simple',
      '--config',
      'region=eu',
      '--global-profile',
    ]);
    expect(inv.env).toEqual({ PIP_INDEX_TOKEN: 'tok-1', EXTRA_SECRET: 'tok=2' });
  });

  it('accepts an unknown/custom profile id (treated as generic) and no credentials at all', () => {
    expect(providerCreateInvocation({ name: 'x', type: 'my-imported-profile' }).args).toEqual([
      'provider',
      'create',
      '--name',
      'x',
      '--type',
      'my-imported-profile',
    ]);
  });

  it('refuses names, types and keys that could become flags or break the child', () => {
    expect(() => providerCreateInvocation({ name: '--global', type: 'openai' })).toThrow(/Provider name/);
    expect(() => providerCreateInvocation({ name: 'ok', type: '--from-existing' })).toThrow(/profile id/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', credentials: [{ key: 'OPENAI KEY', value: 'v' }] }),
    ).toThrow(/environment-variable name/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', credentials: [{ key: 'PATH', value: 'v' }] }),
    ).toThrow(/reserved/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', credentials: [{ key: 'OPENSHELL_GATEWAY', value: 'v' }] }),
    ).toThrow(/reserved/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', credentials: [{ key: 'A', value: '' }] }),
    ).toThrow(/needs a value/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', credentials: [{ key: 'A', value: 'x\ny' }] }),
    ).toThrow(/newlines/);
    expect(() =>
      providerCreateInvocation({
        name: 'ok',
        type: 'openai',
        credentials: [
          { key: 'A', value: '1' },
          { key: 'A', value: '2' },
        ],
      }),
    ).toThrow(/twice/);
    expect(() =>
      providerCreateInvocation({ name: 'ok', type: 'openai', config: [{ key: 'a=b', value: 'v' }] }),
    ).toThrow(/Config key/);
  });

  it('get/list argv, and which declared credentials were left out', () => {
    expect(providerGetArgs('anthropic-main')).toEqual(['provider', 'get', 'anthropic-main']);
    expect(() => providerGetArgs('-x')).toThrow();
    expect(providerListArgs()).toEqual(['provider', 'list']);
    expect(
      missingDeclaredCredentials({ name: 'a', type: 'aws', credentials: [{ key: 'AWS_ACCESS_KEY_ID', value: 'v' }] }),
    ).toEqual(['AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']);
  });

  it('profile table: the builtin list from the brief, generic = no declared credential keys', () => {
    expect(PROVIDER_PROFILES.map((p) => p.id)).toEqual([
      'anthropic',
      'aws',
      'aws-bedrock',
      'aws-s3',
      'claude-code',
      'codex',
      'copilot',
      'cursor',
      'deepinfra',
      'github',
      'google-cloud',
      'google-vertex-ai',
      'nvidia',
      'oci-genai',
      'openai',
      'openrouter',
      'pypi',
    ]);
    expect(PROVIDER_PROFILES.filter((p) => isGenericType(p.id)).map((p) => p.id)).toEqual(['cursor', 'pypi']);
    expect(isGenericType('something-imported')).toBe(true);
  });
});

describe('credential script wiring (scripts/auth.ts)', () => {
  it('clears every input variable auth.ts reads, then sets exactly one NANOCLAW_-prefixed variable', () => {
    const inherited = {
      PATH: '/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-INHERITED',
      ANTHROPIC_API_KEY: 'sk-ant-api03-INHERITED',
      NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN: 'x',
      NANOCLAW_ANTHROPIC_API_KEY: 'y',
    };
    const api = credentialScriptEnv({ kind: 'api-key', value: ' sk-ant-api03-NEW ' }, inherited);
    expect(api.PATH).toBe('/bin');
    expect(Object.fromEntries(CREDENTIAL_INPUT_VARS.map((k) => [k, api[k]]))).toEqual({
      NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      NANOCLAW_ANTHROPIC_API_KEY: 'sk-ant-api03-NEW',
      ANTHROPIC_API_KEY: undefined,
    });
    const oauth = credentialScriptEnv({ kind: 'oauth', value: 'sk-ant-oat01-NEW' }, inherited);
    expect(oauth.NANOCLAW_CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-NEW');
    expect(oauth.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(oauth.NANOCLAW_ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('applies auth.ts’s own prefix rule and the drop-in charset rule', () => {
    expect(() => credentialScriptEnv({ kind: 'oauth', value: 'sk-ant-api03-x' }, {})).toThrow(
      /Must start with sk-ant-oat/,
    );
    expect(() => credentialScriptEnv({ kind: 'api-key', value: 'nope' }, {})).toThrow(/Must start with sk-ant-api/);
    expect(() => credentialScriptEnv({ kind: 'api-key', value: 'sk-ant-api"x' }, {})).toThrow(/characters/);
    expect(() => credentialScriptEnv({ kind: 'bogus' as never, value: 'x' }, {})).toThrow(/kind/);
  });

  it('runs auth.ts claude under node with the tsx loader', () => {
    expect(
      credentialScriptArgs(
        'file:///r/node_modules/tsx/dist/loader.mjs',
        '/r/.claude/skills/add-openshell/scripts/auth.ts',
      ),
    ).toEqual([
      '--import',
      'file:///r/node_modules/tsx/dist/loader.mjs',
      '/r/.claude/skills/add-openshell/scripts/auth.ts',
      'claude',
    ]);
  });

  it('reads checkCredentials()’s credentialSource back into source + kind', () => {
    expect(parseCredentialSource('running-service:api-key')).toEqual({ source: 'running-service', kind: 'api-key' });
    expect(parseCredentialSource('unit-environment:oauth')).toEqual({ source: 'unit-environment', kind: 'oauth' });
    expect(parseCredentialSource('')).toEqual({ source: 'unknown', kind: 'unknown' });
  });
});

describe('ncl openshell-policy frames (passthrough)', () => {
  it('list / approve / reject / view map to the existing resource’s commands and flags', () => {
    expect(policyListFrame('ncl-abc')).toEqual({
      command: 'openshell-policy-list',
      args: { sandbox: 'ncl-abc', status: 'pending' },
    });
    expect(policyListFrame(' ncl-abc ', 'rejected')).toEqual({
      command: 'openshell-policy-list',
      args: { sandbox: 'ncl-abc', status: 'rejected' },
    });
    expect(policyApproveFrame('ncl-abc', 'c1')).toEqual({
      command: 'openshell-policy-approve',
      args: { sandbox: 'ncl-abc', chunk_id: 'c1' },
    });
    expect(policyRejectFrame('ncl-abc', 'c2', 'too broad')).toEqual({
      command: 'openshell-policy-reject',
      args: { sandbox: 'ncl-abc', chunk_id: 'c2', reason: 'too broad' },
    });
    expect(policyViewFrame('ncl-abc')).toEqual({
      command: 'openshell-policy-view',
      args: { sandbox: 'ncl-abc', output: 'json' },
    });
  });

  it('requires a sandbox, a chunk id, a reason to reject, and a known status', () => {
    expect(() => policyListFrame('')).toThrow(/sandbox/);
    expect(() => policyListFrame('s', 'all')).toThrow(/status/);
    expect(() => policyApproveFrame('s', '')).toThrow(/chunk/);
    expect(() => policyRejectFrame('s', 'c', ' ')).toThrow(/reason/);
  });
});

describe('parseRuleChunks (openshell rule get text)', () => {
  it('reads the v0.1.2 layout, ignoring colour codes and the header', () => {
    const text = [
      '\x1b[36;1mNetwork Rules:\x1b[0m  (version 3, 2 chunks)',
      '',
      '  \x1b[2mChunk:\x1b[0m ck-1',
      '  \x1b[2mStatus:\x1b[0m \x1b[33mpending\x1b[0m',
      '  \x1b[2mRule:\x1b[0m allow_pypi',
      '  \x1b[2mBinary:\x1b[0m /usr/bin/python3',
      '  \x1b[2mConfidence:\x1b[0m 87%',
      '  \x1b[2mRationale:\x1b[0m pip install needs pypi.org:443',
      '',
      '  Chunk: ck-2',
      '  Status: pending',
      '  Rule: allow_github',
      '  Rationale: git clone',
      '  Security: broad host',
    ].join('\n');
    expect(parseRuleChunks(text)).toEqual([
      {
        chunkId: 'ck-1',
        status: 'pending',
        rule: 'allow_pypi',
        binary: '/usr/bin/python3',
        confidence: '87%',
        rationale: 'pip install needs pypi.org:443',
      },
      { chunkId: 'ck-2', status: 'pending', rule: 'allow_github', rationale: 'git clone', security: 'broad host' },
    ]);
  });

  it('an empty listing parses to nothing', () => {
    expect(parseRuleChunks("No network rules for sandbox 'ncl-abc'\n")).toEqual([]);
    expect(parseRuleChunks('')).toEqual([]);
  });
});
