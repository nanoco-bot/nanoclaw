import { describe, expect, it } from 'vitest';

import { authRunsAfterService } from './step-order.js';

describe('authRunsAfterService', () => {
  it('only OpenShell on macOS moves auth after the service step', () => {
    expect(authRunsAfterService({ openshellEnabled: true, platform: 'macos' })).toBe(true);
    expect(authRunsAfterService({ openshellEnabled: true, platform: 'linux' })).toBe(false);
    expect(authRunsAfterService({ openshellEnabled: false, platform: 'macos' })).toBe(false);
    expect(authRunsAfterService({ openshellEnabled: false, platform: 'linux' })).toBe(false);
    expect(authRunsAfterService({ openshellEnabled: true, platform: 'unknown' })).toBe(false);
  });
});
