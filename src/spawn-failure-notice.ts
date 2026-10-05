/**
 * Spawn failures a person in the chat should hear about.
 *
 * A gateway (or core) marks an error user-facing by giving it a string
 * `userMessage`. `wakeContainer` records the last one per session; the router,
 * which holds the reply address, posts it — at most once per session per
 * message per NOTICE_REPEAT_MS, because host-sweep retries a failed wake on
 * every tick and a chat must not be spammed. Anything without a `userMessage`
 * stays log-only, exactly as before.
 */
export const NOTICE_REPEAT_MS = 10 * 60_000;

const notices = new Map<string, { message: string; noticedAt?: number }>();

export function userMessageOf(err: unknown): string | undefined {
  const message = (err as { userMessage?: unknown } | null)?.userMessage;
  return typeof message === 'string' && message.trim() ? message.trim() : undefined;
}

export function recordSpawnFailure(sessionId: string, err: unknown): void {
  const message = userMessageOf(err);
  if (!message) {
    notices.delete(sessionId);
    return;
  }
  const prior = notices.get(sessionId);
  if (prior?.message !== message) notices.set(sessionId, { message });
}

export function clearSpawnFailure(sessionId: string): void {
  notices.delete(sessionId);
}

/** The notice to post for this session's last failed wake, or undefined (none, or posted recently). */
export function takeSpawnFailureNotice(sessionId: string, now: number = Date.now()): string | undefined {
  const entry = notices.get(sessionId);
  if (!entry) return undefined;
  if (entry.noticedAt !== undefined && now - entry.noticedAt < NOTICE_REPEAT_MS) return undefined;
  entry.noticedAt = now;
  return entry.message;
}
