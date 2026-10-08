import { describe, expect, it } from 'vitest';

import { FIXTURE_POLICY, fixtureSpec } from '../spec-fixture.js';
import { validateSpec, type DriverCapabilities } from '../types.js';
import { OpenShellSessionDriver } from './driver.js';
import { FakeOpenShellCli, quietLogger } from './fake-cli.js';

const driver = () =>
  new OpenShellSessionDriver({ ...FIXTURE_POLICY, cli: new FakeOpenShellCli(), logger: quietLogger });

describe('capabilities() is honest', () => {
  it('declares exactly what this realization can and cannot do', () => {
    expect(driver().capabilities()).toEqual({
      isolationTiers: ['container'],
      admissionEnforced: false, // NanoClaw runs with the gateway's resource_admission off
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      unrealized: ['pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      auxiliaryContainers: false,
      imageBuild: false,
      watchMode: 'polling', // watchSessions polls; it is not an event stream
    });
  });

  it('is assignable to the DriverCapabilities contract', () => {
    const caps: DriverCapabilities = driver().capabilities();
    expect(caps.admissionEnforced).toBe(false);
  });

  it('does not overclaim admission (same as the shipped Docker driver)', () => {
    expect(driver().capabilities().admissionEnforced).toBe(false);
  });

  it('names every SessionResources field it cannot realize', () => {
    const { unrealized } = driver().capabilities();
    expect(unrealized).toContain('pidsLimit');
    expect(unrealized).toContain('shmSizeMb');
    expect(unrealized).not.toContain('memoryMb'); // --memory
    expect(unrealized).not.toContain('cpus'); // --cpu
  });

  it("drives core's tier gate: 'container' accepted, 'vm' refused", () => {
    const caps = driver().capabilities();
    expect(() => validateSpec(fixtureSpec(), FIXTURE_POLICY, caps)).not.toThrow();
    expect(() => validateSpec(fixtureSpec({ runtimeTier: 'vm' }), FIXTURE_POLICY, caps)).toThrow(
      /spec-invalid: runtimeTier 'vm'/,
    );
  });

  it('kind is for logs only', () => {
    expect(driver().kind).toBe('openshell');
  });
});
