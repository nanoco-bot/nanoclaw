/**
 * Per-agent egress (PolicyOptions.egress) + per-group policy (group-policy.ts)
 * + the policy file setting. Pure; no gateway, no Docker.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { GROUP_FOLDER_LABEL, validateSpec, type SessionSpec } from '../types.js';
import { mergePolicyOptions, parsePolicyConfig, policyOptionsFor } from './group-policy.js';
import { GATEWAY_RULE_NAME, compilePolicy, renderPolicyYaml, type EgressRule } from './policy.js';
import { settingsFromEnv } from './settings.js';

/**
 * Per-group policy file in the shape operators write to
 * NANOCLAW_OPENSHELL_POLICY_FILE: every agent gets the default rules, only `alice`
 * gets an extra egress rule.
 */
const SAMPLE_POLICY_FILE = {
  default: {
    baseReadOnly: ['/usr', '/bin', '/lib', '/lib64', '/etc', '/app', '/pnpm', '/opt'],
    baseReadWrite: ['/tmp', '/home/node'],
    landlockCompatibility: 'hard_requirement',
    egress: [
      {
        name: 'nanoclaw_model_gateway',
        host: 'host.openshell.internal',
        ports: [18790],
        binaries: ['/usr/local/bin/bun', '/usr/local/bin/node'],
      },
    ],
  },
  groups: {
    alice: {
      egress: [{ name: 'crm_api', host: 'host.openshell.internal', ports: [18791], binaries: ['/usr/bin/curl'] }],
    },
    bob: {},
  },
};

const MODEL: EgressRule = {
  name: 'model_gateway',
  host: 'host.openshell.internal',
  ports: [18790],
  binaries: ['/usr/local/bin/bun'],
};
const CRM: EgressRule = {
  name: 'crm_api',
  host: 'host.openshell.internal',
  ports: [18791],
  binaries: ['/usr/bin/curl'],
};

/** NanoClaw's shared fixture, relabeled as a given agent-group folder (and group-state paths moved to match). */
function specFor(folder: string): SessionSpec {
  const spec = fixtureSpec({
    labels: { 'nanoclaw-container-name': `nanoclaw-v2-${folder}-1`, [GROUP_FOLDER_LABEL]: folder },
  });
  return spec;
}
const agentOf = (spec: SessionSpec) => spec.containers.find((c) => c.role === 'agent')!;

describe('PolicyOptions.egress -> network_policies', () => {
  it('emits one named rule per egress entry', () => {
    const spec = fixtureSpec();
    const policy = compilePolicy(spec, agentOf(spec), { egress: [MODEL, CRM] });
    expect(policy.network_policies).toEqual({
      model_gateway: {
        name: 'model_gateway',
        endpoints: [{ host: 'host.openshell.internal', ports: [18790] }],
        binaries: [{ path: '/usr/local/bin/bun' }],
      },
      crm_api: {
        name: 'crm_api',
        endpoints: [{ host: 'host.openshell.internal', ports: [18791] }],
        binaries: [{ path: '/usr/bin/curl' }],
      },
    });
    expect(parseYaml(renderPolicyYaml(policy))).toEqual(policy);
  });

  it('coexists with the gatewayEgress rule', () => {
    const spec = fixtureSpec();
    const policy = compilePolicy(spec, agentOf(spec), {
      gatewayEgress: { ports: [10255], binaries: ['/usr/local/bin/bun'] },
      egress: [CRM],
    });
    expect(Object.keys(policy.network_policies!)).toEqual([GATEWAY_RULE_NAME, 'crm_api']);
  });

  it("network 'none' gets no rules at all", () => {
    const spec = fixtureSpec({ network: 'none' });
    expect(compilePolicy(spec, agentOf(spec), { egress: [MODEL, CRM] }).network_policies).toBeUndefined();
  });

  it('no egress configured -> no network_policies (OpenShell default deny)', () => {
    const spec = fixtureSpec();
    expect(compilePolicy(spec, agentOf(spec), { egress: [] }).network_policies).toBeUndefined();
  });

  it.each<[string, Partial<EgressRule>, RegExp]>([
    ['reserved _provider_ prefix', { name: '_provider_x' }, /egress rule name/],
    ['name with spaces', { name: 'crm api' }, /egress rule name/],
    ['empty host', { host: '' }, /needs a host/],
    ['no ports', { ports: [] }, /TCP ports/],
    ['port 0', { ports: [0] }, /TCP ports/],
    ['port 70000', { ports: [70000] }, /TCP ports/],
    ['no binaries (would silently match nothing)', { binaries: [] }, /at least one binary/],
    ['relative binary', { binaries: ['curl'] }, /must be an absolute path/],
  ])('refuses a rule with %s (spec-invalid)', (_label, patch, re) => {
    const spec = fixtureSpec();
    const call = () => compilePolicy(spec, agentOf(spec), { egress: [{ ...CRM, ...patch }] });
    expect(call).toThrow(/spec-invalid/);
    expect(call).toThrow(re);
  });

  it('refuses duplicate rule names, including a clash with the gateway rule', () => {
    const spec = fixtureSpec();
    expect(() => compilePolicy(spec, agentOf(spec), { egress: [CRM, CRM] })).toThrow(
      /duplicate egress rule name 'crm_api'/,
    );
    expect(() =>
      compilePolicy(spec, agentOf(spec), {
        gatewayEgress: { ports: [1], binaries: ['/x'] },
        egress: [{ ...CRM, name: GATEWAY_RULE_NAME }],
      }),
    ).toThrow(/duplicate egress rule name/);
  });
});

describe('mergePolicyOptions / policyOptionsFor', () => {
  it('group fields override defaults; egress rules accumulate (defaults first)', () => {
    expect(
      mergePolicyOptions(
        { baseReadWrite: ['/tmp'], landlockCompatibility: 'hard_requirement', egress: [MODEL] },
        { baseReadWrite: ['/tmp', '/home/node'], egress: [CRM] },
      ),
    ).toEqual({
      baseReadWrite: ['/tmp', '/home/node'],
      landlockCompatibility: 'hard_requirement',
      egress: [MODEL, CRM],
    });
  });

  it('selects by the group-folder label; unknown or missing folder gets the defaults only', () => {
    const defaults = { egress: [MODEL] };
    const groups = { alice: { egress: [CRM] } };
    expect(policyOptionsFor(specFor('alice'), defaults, groups).egress).toEqual([MODEL, CRM]);
    expect(policyOptionsFor(specFor('bob'), defaults, groups).egress).toEqual([MODEL]);
    const unlabeled = fixtureSpec({ labels: {} });
    expect(policyOptionsFor(unlabeled, defaults, groups)).toBe(defaults);
  });

  it('does not resolve inherited object keys as group names', () => {
    expect(policyOptionsFor(specFor('constructor'), { egress: [MODEL] }, {}).egress).toEqual([MODEL]);
    expect(policyOptionsFor(specFor('toString'), { egress: [MODEL] }, {}).egress).toEqual([MODEL]);
  });
});

describe('parsePolicyConfig', () => {
  it('rejects unknown keys and wrong types loudly (this file grants egress)', () => {
    expect(() => parsePolicyConfig({ defaults: {} })).toThrow(/unknown key 'defaults'/);
    expect(() => parsePolicyConfig({ default: { egres: [] } })).toThrow(/unknown key 'egres'/);
    expect(() => parsePolicyConfig({ groups: { a: { egress: [{ ...CRM, port: 1 }] } } })).toThrow(/unknown key 'port'/);
    expect(() => parsePolicyConfig({ default: { baseReadOnly: '/usr' } })).toThrow(/array of strings/);
    expect(() => parsePolicyConfig({ default: { landlockCompatibility: 'strict' } })).toThrow(
      /best_effort or hard_requirement/,
    );
    expect(() => parsePolicyConfig([])).toThrow(/root/);
  });

  it('a per-group policy file: both agents reach the model gateway, only alice gets the extra rule', () => {
    const config = parsePolicyConfig(JSON.parse(JSON.stringify(SAMPLE_POLICY_FILE)));
    const rulesFor = (folder: string) => {
      const spec = specFor(folder);
      expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
      const policy = compilePolicy(spec, agentOf(spec), policyOptionsFor(spec, config.default ?? {}, config.groups));
      expect(policy.landlock).toEqual({ compatibility: 'hard_requirement' });
      return policy.network_policies ?? {};
    };
    const alice = rulesFor('alice');
    const bob = rulesFor('bob');
    expect(Object.keys(alice).sort()).toEqual(['crm_api', 'nanoclaw_model_gateway']);
    expect(Object.keys(bob)).toEqual(['nanoclaw_model_gateway']);
    expect(alice.crm_api.endpoints).toEqual([{ host: 'host.openshell.internal', ports: [18791] }]);
    expect(alice.crm_api.binaries).toEqual([{ path: '/usr/bin/curl' }]);
    expect(bob.nanoclaw_model_gateway).toEqual(alice.nanoclaw_model_gateway);
  });
});

describe('settingsFromEnv: NANOCLAW_OPENSHELL_POLICY_FILE', () => {
  const file = JSON.stringify({
    default: { baseReadWrite: ['/tmp'], egress: [MODEL] },
    groups: { alice: { egress: [CRM] } },
  });

  it('loads defaults and per-group entries', () => {
    const s = settingsFromEnv({ NANOCLAW_OPENSHELL_POLICY_FILE: '/etc/p.json' }, (p) => {
      expect(p).toBe('/etc/p.json');
      return file;
    });
    expect(s.policy).toEqual({ baseReadWrite: ['/tmp'], egress: [MODEL] });
    expect(s.groupPolicy).toEqual({ alice: { egress: [CRM] } });
  });

  it('individual env settings override the file defaults', () => {
    const s = settingsFromEnv(
      { NANOCLAW_OPENSHELL_POLICY_FILE: '/p', NANOCLAW_OPENSHELL_BASE_RW: '/scratch' },
      () => file,
    );
    expect(s.policy.baseReadWrite).toEqual(['/scratch']);
    expect(s.policy.egress).toEqual([MODEL]);
  });

  it('names the file when it is not YAML or JSON', () => {
    expect(() => settingsFromEnv({ NANOCLAW_OPENSHELL_POLICY_FILE: '/p' }, () => '{nope')).toThrow(
      /OpenShell policy file '\/p' is not readable YAML\/JSON/,
    );
  });
});
