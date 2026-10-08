import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import {
  MODEL_BINARIES,
  MODEL_CREDENTIAL_ENV,
  MODEL_HOST,
  MODEL_PROFILE_ID,
  modelProfileYaml,
  modelProviderName,
} from './model-provider.js';

/** OpenShell binary globs: `*` matches exactly one path component. */
function globMatches(glob: string, path: string): boolean {
  const g = glob.split('/');
  const p = path.split('/');
  return g.length === p.length && g.every((part, i) => part === '*' || part === p[i]);
}

describe('model provider', () => {
  it('names one provider per install', () => {
    expect(modelProviderName('37e6d0ec')).toBe('nanoclaw-37e6d0ec-claude');
    expect(() => modelProviderName('bad slug')).toThrow();
  });

  it.each(['oauth', 'api-key'] as const)('the %s profile is valid YAML for the model API', (kind) => {
    const doc = parseYaml(modelProfileYaml(kind));
    expect(doc.id).toBe(MODEL_PROFILE_ID[kind]);
    expect(doc.credentials[0].env_vars).toEqual([MODEL_CREDENTIAL_ENV[kind]]);
    expect(doc.credentials[0].auth_style).toBe(kind === 'oauth' ? 'bearer' : 'header');
    expect(doc.credentials[0].header_name).toBe(kind === 'oauth' ? 'authorization' : 'x-api-key');
    expect(doc.endpoints).toEqual([
      { host: MODEL_HOST, port: 443, protocol: 'rest', access: 'full', enforcement: 'enforce' },
    ]);
    expect(doc.binaries).toEqual([...MODEL_BINARIES]);
  });

  it("Claude Code's versioned binary path is matched by the glob (as installed in the agent image)", () => {
    const real =
      '/pnpm/global/5/.pnpm/@anthropic-ai+claude-code@2.1.280/node_modules/@anthropic-ai/claude-code/bin/claude.exe';
    expect(globMatches(MODEL_BINARIES[0], real)).toBe(true);
    expect(globMatches(MODEL_BINARIES[0], '/pnpm/global/5/.pnpm/evil/node_modules/x/bin/claude.exe')).toBe(false);
  });
});
