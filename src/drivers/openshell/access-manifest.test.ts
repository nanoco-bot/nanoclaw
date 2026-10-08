/**
 * The access manifest the agent reads from NANOCLAW_OPENSHELL_ACCESS: services
 * from the group's providers (key variable, API host, header, access,
 * programs, read from each provider's service type) and plain hosts from its
 * network rules — names and hosts only, built best-effort.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildAccessManifest, renderAccessManifest, serviceFromProfile } from './access-manifest.js';
import type { OpenShellCli } from './cli.js';

const GRANOLA_PROFILE = `
id: granola
display_name: Granola
credentials:
  - name: api_key
    env_vars: [GRANOLA_API_KEY]
    auth_style: bearer
    header_name: authorization
endpoints:
  - host: public-api.granola.ai
    port: 443
    protocol: rest
    access: read-only
binaries: [/usr/bin/curl, /usr/local/bin/node]
`;

function cli(responses: Record<string, string | Error>): OpenShellCli & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    bin: 'openshell',
    calls,
    run: vi.fn(async (args: string[]) => {
      calls.push(args);
      const r = responses[args.join(' ')];
      if (r === undefined || r instanceof Error) throw r ?? new Error(`unexpected: ${args.join(' ')}`);
      return r;
    }),
  };
}

const LIST = JSON.stringify({
  providers: [
    { name: 'granola-alice', type: 'granola', credential_keys: ['GRANOLA_API_KEY'] },
    { name: 'nanoclaw-x-claude', type: 'nanoclaw-claude-oauth', credential_keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
  ],
});

describe('buildAccessManifest', () => {
  it("describes the group's providers from their service types, and its network rules as hosts", async () => {
    const c = cli({ 'provider list -o json': LIST, 'provider profile export granola': GRANOLA_PROFILE });
    const m = await buildAccessManifest(
      {
        providers: ['granola-alice'],
        egress: [{ name: 'hn', host: 'news.ycombinator.com', ports: [443], binaries: ['/usr/bin/curl'] }],
      },
      c,
    );
    expect(m).toEqual({
      services: [
        {
          provider: 'granola-alice',
          service: 'Granola',
          env: ['GRANOLA_API_KEY'],
          header: 'Authorization: Bearer $GRANOLA_API_KEY',
          endpoints: ['public-api.granola.ai:443'],
          access: 'read-only',
          programs: ['/usr/bin/curl', '/usr/local/bin/node'],
        },
      ],
      hosts: [{ host: 'news.ycombinator.com', ports: [443], programs: ['/usr/bin/curl'] }],
    });
    // Only the types it needs; the model provider's profile is never read.
    expect(c.calls).toEqual([
      ['provider', 'list', '-o', 'json'],
      ['provider', 'profile', 'export', 'granola'],
    ]);
  });

  it('no providers: no CLI call at all', async () => {
    const c = cli({});
    const m = await buildAccessManifest({ egress: [] }, c);
    expect(m).toEqual({ services: [], hosts: [] });
    expect(c.calls).toEqual([]);
  });

  it('a failed lookup lists the provider by name instead of failing', async () => {
    const c = cli({ 'provider list -o json': new Error('gateway down') });
    const m = await buildAccessManifest({ providers: ['granola-alice'] }, c);
    expect(m.services).toEqual([{ provider: 'granola-alice', env: [], endpoints: [], programs: [] }]);
  });

  it('carries names and hosts only: no credential value can appear', async () => {
    const c = cli({ 'provider list -o json': LIST, 'provider profile export granola': GRANOLA_PROFILE });
    const out = renderAccessManifest(await buildAccessManifest({ providers: ['granola-alice'] }, c));
    expect(out).not.toMatch(/openshell:resolve|sk-ant/);
    expect(JSON.parse(out).services[0].env).toEqual(['GRANOLA_API_KEY']);
  });
});

describe('serviceFromProfile', () => {
  it('a custom header style is shown as that header', () => {
    const s = serviceFromProfile('x', {
      credentials: [{ env_vars: ['X_KEY'], auth_style: 'header', header_name: 'x-api-key' }],
      endpoints: [{ host: 'api.x.com' }],
    });
    expect(s.header).toBe('x-api-key: $X_KEY');
    expect(s.endpoints).toEqual(['api.x.com:443']);
  });
});
