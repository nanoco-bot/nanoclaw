/**
 * Custom OpenShell provider profile hints: the DB registry (migration 027) and
 * `ncl openshell-provider-profile create/list/delete` through the dispatcher.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createProviderProfile,
  deleteProviderProfile,
  getProviderProfile,
  listProviderProfiles,
  normalizeProfile,
} from '../../db/openshell-provider-profiles.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
import './index.js';

const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: 'ag', messagingGroupId: 'mg' };

beforeEach(async () => {
  await runMigrations(await initTestDb());
});
afterEach(async () => {
  await closeDb();
});

describe('normalizeProfile', () => {
  it('defaults type and label to the id; splits and dedupes key lists', () => {
    expect(
      normalizeProfile({
        id: 'acme-crm',
        credentialKeys: 'ACME_API_KEY, ACME_API_KEY,ACME_SECRET',
        configKeys: ['region'],
      }),
    ).toEqual({
      id: 'acme-crm',
      label: 'acme-crm',
      type: 'acme-crm',
      credentialKeys: ['ACME_API_KEY', 'ACME_SECRET'],
      configKeys: ['region'],
      description: null,
    });
  });
  it.each([
    [{ id: 'Acme' }, /profile id/],
    [{ id: 'acme', type: 'Bad Type' }, /provider type/],
    [{ id: 'acme', credentialKeys: 'not-an-env' }, /credential key 'not-an-env'/],
    [{ id: 'acme', configKeys: 'a b' }, /config key/],
    [{ id: 'acme', label: 'two\nlines' }, /one line/],
  ])('refuses %o', (input, error) => {
    expect(() => normalizeProfile(input)).toThrow(error);
  });
});

describe('registry CRUD', () => {
  it('create / get / list / delete; duplicate ids refused', async () => {
    await createProviderProfile(normalizeProfile({ id: 'zeta', credentialKeys: 'Z_KEY' }));
    await createProviderProfile(
      normalizeProfile({ id: 'acme-crm', label: 'ACME CRM', type: 'acme', credentialKeys: 'ACME_API_KEY' }),
    );
    expect((await listProviderProfiles()).map((p) => p.id)).toEqual(['acme-crm', 'zeta']);
    expect(await getProviderProfile('acme-crm')).toMatchObject({
      label: 'ACME CRM',
      type: 'acme',
      credentialKeys: ['ACME_API_KEY'],
    });
    await expect(createProviderProfile(normalizeProfile({ id: 'zeta' }))).rejects.toThrow(/already exists/);
    expect(await deleteProviderProfile('zeta')).toBe(true);
    expect(await deleteProviderProfile('zeta')).toBe(false);
    expect((await listProviderProfiles()).map((p) => p.id)).toEqual(['acme-crm']);
  });
});

describe('ncl openshell-provider-profile', () => {
  const run = (command: string, args: Record<string, unknown>, ctx: CallerContext = host) => dispatch({ id: 'r', command, args }, ctx);

  it('create / list / delete, scriptable; operator-only; approval-tier writes', async () => {
    const names = listCommands()
      .filter((c) => c.name.startsWith('openshell-provider-profile-') && !c.name.endsWith('-help'))
      .map((c) => c.name)
      .sort();
    expect(names).toEqual([
      'openshell-provider-profile-create',
      'openshell-provider-profile-delete',
      'openshell-provider-profile-list',
    ]);
    const created = await run('openshell-provider-profile-create', {
      id: 'acme-crm',
      label: 'ACME CRM',
      'credential-keys': 'ACME_API_KEY',
      'config-keys': 'region',
    });
    expect(created.ok).toBe(true);
    const list = await run('openshell-provider-profile-list', {});
    expect(list.ok && list.data).toMatchObject({
      profiles: [{ id: 'acme-crm', type: 'acme-crm', configKeys: ['region'] }],
    });
    expect(list.ok && list.human).toContain(
      'acme-crm  "ACME CRM"  --type acme-crm  credentials: ACME_API_KEY  config: region',
    );
    const dup = await run('openshell-provider-profile-create', { id: 'acme-crm' });
    expect(!dup.ok && dup.error.message).toMatch(/already exists/);
    expect((await run('openshell-provider-profile-delete', { id: 'acme-crm' })).ok).toBe(true);
    const gone = await run('openshell-provider-profile-delete', { id: 'acme-crm' });
    expect(!gone.ok && gone.error.message).toMatch(/no custom provider profile/);
    const denied = await run('openshell-provider-profile-list', {}, agent);
    expect(!denied.ok && denied.error.message).toMatch(/operator-only/);
    expect(listCommands().find((c) => c.name === 'openshell-provider-profile-create')!.access).toBe('approval');
  });
});
