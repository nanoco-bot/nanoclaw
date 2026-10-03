/**
 * Current WhatsApp Web version for the whatsapp-auth step. WhatsApp rejects
 * the stale version bundled in Baileys (405) before a QR or pairing code
 * appears, so this never falls back to it.
 */

export type WaWebVersion = [number, number, number];

/** Baileys' `fetchLatestWaWebVersion`: on failure it resolves with its bundled version and `isLatest: false`. */
export type SwJsLookup = (init: {
  signal: AbortSignal;
}) => Promise<{ version: WaWebVersion; isLatest: boolean; error?: unknown }>;

const TRACKER_URL = 'https://wppconnect.io/whatsapp-versions/';
const LOOKUP_TIMEOUT_MS = 5000;

/** wppconnect's tracker first (web.whatsapp.com rate-limits sw.js with 429s), then sw.js, then a clear error. */
export async function resolveWaWebVersion(lookupSwJs: SwJsLookup): Promise<WaWebVersion> {
  let trackerProblem: string;
  try {
    const res = await fetch(TRACKER_URL, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (res.ok) {
      // The page lists the current version first, possibly with a suffix such as -alpha.
      const match = (await res.text()).match(/2\.3000\.(\d+)/);
      if (match) return [2, 3000, Number(match[1])];
      trackerProblem = 'no version on the page';
    } else {
      trackerProblem = `HTTP ${res.status}`;
    }
  } catch (err) {
    trackerProblem = describe(err);
  }

  let swJsProblem: string;
  try {
    const { version, isLatest, error } = await lookupSwJs({ signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (isLatest) return version;
    swJsProblem = describe(error);
  } catch (err) {
    swJsProblem = describe(err);
  }

  throw new Error(
    `Could not get the current WhatsApp Web version (wppconnect.io: ${trackerProblem}; web.whatsapp.com: ${swJsProblem}). ` +
      'WhatsApp rejects the older version built into Baileys, so linking would fail. ' +
      'Check that this machine can reach both sites, then run the step again in a few minutes.',
  );
}

/** One line for the status block: Baileys' HTTP status, else the message plus any network error code. */
function describe(err: unknown): string {
  const e = err as { message?: unknown; output?: { statusCode?: unknown }; cause?: { code?: unknown } } | undefined;
  if (typeof e?.output?.statusCode === 'number') return `HTTP ${e.output.statusCode}`;
  const message = typeof e?.message === 'string' && e.message ? e.message : 'unknown error';
  const code = typeof e?.cause?.code === 'string' ? ` (${e.cause.code})` : '';
  return `${message}${code}`.replace(/\s+/g, ' ');
}
