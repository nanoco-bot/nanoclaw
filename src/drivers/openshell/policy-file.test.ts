/**
 * The operator's policy file: per-group providers and network rules, read by
 * the driver for every new sandbox and edited by the console.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { GROUP_FOLDER_LABEL } from '../types.js';
import { OpenShellSessionDriver } from './driver.js';
import { FakeOpenShellCli, quietLogger } from './fake-cli.js';
import { mergePolicyOptions, parsePolicyConfig } from './group-policy.js';
import {
  addGroupProvider,
  putGroupEgressRule,
  readPolicyFile,
  removeGroupEgressRule,
  removeGroupProvider,
} from './policy-file.js';
import { settingsFromEnv } from './settings.js';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-policy-file-'));
  file = path.join(dir, 'policy.yaml');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const RULE = { name: 'crm', host: 'api.hubapi.com', ports: [443], binaries: ['/usr/bin/curl'] };

describe('policy file edits', () => {
  it('creates the file, adds and removes a provider and a rule, and validates each write', () => {
    expect(readPolicyFile(file)).toEqual({});
    addGroupProvider(file, 'alice', 'github-alice');
    addGroupProvider(file, 'alice', 'github-alice'); // idempotent
    putGroupEgressRule(file, 'alice', RULE);
    putGroupEgressRule(file, 'alice', { ...RULE, ports: [8443] }); // same name replaces
    expect(readPolicyFile(file).groups?.alice).toEqual({
      providers: ['github-alice'],
      egress: [{ ...RULE, ports: [8443] }],
    });
    removeGroupProvider(file, 'alice', 'github-alice');
    removeGroupEgressRule(file, 'alice', 'crm');
    expect(readPolicyFile(file).groups?.alice).toEqual({ providers: [], egress: [] });
  });

  it('keeps the operator comments and other groups untouched', () => {
    fs.writeFileSync(file, '# who may reach what\ngroups:\n  bob:\n    # bob only reads\n    providers: [gh-bob]\n');
    addGroupProvider(file, 'alice', 'gh-alice');
    const text = fs.readFileSync(file, 'utf8');
    expect(text).toContain('# who may reach what');
    expect(text).toContain('# bob only reads');
    expect(readPolicyFile(file).groups?.bob).toEqual({ providers: ['gh-bob'] });
  });

  it('refuses an invalid edit and leaves the file as it was', () => {
    putGroupEgressRule(file, 'alice', RULE);
    const before = fs.readFileSync(file, 'utf8');
    expect(() => addGroupProvider(file, 'alice', 'not a name')).toThrow(/not an OpenShell provider name/);
    expect(() => removeGroupProvider(file, 'alice', 'ghost')).toThrow(/not attached/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('providers in the policy', () => {
  it('accumulate: the default list, then the group list, without duplicates', () => {
    expect(mergePolicyOptions({ providers: ['a', 'b'] }, { providers: ['b', 'c'] }).providers).toEqual(['a', 'b', 'c']);
    expect(parsePolicyConfig(null)).toEqual({});
  });

  it('a YAML file is read by settingsFromEnv, and the default path is used when no variable names one', () => {
    fs.writeFileSync(file, 'default:\n  providers: [shared]\ngroups:\n  alice:\n    providers: [gh-alice]\n');
    const settings = settingsFromEnv({}, undefined, file);
    expect(settings.policy.providers).toEqual(['shared']);
    expect(settings.groupPolicy?.alice.providers).toEqual(['gh-alice']);
    expect(settingsFromEnv({}, undefined, path.join(dir, 'absent.yaml')).groupPolicy).toBeUndefined();
  });

  it('an edit reaches the next sandbox without restarting the driver', async () => {
    const folder = fixtureSpec().labels[GROUP_FOLDER_LABEL];
    const cli = new FakeOpenShellCli();
    cli.rules = [
      { match: /^sandbox get /, fails: 'message: "sandbox not found"' },
      { match: /^sandbox create /, stdout: '' },
    ];
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      logger: quietLogger,
      loadPolicy: () => {
        const s = settingsFromEnv({}, undefined, file);
        return { policy: s.policy, groupPolicy: s.groupPolicy };
      },
    });
    const providersOfLastCreate = () => {
      const create = cli.callsMatching(/^sandbox create /).at(-1)!;
      return create.flatMap((arg, i) => (create[i - 1] === '--provider' ? [arg] : []));
    };
    await (await driver.prepare(fixtureSpec())).start();
    expect(providersOfLastCreate()).toEqual([]);
    addGroupProvider(file, folder, 'github-alice');
    await (await driver.prepare(fixtureSpec())).start();
    expect(providersOfLastCreate()).toEqual(['github-alice']);
  });

  it('a broken file fails the sandbox loudly instead of dropping its rules', async () => {
    fs.writeFileSync(file, 'groups:\n  alice:\n    providers: [1, 2]\n');
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli: new FakeOpenShellCli(),
      logger: quietLogger,
      loadPolicy: () => {
        const s = settingsFromEnv({}, undefined, file);
        return { policy: s.policy, groupPolicy: s.groupPolicy };
      },
    });
    await expect(driver.prepare(fixtureSpec())).rejects.toMatchObject({ kind: 'spec-invalid' });
  });
});
