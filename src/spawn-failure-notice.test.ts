import { describe, expect, it } from 'vitest';

import {
  NOTICE_REPEAT_MS,
  clearSpawnFailure,
  recordSpawnFailure,
  takeSpawnFailureNotice,
  userMessageOf,
} from './spawn-failure-notice.js';

describe('spawn-failure notices', () => {
  it('only errors that carry a userMessage are user-facing', () => {
    expect(userMessageOf(Object.assign(new Error('x'), { userMessage: ' No credential. ' }))).toBe('No credential.');
    expect(userMessageOf(new Error('docker exploded'))).toBeUndefined();
    expect(userMessageOf(null)).toBeUndefined();
    recordSpawnFailure('s0', new Error('internal'));
    expect(takeSpawnFailureNotice('s0')).toBeUndefined();
  });

  it('posts once, then stays quiet through host-sweep retries until the repeat window passes', () => {
    const err = Object.assign(new Error('x'), { userMessage: 'No credential.' });
    recordSpawnFailure('s1', err);
    expect(takeSpawnFailureNotice('s1', 1_000)).toBe('No credential.');
    recordSpawnFailure('s1', err); // sweep retry, same failure
    expect(takeSpawnFailureNotice('s1', 2_000)).toBeUndefined();
    expect(takeSpawnFailureNotice('s1', 1_000 + NOTICE_REPEAT_MS)).toBe('No credential.');
  });

  it('a different message is new news; a successful spawn clears it', () => {
    recordSpawnFailure('s2', Object.assign(new Error(), { userMessage: 'A' }));
    expect(takeSpawnFailureNotice('s2', 0)).toBe('A');
    recordSpawnFailure('s2', Object.assign(new Error(), { userMessage: 'B' }));
    expect(takeSpawnFailureNotice('s2', 1)).toBe('B');
    clearSpawnFailure('s2');
    expect(takeSpawnFailureNotice('s2', 2)).toBeUndefined();
  });
});
