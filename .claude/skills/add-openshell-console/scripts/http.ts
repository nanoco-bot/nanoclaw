/**
 * HTTP plumbing for the setup console: JSON responses, JSON-only request
 * bodies (a CSRF backstop — a cross-site form cannot send application/json
 * without a preflight this server never grants), and secret scrubbing.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY = 64 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'POST bodies must be application/json');
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    parts.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body is not a JSON object');
  }
}

/** Never echo a submitted secret back, even if a child process printed it. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

/** Run `build`; a thrown validation error is the client's (400). */
export function input<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}
