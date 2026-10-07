/**
 * Per-group OpenShell providers and network paths reaching the sandbox:
 *  - createArgs() emits `--provider <name>` per provider (PROVIDER_ATTACH_FLAG),
 *    and nothing extra without;
 *  - the driver looks them up at every prepare() (fixed map or function);
 *  - with register.ts's DB-backed lookups, recreating a group's sandbox reads
 *    its attached providers and paths back from the central DB, no manual input.
 */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { attachGroupProvider, putGroupEgressRule } from '../../db/openshell-group-resources.js';
import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { OpenShellSessionDriver, type OpenShellDriverOptions } from './driver.js';
import { FakeOpenShellCli, quietLogger } from './fake-cli.js';
import { createArgs, PROVIDER_ATTACH_FLAG, sandboxName } from './realize.js';
import { dbGroupEgress, dbGroupProviders } from './register.js';

const spec = () => fixtureSpec(); // group folder 'agent-one'

function baseInput(providers?: string[]) {
  const s = spec();
  return {
    spec: s,
    container: s.containers[0],
    name: 'ncl-x',
    policyPath: '/tmp/p.yaml',
    driverConfig: null,
    ...(providers ? { providers } : {}),
  };
}

describe('createArgs providers', () => {
  it('the attach flag is OpenShell v0.1.2’s `--provider` (sandbox create --help / main.rs)', () => {
    expect(PROVIDER_ATTACH_FLAG).toBe('--provider');
  });

  it('without providers: no attach flag, --no-auto-providers as before', () => {
    for (const args of [createArgs(baseInput()), createArgs(baseInput([]))]) {
      expect(args).not.toContain('--provider');
      expect(args).toContain('--no-auto-providers');
    }
  });

  it('one `--provider <name>` per provider (deduped), before the trailing flags; --no-auto-providers kept', () => {
    const args = createArgs(baseInput(['github-alice', 'anthropic-shared', 'github-alice']));
    const at = args.indexOf('--detach');
    expect(args.slice(at - 4, at)).toEqual(['--provider', 'github-alice', '--provider', 'anthropic-shared']);
    expect(args).toContain('--no-auto-providers');
    // Still before the `--` that starts the sandbox command.
    expect(args.indexOf('--provider')).toBeLessThan(args.indexOf('--'));
  });

  it('refuses a name that is not an OpenShell provider name (or would read as a flag)', () => {
    expect(() => createArgs(baseInput(['--policy']))).toThrow(/spec-invalid: OpenShell provider name '--policy'/);
    expect(() => createArgs(baseInput(['has space']))).toThrow(/not valid/);
  });
});

/** A driver whose `sandbox create` records argv and the policy it was handed. */
function driverWith(opts: Partial<OpenShellDriverOptions>) {
  const cli = new FakeOpenShellCli();
  const creates: { args: string[]; policy: { network_policies?: Record<string, unknown> } }[] = [];
  cli.rules = [
    { match: /^sandbox get /, fails: 'sandbox not found' },
    {
      match: /^sandbox create /,
      onCall: (args) =>
        creates.push({ args, policy: parseYaml(fs.readFileSync(args[args.indexOf('--policy') + 1], 'utf8')) }),
      stdout: '{}',
    },
  ];
  const driver = new OpenShellSessionDriver({ ...FIXTURE_POLICY, cli, logger: quietLogger, ...opts });
  return { driver, cli, creates };
}

const providersOf = (args: string[]) => args.flatMap((a, i) => (args[i - 1] === '--provider' ? [a] : []));

describe('the driver looks group resources up at prepare()', () => {
  it('a fixed map, keyed by group folder like groupPolicy', async () => {
    const { driver, creates } = driverWith({
      groupProviders: { 'agent-one': ['github-alice'], other: ['nope'] },
      groupEgress: {
        'agent-one': [{ name: 'crm_api', host: 'api.hubapi.com', ports: [443], binaries: ['/usr/local/bin/node'] }],
      },
    });
    await (await driver.prepare(spec())).start();
    expect(providersOf(creates[0].args)).toEqual(['github-alice']);
    expect(creates[0].policy.network_policies).toHaveProperty('crm_api');
  });

  it('group egress ACCUMULATES on top of the policy file’s default and per-group rules', async () => {
    const { driver, creates } = driverWith({
      policy: { egress: [{ name: 'everyone', host: 'a.example.com', ports: [443], binaries: ['/usr/bin/curl'] }] },
      groupPolicy: {
        'agent-one': {
          egress: [{ name: 'file_group', host: 'b.example.com', ports: [443], binaries: ['/usr/bin/curl'] }],
        },
      },
      groupEgress: () => [{ name: 'db_group', host: 'c.example.com', ports: [443], binaries: ['/usr/bin/curl'] }],
    });
    await (await driver.prepare(spec())).start();
    expect(Object.keys(creates[0].policy.network_policies ?? {}).sort()).toEqual([
      'db_group',
      'everyone',
      'file_group',
    ]);
  });

  it('a group with nothing attached: no provider flags, no extra rules', async () => {
    const { driver, creates } = driverWith({ groupProviders: () => [], groupEgress: () => [] });
    await (await driver.prepare(spec())).start();
    expect(providersOf(creates[0].args)).toEqual([]);
    expect(creates[0].policy.network_policies).toBeUndefined();
  });

  it('a bad stored provider name fails prepare(), before any allocation', async () => {
    const { driver, cli } = driverWith({ groupProviders: () => ['bad name'] });
    await expect(driver.prepare(spec())).rejects.toThrow(/spec-invalid: OpenShell provider name 'bad name'/);
    expect(cli.callsMatching(/^sandbox (get|create)/)).toEqual([]);
  });
});

describe('DB-backed (register.ts lookups): sandbox recreation reads providers and paths back', () => {
  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await createAgentGroup({
      id: 'g1',
      name: 'Agent One',
      folder: 'agent-one',
      agent_provider: null,
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });
  afterEach(async () => {
    await closeDb();
  });

  it('attach once; every new sandbox of the group gets it, with zero further input', async () => {
    await attachGroupProvider({
      agentGroupId: 'g1',
      name: 'github-alice',
      type: 'github',
      credentials: { GITHUB_TOKEN: 'ghp_FIXTURE_00000000000000000000' },
    });
    await putGroupEgressRule('g1', {
      name: 'crm_api',
      host: 'api.hubapi.com',
      ports: [443],
      binaries: ['/usr/local/bin/node'],
    });

    // A fresh driver per "host start", the same lookups register.ts wires in.
    for (const sessionId of ['s1', 's2', 's3']) {
      const { driver, creates } = driverWith({ groupProviders: dbGroupProviders, groupEgress: dbGroupEgress });
      const s = fixtureSpec({ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId } });
      const handle = await driver.prepare(s);
      expect(handle.name).toBe(sandboxName(s.key));
      await handle.start();
      expect(providersOf(creates[0].args)).toEqual(['github-alice']);
      expect(creates[0].policy.network_policies).toMatchObject({
        crm_api: { endpoints: [{ host: 'api.hubapi.com', ports: [443] }], binaries: [{ path: '/usr/local/bin/node' }] },
      });
    }
  });

  it('an attach made after the driver exists applies to the group’s NEXT sandbox (no restart)', async () => {
    const { driver, creates } = driverWith({ groupProviders: dbGroupProviders, groupEgress: dbGroupEgress });
    await (
      await driver.prepare(fixtureSpec({ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's1' } }))
    ).start();
    await attachGroupProvider({ agentGroupId: 'g1', name: 'late-provider' });
    await (
      await driver.prepare(fixtureSpec({ key: { installSlug: 'spike', agentGroupId: 'g1', sessionId: 's2' } }))
    ).start();
    expect(providersOf(creates[0].args)).toEqual([]);
    expect(providersOf(creates[1].args)).toEqual(['late-provider']);
  });

  it('an unknown folder (no such group) reads as nothing attached', async () => {
    expect(await dbGroupProviders('no-such-folder')).toEqual([]);
    expect(await dbGroupEgress('no-such-folder')).toEqual([]);
  });
});

describe('a group provider the gateway does not have', () => {
  it('fails the create as spec-invalid with the fix, not as an unknown error (message from a live v0.1.2 gateway)', async () => {
    const { normalizeOpenShellError } = await import('./realize.js');
    const live =
      "Error:   × provider 'nc-missing' not found and no provider profile named 'nc-missing'\n  │ is available. Create or import the profile first, then create the provider";
    const err = normalizeOpenShellError(new Error(live)) as unknown as {
      kind: string;
      retryable: boolean;
      detail: string;
    };
    expect(err.kind).toBe('spec-invalid');
    expect(err.retryable).toBe(false);
    expect(err.detail).toMatch(
      /OpenShell provider 'nc-missing' is attached to this agent group.*openshell-provider detach/,
    );
  });
});
