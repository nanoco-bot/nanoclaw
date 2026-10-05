import { describe, expect, it } from 'vitest';

import {
  policyUpdateArgs,
  policyViewArgs,
  proposalsNote,
  proposalsState,
  repeated,
  ruleApproveArgs,
  ruleListArgs,
  ruleRejectArgs,
} from './policy-commands.js';

describe('openshell policy argv (OpenShell v0.1.2 CLI)', () => {
  it('always names the sandbox explicitly (the CLI would otherwise use the last-used one)', () => {
    expect(ruleListArgs('ncl-abc')).toEqual(['rule', 'get', 'ncl-abc', '--status', 'pending']);
    expect(ruleListArgs('ncl-abc', 'approved')).toEqual(['rule', 'get', 'ncl-abc', '--status', 'approved']);
    expect(ruleApproveArgs('ncl-abc', 'c1')).toEqual(['rule', 'approve', 'ncl-abc', '--chunk-id', 'c1']);
    expect(ruleRejectArgs('ncl-abc', 'c1', 'too broad')).toEqual([
      'rule',
      'reject',
      'ncl-abc',
      '--chunk-id',
      'c1',
      '--reason',
      'too broad',
    ]);
  });

  it('views the full effective policy by default', () => {
    expect(policyViewArgs('ncl-abc')).toEqual(['policy', 'get', 'ncl-abc', '--full', '-o', 'table']);
    expect(policyViewArgs('ncl-abc', { base: true, rev: 3, output: 'json' })).toEqual([
      'policy',
      'get',
      'ncl-abc',
      '--base',
      '--rev',
      '3',
      '-o',
      'json',
    ]);
    expect(() => policyViewArgs('ncl-abc', { rev: -1 })).toThrow(/--rev/);
  });

  it('passes policy update flags through, repeating multi-valued ones', () => {
    expect(
      policyUpdateArgs('ncl-abc', {
        addAllow: ['api.example.com:443,8443:GET:/v1/*', 'api.example.com:443:POST:/v1/x'],
        ruleName: 'example_api',
        binary: ['/usr/bin/curl'],
        dryRun: true,
      }),
    ).toEqual([
      'policy',
      'update',
      'ncl-abc',
      '--add-allow',
      'api.example.com:443,8443:GET:/v1/*',
      '--add-allow',
      'api.example.com:443:POST:/v1/x',
      '--binary',
      '/usr/bin/curl',
      '--rule-name',
      'example_api',
      '--dry-run',
    ]);
    expect(policyUpdateArgs('ncl-abc', { removeRule: ['r'], wait: true, timeout: 30 })).toEqual([
      'policy',
      'update',
      'ncl-abc',
      '--remove-rule',
      'r',
      '--wait',
      '--timeout',
      '30',
    ]);
  });

  it('refuses no-op updates, contradictory flags, flag-shaped values and bad sandbox names', () => {
    expect(() => policyUpdateArgs('ncl-abc', { dryRun: true })).toThrow(/nothing to change/);
    expect(() => policyUpdateArgs('ncl-abc', { addEndpoint: ['h:443'], anyBinary: true, binary: ['/b'] })).toThrow(
      /mutually exclusive/,
    );
    expect(() => policyUpdateArgs('ncl-abc', { removeRule: ['--global'] })).toThrow(/may not start with '-'/);
    expect(() => ruleApproveArgs('ncl-abc', '--chunk-id=x')).toThrow(/may not start/);
    expect(() => ruleListArgs('--global')).toThrow(/not a valid OpenShell sandbox name/);
    expect(() => ruleListArgs('Has Spaces')).toThrow(/not a valid/);
  });

  it('accepts one value or a JSON array, never comma-splitting a rule spec', () => {
    expect(repeated(undefined, '--x')).toBeUndefined();
    expect(repeated('h:443,8443:GET:/a', '--x')).toEqual(['h:443,8443:GET:/a']);
    expect(repeated('["a","b"]', '--x')).toEqual(['a', 'b']);
    expect(repeated(['a'], '--x')).toEqual(['a']);
    expect(() => repeated('[1]', '--x')).toThrow(/array of strings/);
    expect(() => repeated('[nope', '--x')).toThrow(/not a valid JSON array/);
    expect(() => repeated(true, '--x')).toThrow(/requires a value/);
  });
});

describe('agent_policy_proposals_enabled detection', () => {
  const doc = (entry: unknown) =>
    JSON.stringify({ sandbox: 's', settings: entry === undefined ? {} : { agent_policy_proposals_enabled: entry } });

  it('reads the sandbox settings JSON and never assumes on', () => {
    expect(proposalsState(doc({ value: 'true', scope: 'global' }))).toBe('enabled');
    expect(proposalsState(doc({ value: 'false', scope: 'sandbox' }))).toBe('disabled');
    expect(proposalsState(doc({ value: '<unset>', scope: 'unset' }))).toBe('unset');
    expect(proposalsState(doc(undefined))).toBe('unset');
    expect(proposalsState(doc({ value: 'maybe', scope: 'global' }))).toBe('unknown');
    expect(proposalsState('not json')).toBe('unknown');
    expect(proposalsState('{}')).toBe('unknown');
  });

  it('explains an empty list unless proposals are on', () => {
    expect(proposalsNote('enabled')).toBeUndefined();
    expect(proposalsNote('unset')).toMatch(/default: off.*always empty|stays empty/);
    expect(proposalsNote('disabled')).toMatch(/off/);
    expect(proposalsNote('unknown')).toMatch(/Could not read/);
  });
});
