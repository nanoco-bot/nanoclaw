/**
 * openshell_group_providers / openshell_group_egress (migration 026): CRUD,
 * cascade with the agent group, and the credential invariant — no credential
 * value is ever written, only key names and an HMAC.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup, deleteAgentGroup } from './agent-groups.js';
import { closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  attachGroupProvider,
  credentialValueHash,
  detachGroupProvider,
  listGroupEgressRules,
  listGroupProviders,
  putGroupEgressRule,
  removeGroupEgressRule,
} from './openshell-group-resources.js';

const SECRET = 'ghp_FIXTUREfixtureFIXTUREfixture0123';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const [id, folder] of [
    ['ag-1', 'alice'],
    ['ag-2', 'bob'],
  ])
    await createAgentGroup({ id, name: folder, folder, agent_provider: null, created_at: '2026-10-01T00:00:00.000Z' });
});
afterEach(async () => {
  await closeDb();
});

describe('openshell_group_providers', () => {
  it('attach / list / re-attach (upsert) / detach, per group', async () => {
    await attachGroupProvider({
      agentGroupId: 'ag-1',
      name: 'github-alice',
      type: 'github',
      credentials: { GITHUB_TOKEN: SECRET },
    });
    await attachGroupProvider({ agentGroupId: 'ag-1', name: 'anthropic-shared' });
    await attachGroupProvider({ agentGroupId: 'ag-2', name: 'anthropic-shared' });

    const alice = await listGroupProviders('ag-1');
    expect(alice.map((p) => p.name)).toEqual(['anthropic-shared', 'github-alice']);
    expect(alice[1]).toMatchObject({
      type: 'github',
      credentialKeys: ['GITHUB_TOKEN'],
      credentialHashes: { GITHUB_TOKEN: credentialValueHash(SECRET) },
    });
    expect(alice[0]).toMatchObject({ type: null, credentialKeys: [], credentialHashes: {} });

    // Re-attach replaces in place (rotated key → new hash), no duplicate row.
    await attachGroupProvider({
      agentGroupId: 'ag-1',
      name: 'github-alice',
      type: 'github',
      credentials: { GITHUB_TOKEN: 'ghp_ROTATED_fixture_0000000000000' },
    });
    const again = await listGroupProviders('ag-1');
    expect(again).toHaveLength(2);
    expect(again[1].credentialHashes.GITHUB_TOKEN).not.toBe(credentialValueHash(SECRET));

    expect(await detachGroupProvider('ag-1', 'github-alice')).toBe(true);
    expect(await detachGroupProvider('ag-1', 'github-alice')).toBe(false);
    expect((await listGroupProviders('ag-1')).map((p) => p.name)).toEqual(['anthropic-shared']);
    expect((await listGroupProviders('ag-2')).map((p) => p.name)).toEqual(['anthropic-shared']);
  });

  it('never stores a credential value — every column of every row is free of it', async () => {
    await attachGroupProvider({
      agentGroupId: 'ag-1',
      name: 'github-alice',
      type: 'github',
      credentials: { GITHUB_TOKEN: SECRET },
    });
    const rows = await getDb().all<Record<string, unknown>>('SELECT * FROM openshell_group_providers');
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).toContain('GITHUB_TOKEN');
  });

  it('rows go with the agent group', async () => {
    await attachGroupProvider({ agentGroupId: 'ag-1', name: 'p1' });
    await putGroupEgressRule('ag-1', {
      name: 'r1',
      host: 'api.example.com',
      ports: [443],
      binaries: ['/usr/bin/curl'],
    });
    await deleteAgentGroup('ag-1');
    expect(await getDb().all('SELECT * FROM openshell_group_providers')).toEqual([]);
    expect(await getDb().all('SELECT * FROM openshell_group_egress')).toEqual([]);
  });
});

describe('openshell_group_egress', () => {
  it('put / replace by name / list / remove, per group', async () => {
    await putGroupEgressRule('ag-1', {
      name: 'crm_api',
      host: 'api.hubapi.com',
      ports: [443],
      binaries: ['/usr/local/bin/node'],
    });
    await putGroupEgressRule('ag-1', { name: 'git', host: 'github.com', ports: [443, 22], binaries: ['/usr/bin/git'] });
    await putGroupEgressRule('ag-1', {
      name: 'crm_api',
      host: 'api.hubapi.com',
      ports: [443, 8443],
      binaries: ['/usr/local/bin/node', '/usr/local/bin/bun'],
    });
    expect((await listGroupEgressRules('ag-1')).map(({ createdAt: _c, ...r }) => r)).toEqual([
      {
        name: 'crm_api',
        host: 'api.hubapi.com',
        ports: [443, 8443],
        binaries: ['/usr/local/bin/node', '/usr/local/bin/bun'],
      },
      { name: 'git', host: 'github.com', ports: [443, 22], binaries: ['/usr/bin/git'] },
    ]);
    expect(await listGroupEgressRules('ag-2')).toEqual([]);
    expect(await removeGroupEgressRule('ag-1', 'git')).toBe(true);
    expect(await removeGroupEgressRule('ag-1', 'git')).toBe(false);
    expect((await listGroupEgressRules('ag-1')).map((r) => r.name)).toEqual(['crm_api']);
  });
});
