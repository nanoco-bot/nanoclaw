import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveWaWebVersion, type SwJsLookup, type WaWebVersion } from './whatsapp-auth-version.js';

const TRACKER_PAGE =
  '<h2>Current Version</h2><a>2.3000.1049101571-alpha</a>' +
  '<h2>All WhatsApp Versions</h2><a>2.3000.1049101571-alpha</a><a>2.3000.1049075336-alpha</a>';
const BUNDLED: WaWebVersion = [2, 3000, 1027934701];
const SW_JS: WaWebVersion = [2, 3000, 1049110567];

// Baileys reports a failed sw.js fetch as a Boom error carrying the HTTP status.
const swJs429 = Object.assign(new Error('Failed to fetch sw.js: Too Many Requests'), { output: { statusCode: 429 } });
const offline = new TypeError('fetch failed', {
  cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
});

function stubTracker(answer: Response | Error) {
  const fetch = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function swJsLookup(result: Awaited<ReturnType<SwJsLookup>> | Error) {
  return vi.fn<SwJsLookup>(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveWaWebVersion', () => {
  it('uses the current version from the wppconnect tracker without asking web.whatsapp.com', async () => {
    const fetch = stubTracker(new Response(TRACKER_PAGE));
    const lookup = swJsLookup({ version: SW_JS, isLatest: true });

    await expect(resolveWaWebVersion(lookup)).resolves.toEqual([2, 3000, 1049101571]);
    expect(fetch).toHaveBeenCalledWith('https://wppconnect.io/whatsapp-versions/', {
      signal: expect.any(AbortSignal),
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each([
    ['answers 429', new Response('Too Many Requests', { status: 429 })],
    ['answers 429 with a version in the page', new Response(TRACKER_PAGE, { status: 429 })],
    ['is unreachable', offline],
    ['page has no version', new Response('<html>maintenance</html>')],
  ])('falls back to sw.js when the tracker %s', async (_case, answer) => {
    stubTracker(answer);
    const lookup = swJsLookup({ version: SW_JS, isLatest: true });

    await expect(resolveWaWebVersion(lookup)).resolves.toEqual(SW_JS);
    expect(lookup).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
  });

  it("refuses Baileys' bundled version when both sources are rate-limited", async () => {
    stubTracker(new Response('Too Many Requests', { status: 429 }));
    // What Baileys resolves with when sw.js answers 429: no throw, just its stale default.
    const lookup = swJsLookup({ version: BUNDLED, isLatest: false, error: swJs429 });

    const err = await resolveWaWebVersion(lookup).then(
      (version) => {
        throw new Error(`expected a failure, got ${version.join('.')}`);
      },
      (e: Error) => e,
    );
    expect(err.message).toContain('Could not fetch current WhatsApp Web version');
    expect(err.message).toContain('wppconnect.io: HTTP 429; web.whatsapp.com: HTTP 429');
    expect(err.message).not.toContain('\n'); // the status block's ERROR field is one line
  });

  it('names a network failure on each source when the machine is offline', async () => {
    stubTracker(offline);
    const lookup = swJsLookup(offline);

    await expect(resolveWaWebVersion(lookup)).rejects.toThrow(
      'wppconnect.io: fetch failed (ENOTFOUND); web.whatsapp.com: fetch failed (ENOTFOUND)',
    );
  });

  it('names a timeout and the plain error Baileys returns when sw.js has no version', async () => {
    stubTracker(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const lookup = swJsLookup({
      version: BUNDLED,
      isLatest: false,
      error: { message: 'Could not find client revision in the fetched content' },
    });

    await expect(resolveWaWebVersion(lookup)).rejects.toThrow(
      'wppconnect.io: The operation was aborted due to timeout; web.whatsapp.com: Could not find client revision in the fetched content',
    );
  });
});
