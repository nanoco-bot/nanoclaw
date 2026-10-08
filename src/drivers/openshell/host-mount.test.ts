/**
 * Host-mount hardening on the OpenShell driver:
 *  - no symlink component in any mount source (real filesystem, and through prepare());
 *  - group-state / allowlisted-extra mounts may not cover the image's system tree;
 *  - no Unicode control/format characters in host or container paths;
 *  - the Docker bind list and the Landlock policy derive access from one rule,
 *    and a divergence between them is refused, not realized.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { validateSpec, type ContainerSpec, type MountSpec } from '../types.js';
import { OpenShellSessionDriver } from './driver.js';
import { FakeOpenShellCli, quietLogger } from './fake-cli.js';
import {
  assertContainerTarget,
  assertHostMounts,
  assertNoSymlinkComponents,
  PROTECTED_CONTAINER_ROOTS,
} from './host-mount.js';
import {
  assertDriverConfigMatchesPolicy,
  assertPolicyPath,
  compileDriverConfig,
  compilePolicy,
  type DriverConfig,
} from './policy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A real tree: <tmp>/real/inner (dir), <tmp>/link -> real, <tmp>/real/innerlink -> inner. */
function tree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'os-hostmount-')));
  dirs.push(base);
  fs.mkdirSync(path.join(base, 'real', 'inner'), { recursive: true });
  fs.symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
  fs.symlinkSync(path.join(base, 'real', 'inner'), path.join(base, 'real', 'innerlink'));
  return base;
}

describe('assertNoSymlinkComponents (real filesystem)', () => {
  it('accepts a path with no symlink anywhere', () => {
    const base = tree();
    expect(() => assertNoSymlinkComponents(path.join(base, 'real', 'inner'))).not.toThrow();
  });

  it('rejects a symlinked directory as the last component, naming it', () => {
    const base = tree();
    const p = path.join(base, 'real', 'innerlink');
    expect(() => assertNoSymlinkComponents(p)).toThrow(
      `spec-invalid: mount source ${p} has a symlink component at ${p}`,
    );
  });

  it('rejects a symlinked PARENT segment, naming that segment (not the leaf)', () => {
    const base = tree();
    const p = path.join(base, 'link', 'inner');
    expect(() => assertNoSymlinkComponents(p)).toThrow(`has a symlink component at ${path.join(base, 'link')};`);
  });

  it('a missing component ends the walk (nothing below it can be a symlink)', () => {
    const base = tree();
    expect(() => assertNoSymlinkComponents(path.join(base, 'real', 'not-yet', 'deeper'))).not.toThrow();
  });

  it('a component it cannot inspect is refused, not skipped', () => {
    const lstat = () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    };
    expect(() => assertNoSymlinkComponents('/srv/x', lstat)).toThrow(/cannot inspect \/srv \(EACCES\)/);
  });
});

describe('prepare() runs the symlink check after validateSpec, before anything is compiled or created', () => {
  const linkAt = (linked: string) => (p: string) => ({ isSymbolicLink: () => p === linked });

  it('a symlinked parent of the session mount source is refused; no CLI call', async () => {
    const cli = new FakeOpenShellCli();
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      logger: quietLogger,
      lstat: linkAt('/install/data/v2-sessions'),
    });
    await expect(driver.prepare(fixtureSpec())).rejects.toThrow('symlink component at /install/data/v2-sessions');
    expect(cli.calls).toEqual([]);
  });

  it('validateSpec still runs first (a lexical violation is reported as before)', async () => {
    const seen: string[] = [];
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli: new FakeOpenShellCli(),
      logger: quietLogger,
      lstat: (p) => (seen.push(p), { isSymbolicLink: () => false }),
    });
    const spec = fixtureSpec();
    spec.containers[0].mounts[0].hostPath = '/install/data/../etc';
    await expect(driver.prepare(spec)).rejects.toThrow(/denied-by-policy: .*canonical absolute path/);
    expect(seen).toEqual([]);
  });

  it('a clean spec passes and every source component was inspected', async () => {
    const seen: string[] = [];
    const cli = new FakeOpenShellCli();
    cli.rules = [{ match: /^sandbox get /, fails: 'message: "sandbox not found"' }];
    const driver = new OpenShellSessionDriver({
      ...FIXTURE_POLICY,
      cli,
      logger: quietLogger,
      lstat: (p) => (seen.push(p), { isSymbolicLink: () => false }),
    });
    await driver.prepare(fixtureSpec());
    expect(seen).toEqual(
      expect.arrayContaining([
        '/install',
        '/install/data',
        '/install/data/v2-sessions/g1/s1',
        '/install/container/CLAUDE.md',
      ]),
    );
  });
});

describe('assertContainerTarget', () => {
  const m = (cls: MountSpec['class'], containerPath: string) => ({ class: cls, containerPath });

  it.each(['/usr/local/bin', '/usr', '/etc/resolv.conf', '/lib64/x', '/proc/self'])(
    'group-state / allowlisted-extra may not cover the system tree: %s',
    (target) => {
      expect(() => assertContainerTarget(m('group-state', target))).toThrow(/inside the image's system tree/);
      expect(() => assertContainerTarget(m('allowlisted-extra', target))).toThrow(/inside the image's system tree/);
    },
  );

  it("'/' itself is refused for those classes", () => {
    expect(() => assertContainerTarget(m('allowlisted-extra', '/'))).toThrow(/may not target '\/'/);
  });

  it.each([
    '/workspace',
    '/workspace/agent',
    '/workspace/extra/projects',
    '/home/node/.claude',
    '/app/.nanoclaw-session.json',
    '/usrlocal', // a sibling, not under /usr
  ])('core’s real targets (container-runner buildMounts) stay accepted: %s', (target) => {
    expect(() => assertContainerTarget(m('group-state', target))).not.toThrow();
    expect(() => assertContainerTarget(m('allowlisted-extra', target))).not.toThrow();
  });

  it('the classes pinned by classRequiredByPath are not judged here (their targets are core-chosen)', () => {
    for (const cls of ['install-surface', 'gateway-trust', 'identity-material'] as const) {
      expect(() => assertContainerTarget(m(cls, '/usr/lib/node_modules/x'))).not.toThrow();
    }
  });

  it('the protected list is the system tree only', () => {
    expect(PROTECTED_CONTAINER_ROOTS).not.toContain('/app');
    expect(PROTECTED_CONTAINER_ROOTS).not.toContain('/workspace');
  });
});

describe('control / format characters in mount paths', () => {
  // U+202E RIGHT-TO-LEFT OVERRIDE, U+2028 LINE SEPARATOR, U+200B ZERO WIDTH SPACE, a raw newline.
  const bad = ['\u202e', '\u2028', '\u200b', '\n'];

  const noLinks = () => ({ isSymbolicLink: () => false });

  it.each(bad)('the driver refuses %j in a host path', (ch) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts[0].hostPath = `/install/data/v2-sessions/g1/s1${ch}x`;
    expect(() => assertHostMounts(spec, noLinks)).toThrow(/control or format characters/);
  });

  it.each(bad)('the driver refuses %j in a container path', (ch) => {
    const spec = fixtureSpec();
    spec.containers[0].mounts[0].containerPath = `/work${ch}space`;
    expect(() => assertHostMounts(spec, noLinks)).toThrow(/control or format characters/);
  });

  it('the refusal does not echo the path (it would print the characters it refuses)', () => {
    const spec = fixtureSpec();
    spec.containers[0].mounts[0].hostPath = '/install/data/v2-sessions/g1/s1\u202eevil';
    expect(() => assertHostMounts(spec, noLinks)).toThrow(/^(?!.*\u202e).*$/s);
  });

  it.each(bad)('assertPolicyPath refuses %j', (ch) => {
    expect(() => assertPolicyPath(`/workspace${ch}`, 'containerPath')).toThrow(/control or format characters/);
  });

  it('ordinary non-ASCII stays allowed', () => {
    expect(() => assertPolicyPath('/workspace/extra/café-数据', 'containerPath')).not.toThrow();
  });
});

describe('Docker bind access and Landlock policy come from one rule', () => {
  const container = (mounts: MountSpec[]): ContainerSpec => ({ role: 'agent', image: 'x', env: {}, mounts });
  const mount = (over: Partial<MountSpec>): MountSpec => ({
    class: 'group-state',
    hostPath: '/install/data/v2-sessions/g1/s1',
    containerPath: '/workspace',
    mode: 'rw',
    groupScope: 'g1',
    ...over,
  });

  it('a gateway-trust mount claiming rw is refused by the bind list too (it used to come out writable)', () => {
    const c = container([mount({ class: 'gateway-trust', containerPath: '/run/trust', mode: 'rw' })]);
    expect(() => compileDriverConfig(c)).toThrow(/denied-by-policy: gateway-trust mount .* must be ro/);
    expect(() => compilePolicy(fixtureSpec(), c)).toThrow(/must be ro/);
  });

  it('a mode that is neither ro nor rw is read-only in BOTH artifacts (never writable by default)', () => {
    const c = container([mount({ mode: 'RW' as unknown as 'rw' })]);
    expect(compileDriverConfig(c)!.docker.mounts[0].read_only).toBe(true);
    const policy = compilePolicy(fixtureSpec(), c);
    expect(policy.filesystem_policy.read_only).toContain('/workspace');
    expect(policy.filesystem_policy.read_write).not.toContain('/workspace');
  });

  it('the real fixture: the two artifacts agree', () => {
    const spec = fixtureSpec();
    const agent = spec.containers[0];
    expect(() => assertDriverConfigMatchesPolicy(compilePolicy(spec, agent), compileDriverConfig(agent))).not.toThrow();
  });

  it('a crafted divergence (bind writable, policy read_only) is caught, not passed through', () => {
    const spec = fixtureSpec();
    const agent = spec.containers[0];
    const policy = compilePolicy(spec, agent);
    const config = compileDriverConfig(agent) as DriverConfig;
    const appSrc = config.docker.mounts.find((b) => b.target === '/app/src')!;
    appSrc.read_only = false;
    expect(() => assertDriverConfigMatchesPolicy(policy, config)).toThrow(
      'bind target /app/src is writable in the Docker config but read_only in the sandbox policy',
    );
  });

  it('and the reverse (bind read-only, policy read_write)', () => {
    const spec = fixtureSpec();
    const agent = spec.containers[0];
    const policy = compilePolicy(spec, agent);
    const config = compileDriverConfig(agent) as DriverConfig;
    config.docker.mounts.find((b) => b.target === '/workspace')!.read_only = true;
    expect(() => assertDriverConfigMatchesPolicy(policy, config)).toThrow(
      /read-only in the Docker config but read_write/,
    );
  });

  it('a bind target the policy never mentions is caught', () => {
    const spec = fixtureSpec();
    const policy = compilePolicy(spec, spec.containers[0]);
    const config: DriverConfig = {
      docker: { mounts: [{ type: 'bind', source: '/x', target: '/elsewhere', read_only: true }] },
    };
    expect(() => assertDriverConfigMatchesPolicy(policy, config)).toThrow(/missing from the sandbox filesystem policy/);
  });
});
