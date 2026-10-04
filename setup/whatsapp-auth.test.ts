import { EventEmitter } from 'events';
import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Baileys and pino are installed by /add-whatsapp, not by trunk, so both are mocked.
const sockets: Array<{ ev: EventEmitter; end: ReturnType<typeof vi.fn>; user?: { id: string } }> = [];
vi.mock('@whiskeysockets/baileys', () => ({
  makeWASocket: vi.fn(() => {
    const ev = new EventEmitter();
    // Like Baileys, end() emits the close synchronously.
    const end = vi.fn(() =>
      ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: undefined } }),
    );
    const sock = { ev, end, user: { id: '14155551234:7@s.whatsapp.net' } };
    sockets.push(sock);
    return sock;
  }),
  Browsers: { macOS: (browser: string) => ['Mac OS', browser, '14.4.1'] },
  DisconnectReason: { loggedOut: 401, timedOut: 408 },
  fetchLatestWaWebVersion: vi.fn(),
  makeCacheableSignalKeyStore: vi.fn(() => ({})),
  useMultiFileAuthState: vi.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: vi.fn() })),
}));
vi.mock('pino', () => ({ pino: () => ({}) }));
vi.mock('./whatsapp-auth-version.js', () => ({ resolveWaWebVersion: vi.fn() }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

const { run } = await import('./whatsapp-auth.js');
const { makeWASocket } = await import('@whiskeysockets/baileys');
const { resolveWaWebVersion } = await import('./whatsapp-auth-version.js');
const { emitStatus } = await import('./status.js');

class Exit extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${code})`);
  }
}

function blocks(): Array<[string, Record<string, unknown>]> {
  return vi.mocked(emitStatus).mock.calls as Array<[string, Record<string, unknown>]>;
}

async function connected(): Promise<(typeof sockets)[number]> {
  void run(['--method', 'qr']).catch(() => {});
  await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(1));
  return sockets[0];
}

beforeEach(() => {
  sockets.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Exit(code);
  });
  vi.mocked(resolveWaWebVersion).mockResolvedValue([2, 3000, 1049214511]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('whatsapp-auth step', () => {
  it('reports a failed version lookup as its own block before creating anything', async () => {
    vi.mocked(resolveWaWebVersion).mockRejectedValue(new Error('Could not fetch current WhatsApp Web version (...)'));

    await expect(run(['--method', 'qr'])).rejects.toThrow('process.exit(1)');
    expect(blocks()).toEqual([
      ['WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'Could not fetch current WhatsApp Web version (...)' }],
    ]);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(makeWASocket).not.toHaveBeenCalled();
  });

  it('fails at once with the reason when WhatsApp refuses the connection', async () => {
    const sock = await connected();
    const refused = Object.assign(new Error('Connection Failure'), { output: { statusCode: 405 } });

    expect(() =>
      sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: refused } }),
    ).toThrow('process.exit(1)');
    expect(blocks()).toEqual([
      [
        'WHATSAPP_AUTH',
        {
          STATUS: 'failed',
          ERROR:
            'WhatsApp closed the connection before linking (405 Connection Failure, WhatsApp Web 2.3000.1049214511). Clear store/auth/ and run the step again.',
        },
      ],
    ]);
  });

  it('does not report its own close after a successful link as a failure', async () => {
    const sock = await connected();

    sock.ev.emit('connection.update', { connection: 'open' });
    expect(sock.end).toHaveBeenCalled();

    expect(blocks()).toEqual([['WHATSAPP_AUTH', { STATUS: 'success', PHONE: '14155551234' }]]);
    expect(() => vi.advanceTimersByTime(1000)).toThrow('process.exit(0)');
  });

  it('reconnects with the same version after the 515 restart', async () => {
    const sock = await connected();
    const restart = Object.assign(new Error('Stream Errored (restart required)'), { output: { statusCode: 515 } });

    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: restart } });
    await vi.waitFor(() => expect(makeWASocket).toHaveBeenCalledTimes(2));

    expect(vi.mocked(makeWASocket).mock.calls.map(([config]) => config.version)).toEqual([
      [2, 3000, 1049214511],
      [2, 3000, 1049214511],
    ]);
    expect(resolveWaWebVersion).toHaveBeenCalledTimes(1);
    expect(blocks()).toEqual([]);
  });
});
