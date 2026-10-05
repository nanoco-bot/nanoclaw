/**
 * The registration seam: importing the overlay module registers 'openshell'
 * in NanoClaw's (vendored) driver registry, and the factory builds this driver
 * from the MountPolicy core hands it.
 */
import { describe, expect, it } from 'vitest';

import { getSessionDriverFactory, listSessionDriverKinds } from '../driver-registry.js';
import { FIXTURE_POLICY } from '../spec-fixture.js';
import { OpenShellSessionDriver } from './driver.js';
import { settingsFromEnv } from './settings.js';

describe('overlay registration', () => {
  it("registers kind 'openshell' on import", async () => {
    expect(getSessionDriverFactory('openshell')).toBeUndefined();
    await import('./register.js');
    expect(listSessionDriverKinds()).toContain('openshell');
    const driver = getSessionDriverFactory('openshell')!(FIXTURE_POLICY);
    expect(driver).toBeInstanceOf(OpenShellSessionDriver);
    expect(driver.kind).toBe('openshell');
  });

  it('a second registration of the same kind is a wiring bug and throws (registry contract)', async () => {
    const { registerSessionDriver } = await import('../driver-registry.js');
    expect(() => registerSessionDriver('openshell', () => null as never)).toThrow(/already registered: openshell/);
  });
});

describe('settingsFromEnv', () => {
  it('defaults to the verified shape and the `openshell` binary', () => {
    expect(settingsFromEnv({})).toEqual({ bin: 'openshell', policy: {} });
  });

  it('parses operator settings', () => {
    expect(
      settingsFromEnv({
        OPENSHELL_BIN: '/opt/openshell/bin/openshell',
        NANOCLAW_OPENSHELL_BASE_RO: '/usr, /bin,/lib,/lib64,/etc,/app',
        NANOCLAW_OPENSHELL_BASE_RW: '/tmp',
        NANOCLAW_OPENSHELL_LANDLOCK: 'hard_requirement',
        NANOCLAW_OPENSHELL_GATEWAY_PORTS: '10255',
        NANOCLAW_OPENSHELL_GATEWAY_BINARIES: '/usr/local/bin/bun,/usr/bin/node',
        NANOCLAW_OPENSHELL_GATEWAY_HOST: 'host.openshell.internal',
        NANOCLAW_OPENSHELL_POLL_MS: '5000',
      }),
    ).toEqual({
      bin: '/opt/openshell/bin/openshell',
      pollIntervalMs: 5000,
      policy: {
        baseReadOnly: ['/usr', '/bin', '/lib', '/lib64', '/etc', '/app'],
        baseReadWrite: ['/tmp'],
        landlockCompatibility: 'hard_requirement',
        gatewayEgress: {
          ports: [10255],
          binaries: ['/usr/local/bin/bun', '/usr/bin/node'],
          host: 'host.openshell.internal',
        },
      },
    });
  });

  it.each([
    [{ NANOCLAW_OPENSHELL_LANDLOCK: 'strict' }, /best_effort or hard_requirement/],
    [{ NANOCLAW_OPENSHELL_GATEWAY_PORTS: '10255' }, /must be set together/],
    [{ NANOCLAW_OPENSHELL_GATEWAY_PORTS: 'abc', NANOCLAW_OPENSHELL_GATEWAY_BINARIES: '/x' }, /must be TCP ports/],
    [{ NANOCLAW_OPENSHELL_POLL_MS: '10' }, />= 250/],
  ])('refuses bad settings %j', (env, re) => {
    expect(() => settingsFromEnv(env)).toThrow(re);
  });
});
