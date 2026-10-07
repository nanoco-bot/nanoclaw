/**
 * Provider templates: OpenShell's shipped profile hints (PROVIDER_PROFILES,
 * unchanged) merged with the operator's custom ones (openshell_provider_profiles).
 */
import { describe, expect, it } from 'vitest';

import { missingDeclaredCredentials } from './commands.js';
import { PROVIDER_PROFILES, findProfile, isGenericType, mergeProfiles } from './profiles.js';

const custom = [
  {
    id: 'zeta-crm',
    label: 'Zeta CRM',
    type: 'zeta',
    credentialKeys: ['ZETA_KEY'],
    configKeys: ['region'],
    description: 'x',
  },
  { id: 'acme', label: 'ACME', type: 'acme', credentialKeys: [], configKeys: [] },
  { id: 'github', label: 'GitHub (our image)', type: 'github', credentialKeys: ['GH_TOKEN'], configKeys: [] },
];

describe('mergeProfiles', () => {
  it('shipped profiles first in their order, then custom-only ones alphabetically', () => {
    const merged = mergeProfiles(custom);
    expect(merged.slice(0, PROVIDER_PROFILES.length).map((p) => p.id)).toEqual(PROVIDER_PROFILES.map((p) => p.id));
    expect(merged.slice(PROVIDER_PROFILES.length).map((p) => p.id)).toEqual(['acme', 'zeta-crm']);
  });

  it('a custom profile with a shipped id replaces it (the operator’s definition is the more specific hint)', () => {
    const gh = mergeProfiles(custom).find((p) => p.id === 'github')!;
    expect(gh).toMatchObject({ source: 'custom', label: 'GitHub (our image)', credentialKeys: ['GH_TOKEN'] });
  });

  it('builtins keep their shape, typed by id; custom carry type, config keys, generic flag', () => {
    const merged = mergeProfiles(custom);
    expect(merged.find((p) => p.id === 'openai')).toEqual({
      id: 'openai',
      label: 'OpenAI',
      type: 'openai',
      credentialKeys: ['OPENAI_API_KEY'],
      configKeys: [],
      source: 'builtin',
      generic: false,
    });
    expect(merged.find((p) => p.id === 'zeta-crm')).toMatchObject({
      type: 'zeta',
      configKeys: ['region'],
      generic: false,
    });
    expect(merged.find((p) => p.id === 'acme')).toMatchObject({ generic: true });
  });

  it('no custom profiles: exactly the shipped list, which is unchanged', () => {
    expect(mergeProfiles([]).map((p) => p.id)).toEqual(PROVIDER_PROFILES.map((p) => p.id));
    expect(PROVIDER_PROFILES.find((p) => p.id === 'github')!.credentialKeys).toEqual(['GITHUB_TOKEN']);
  });

  it('lookups and the missing-credential hint follow the merged list (by --type)', () => {
    const merged = mergeProfiles(custom);
    expect(findProfile('zeta', merged)?.id).toBe('zeta-crm');
    expect(isGenericType('zeta', merged)).toBe(false);
    expect(isGenericType('zeta')).toBe(true); // unknown to the shipped list alone
    expect(missingDeclaredCredentials({ name: 'z', type: 'zeta' }, merged)).toEqual(['ZETA_KEY']);
  });
});
