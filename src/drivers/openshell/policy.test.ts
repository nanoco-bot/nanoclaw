/**
 * SessionSpec -> OpenShell policy compilation. Pure translation; no gateway, no Docker.
 *
 * Inputs come from NanoClaw's own shared driver fixture (vendored
 * `spec-fixture.ts`) — the same spec its conformance suite drives through the
 * Docker driver — so these assertions are about the input core actually composes.
 */
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { validateSpec, type MountClass, type MountSpec, type SessionSpec } from '../types.js';
import {
  DEFAULT_BASE_READ_ONLY,
  GATEWAY_RULE_NAME,
  compileDriverConfig,
  compilePolicy,
  mountAccess,
  renderPolicyYaml,
} from './policy.js';

const agentOf = (spec: SessionSpec) => spec.containers.find((c) => c.role === 'agent')!;

function mount(cls: MountClass, mode: 'rw' | 'ro', hostPath: string, containerPath: string): MountSpec {
  return { class: cls, mode, hostPath, containerPath, groupScope: 'g1' };
}

/** A spec carrying every class the agent may hold, at paths that pass validateSpec. */
function allClassesSpec(): SessionSpec {
  const spec = fixtureSpec();
  agentOf(spec).mounts = [
    mount('group-state', 'rw', '/install/data/v2-sessions/g1/s1', '/workspace'),
    mount('group-state', 'ro', '/install/groups/agent-one/CLAUDE.composed.md', '/workspace/agent/CLAUDE.md'),
    mount('install-surface', 'ro', '/install/container/agent-runner/src', '/app/src'),
    mount('gateway-trust', 'ro', '/install/data/gateway-trust/ca.pem', '/etc/ssl/gateway-ca.pem'),
    mount('allowlisted-extra', 'rw', '/home/op/projects', '/workspace/extra/projects'),
    mount('allowlisted-extra', 'ro', '/home/op/reference', '/workspace/extra/reference'),
  ];
  return spec;
}

describe('mount class -> filesystem_policy access', () => {
  const cases: Array<[MountClass, 'rw' | 'ro', 'read_write' | 'read_only' | RegExp]> = [
    ['group-state', 'rw', 'read_write'], // the mailbox-DB IPC channel
    ['group-state', 'ro', 'read_only'], // read-only views over group paths are legitimate
    ['install-surface', 'ro', 'read_only'],
    ['install-surface', 'rw', /denied-by-policy: install-surface .* must be ro/],
    ['gateway-trust', 'ro', 'read_only'],
    ['gateway-trust', 'rw', /denied-by-policy: gateway-trust .* must be ro/],
    ['identity-material', 'ro', /denied-by-policy: identity-material .* invalid on role agent/],
    ['allowlisted-extra', 'rw', 'read_write'],
    ['allowlisted-extra', 'ro', 'read_only'],
  ];
  it.each(cases)('%s (%s) -> %s', (cls, mode, expected) => {
    const m = mount(cls, mode, '/x/y', '/target');
    if (expected instanceof RegExp) expect(() => mountAccess(m, 'agent')).toThrow(expected);
    else expect(mountAccess(m, 'agent')).toBe(expected);
  });
});

describe('compilePolicy', () => {
  it('reproduces the shape verified on OpenShell v0.1.2 for a single rw mailbox mount', () => {
    const spec = fixtureSpec({ runAs: undefined });
    agentOf(spec).mounts = [mount('group-state', 'rw', '/install/data/v2-sessions/g1/s1', '/mailbox')];
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();

    const yaml = renderPolicyYaml(compilePolicy(spec, agentOf(spec)));
    expect(yaml).toBe(
      [
        'version: 1',
        'filesystem_policy:',
        '  include_workdir: true',
        '  read_only:',
        '    - "/usr"',
        '    - "/bin"',
        '    - "/lib"',
        '    - "/lib64"',
        '    - "/etc"',
        '  read_write:',
        '    - "/mailbox"',
        '',
      ].join('\n'),
    );
    expect(parseYaml(yaml)).toEqual({
      version: 1,
      filesystem_policy: {
        include_workdir: true,
        read_only: ['/usr', '/bin', '/lib', '/lib64', '/etc'],
        read_write: ['/mailbox'],
      },
    });
  });

  it("compiles NanoClaw's shared conformance fixture", () => {
    const spec = fixtureSpec();
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
    expect(compilePolicy(spec, agentOf(spec))).toEqual({
      version: 1,
      filesystem_policy: {
        include_workdir: true,
        read_only: [...DEFAULT_BASE_READ_ONLY, '/app/src', '/app/CLAUDE.md'],
        read_write: ['/workspace'],
      },
      process: { run_as_user: '501', run_as_group: '1000' },
    });
  });

  it('maps every agent-mountable class by its declared mode, container paths verbatim', () => {
    const spec = allClassesSpec();
    expect(() => validateSpec(spec, FIXTURE_POLICY)).not.toThrow();
    const fsPolicy = compilePolicy(spec, agentOf(spec)).filesystem_policy;
    expect(fsPolicy.read_write).toEqual(['/workspace', '/workspace/extra/projects']);
    expect(fsPolicy.read_only).toEqual([
      ...DEFAULT_BASE_READ_ONLY,
      '/workspace/agent/CLAUDE.md',
      '/app/src',
      '/etc/ssl/gateway-ca.pem',
      '/workspace/extra/reference',
    ]);
  });

  it('round-trips through a YAML parser for every class', () => {
    const spec = allClassesSpec();
    const policy = compilePolicy(spec, agentOf(spec));
    expect(parseYaml(renderPolicyYaml(policy))).toEqual(policy);
  });

  it('quotes paths so YAML-significant characters stay literal', () => {
    const spec = fixtureSpec({ runAs: undefined });
    agentOf(spec).mounts = [mount('allowlisted-extra', 'ro', '/srv/a', '/data/#not-a-comment: [x]')];
    const policy = compilePolicy(spec, agentOf(spec));
    expect(parseYaml(renderPolicyYaml(policy)).filesystem_policy.read_only).toContain('/data/#not-a-comment: [x]');
  });

  it('a path granted rw is not also listed ro', () => {
    const spec = fixtureSpec({ runAs: undefined });
    agentOf(spec).mounts = [mount('allowlisted-extra', 'rw', '/srv/etc', '/etc')];
    const fsPolicy = compilePolicy(spec, agentOf(spec)).filesystem_policy;
    expect(fsPolicy.read_write).toEqual(['/etc']);
    expect(fsPolicy.read_only).not.toContain('/etc');
  });

  it('honors operator base dirs and include_workdir', () => {
    const spec = fixtureSpec({ runAs: undefined });
    agentOf(spec).mounts = [];
    const policy = compilePolicy(spec, agentOf(spec), {
      baseReadOnly: ['/usr', '/app'],
      baseReadWrite: ['/tmp'],
      includeWorkdir: false,
    });
    expect(policy.filesystem_policy).toEqual({
      include_workdir: false,
      read_only: ['/usr', '/app'],
      read_write: ['/tmp'],
    });
  });

  it.each([
    ['relative', 'workspace', /must be absolute/],
    ['dot-dot', '/workspace/../etc', /must be canonical/],
    ['trailing slash', '/workspace/', /must be canonical/],
    ['double slash', '//workspace', /must be canonical/],
  ])('refuses a %s container path (spec-invalid)', (_label, containerPath, re) => {
    const spec = fixtureSpec();
    agentOf(spec).mounts = [mount('group-state', 'rw', '/install/data/v2-sessions/g1/s1', containerPath)];
    expect(() => compilePolicy(spec, agentOf(spec))).toThrow(/spec-invalid/);
    expect(() => compilePolicy(spec, agentOf(spec))).toThrow(re);
  });

  it("refuses read_write on '/'", () => {
    const spec = fixtureSpec();
    agentOf(spec).mounts = [mount('allowlisted-extra', 'rw', '/srv/root', '/')];
    expect(() => compilePolicy(spec, agentOf(spec))).toThrow(/cannot grant read_write on '\/'/);
  });

  it('refuses more than 256 policy paths', () => {
    const spec = fixtureSpec();
    agentOf(spec).mounts = Array.from({ length: 260 }, (_, i) =>
      mount('allowlisted-extra', 'ro', `/srv/${i}`, `/m/${i}`),
    );
    expect(() => compilePolicy(spec, agentOf(spec))).toThrow(/at most 256 paths/);
  });

  it('realizes runAs as process.run_as_user/group and refuses root', () => {
    expect(compilePolicy(fixtureSpec(), agentOf(fixtureSpec())).process).toEqual({
      run_as_user: '501',
      run_as_group: '1000',
    });
    const noRunAs = fixtureSpec({ runAs: undefined });
    expect(compilePolicy(noRunAs, agentOf(noRunAs)).process).toBeUndefined();
    const root = fixtureSpec({ runAs: { uid: 0, gid: 0 } });
    expect(() => compilePolicy(root, agentOf(root))).toThrow(/spec-invalid: runAs.uid 0/);
  });

  it('emits landlock compatibility only when configured', () => {
    const spec = fixtureSpec();
    expect(compilePolicy(spec, agentOf(spec)).landlock).toBeUndefined();
    expect(compilePolicy(spec, agentOf(spec), { landlockCompatibility: 'hard_requirement' }).landlock).toEqual({
      compatibility: 'hard_requirement',
    });
  });

  describe('network access intent', () => {
    const egress = { ports: [10255], binaries: ['/usr/local/bin/bun'] };

    it('no gatewayEgress configured -> no network rule (OpenShell default deny: fails closed)', () => {
      const spec = fixtureSpec();
      expect(compilePolicy(spec, agentOf(spec)).network_policies).toBeUndefined();
    });

    it('realizes a host target as one rule to the intent endpoint', () => {
      const spec = fixtureSpec();
      const policy = compilePolicy(spec, agentOf(spec), { gatewayEgress: egress });
      expect(policy.network_policies).toEqual({
        [GATEWAY_RULE_NAME]: {
          name: GATEWAY_RULE_NAME,
          endpoints: [{ host: 'host.internal', ports: [10255] }],
          binaries: [{ path: '/usr/local/bin/bun' }],
        },
      });
      expect(parseYaml(renderPolicyYaml(policy))).toEqual(policy);
    });

    it('honors a host override', () => {
      const spec = fixtureSpec();
      const policy = compilePolicy(spec, agentOf(spec), {
        gatewayEgress: { ...egress, host: 'host.openshell.internal' },
      });
      expect(policy.network_policies?.[GATEWAY_RULE_NAME].endpoints[0].host).toBe('host.openshell.internal');
    });

    it("network 'none' gets no rule even when egress is configured", () => {
      const spec = fixtureSpec({ network: 'none' });
      expect(compilePolicy(spec, agentOf(spec), { gatewayEgress: egress }).network_policies).toBeUndefined();
    });

    it('refuses a session-container target (needs auxiliary containers)', () => {
      const spec = fixtureSpec({
        networkAccess: { endpoint: 'proxy', target: { kind: 'session-container', role: 'proxy' } },
      });
      expect(() => compilePolicy(spec, agentOf(spec), { gatewayEgress: egress })).toThrow(/spec-invalid/);
    });
  });
});

describe('compileDriverConfig', () => {
  it('emits one docker bind per mount with read_only from the declared mode', () => {
    const spec = allClassesSpec();
    expect(compileDriverConfig(agentOf(spec))).toEqual({
      docker: {
        mounts: [
          { type: 'bind', source: '/install/data/v2-sessions/g1/s1', target: '/workspace', read_only: false },
          {
            type: 'bind',
            source: '/install/groups/agent-one/CLAUDE.composed.md',
            target: '/workspace/agent/CLAUDE.md',
            read_only: true,
          },
          { type: 'bind', source: '/install/container/agent-runner/src', target: '/app/src', read_only: true },
          {
            type: 'bind',
            source: '/install/data/gateway-trust/ca.pem',
            target: '/etc/ssl/gateway-ca.pem',
            read_only: true,
          },
          { type: 'bind', source: '/home/op/projects', target: '/workspace/extra/projects', read_only: false },
          { type: 'bind', source: '/home/op/reference', target: '/workspace/extra/reference', read_only: true },
        ],
      },
    });
  });

  it('every bind target is granted by the compiled policy with matching access', () => {
    const spec = allClassesSpec();
    const fsPolicy = compilePolicy(spec, agentOf(spec)).filesystem_policy;
    for (const bind of compileDriverConfig(agentOf(spec))!.docker.mounts) {
      expect(bind.read_only ? fsPolicy.read_only : fsPolicy.read_write).toContain(bind.target);
    }
  });

  it('is null without mounts, so allow_driver_config is not required', () => {
    const spec = fixtureSpec();
    agentOf(spec).mounts = [];
    expect(compileDriverConfig(agentOf(spec))).toBeNull();
  });
});
