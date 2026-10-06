import { describe, expect, it } from 'vitest';

import { readVersionPin } from './version-pins.js';

describe('readVersionPin', () => {
  it('resolves an existing pin', () => {
    expect(readVersionPin('agent-image')).toContain('@sha256:');
  });

  it('pins the OpenShell release (a vX.Y.Z tag, read by setup/install-openshell.sh)', () => {
    expect(readVersionPin('openshell')).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('throws for a component with no pin', () => {
    expect(() => readVersionPin('no-such-component')).toThrow(/no pin/);
  });
});
