import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import {
  DEFAULT_UI_PORT,
  UI_SERVER_RELATIVE,
  chooseUiPort,
  disableUi,
  enableUi,
  parseUiArgs,
  renderUiUnit,
  run,
  uiUnitLocation,
  uiUnitName,
} from './openshell-ui.js';

let root: string;
let home: string;
let previous: string;

beforeEach(() => {
  previous = process.cwd();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-step-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'os-ui-home-'));
  fs.mkdirSync(path.join(root, path.dirname(UI_SERVER_RELATIVE)), { recursive: true });
  fs.writeFileSync(path.join(root, UI_SERVER_RELATIVE), '// server\n');
  process.chdir(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(previous);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('unit file', () => {
  it('mirrors the NanoClaw service unit: tsx loader by absolute URL, WorkingDirectory, HOME/PATH, logs', () => {
    const unit = renderUiUnit({ projectRoot: '/srv/nc', nodePath: '/usr/bin/node', homeDir: '/home/op', root: false });
    expect(unit).toContain(
      `ExecStart=/usr/bin/node --import file:///srv/nc/node_modules/tsx/dist/loader.mjs /srv/nc/${UI_SERVER_RELATIVE}`,
    );
    expect(unit).toContain('WorkingDirectory=/srv/nc\nRestart=always');
    expect(unit).toContain(
      'Environment=HOME=/home/op\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin:/home/op/.local/bin',
    );
    expect(unit).toContain('StandardOutput=append:/srv/nc/logs/openshell-ui.log');
    expect(unit).toContain('WantedBy=default.target');
    expect(renderUiUnit({ projectRoot: '/srv/nc', nodePath: '/n', homeDir: '/root', root: true })).toContain(
      'WantedBy=multi-user.target',
    );
  });

  it('lives where setup/service.ts puts units, under a name peer-cleanup will not treat as a NanoClaw peer', () => {
    const user = uiUnitLocation('/srv/nc', { root: false, home: '/home/op' });
    expect(user.unit).toMatch(/^openshell-setup-ui-[0-9a-f]{8}$/);
    expect(user.unitPath).toBe(`/home/op/.config/systemd/user/${user.unit}.service`);
    expect(user.systemctl).toEqual(['systemctl', '--user']);
    expect(uiUnitLocation('/srv/nc', { root: true }).unitPath).toBe(`/etc/systemd/system/${user.unit}.service`);
    // setup/peer-cleanup.ts disables unhealthy `nanoclaw*.service` units that are not this install's own.
    expect(`${uiUnitName('/srv/nc')}.service`).not.toMatch(/^nanoclaw.*\.service$/);
  });
});

describe('arguments and port choice', () => {
  it('parses --enable / --disable / --port', () => {
    expect(parseUiArgs(['--enable', '--port', '9001'])).toEqual({ enable: true, port: 9001 });
    expect(parseUiArgs(['--disable'])).toEqual({ enable: false });
    expect(() => parseUiArgs(['--port', 'abc'])).toThrow(/not a TCP port/);
    expect(() => parseUiArgs(['--bogus'])).toThrow(/Unknown/);
  });

  it('default / configured / explicit, moving off a port someone else holds', async () => {
    const free = (busy: number[]) => async (p: number) => !busy.includes(p);
    expect(await chooseUiPort({ ownUnitActive: false, isFree: free([]) })).toEqual({ port: DEFAULT_UI_PORT });
    expect(await chooseUiPort({ configured: 9100, ownUnitActive: false, isFree: free([]) })).toEqual({ port: 9100 });
    expect(await chooseUiPort({ ownUnitActive: false, isFree: free([8790, 8791]) })).toEqual({
      port: 8792,
      moved: 8790,
    });
    // Re-running on a live install: our own UI holds the configured port — keep it.
    expect(await chooseUiPort({ configured: 9100, ownUnitActive: true, isFree: free([9100]) })).toEqual({ port: 9100 });
    await expect(chooseUiPort({ requested: 9200, ownUnitActive: false, isFree: free([9200]) })).rejects.toThrow(
      /in use/,
    );
  });
});

describe('enable / disable', () => {
  const deps = (calls: string[][], active = true) => ({
    systemctl: (args: string[]) => {
      calls.push(args);
      if (args[0] === 'is-active' && !active) throw new Error('inactive');
    },
    isFree: async () => true,
    waitListening: async () => true,
    serviceManager: () => 'systemd',
    loc: uiUnitLocation(root, { root: false, home }),
    hostname: () => 'bob-lab',
  });

  it('writes the unit, records the port, then daemon-reload → enable → restart, and reports the URL', async () => {
    const calls: string[][] = [];
    const d = deps(calls);
    const result = await enableUi(root, 9001, d);
    expect(result).toMatchObject({ port: 9001, listening: true, active: true, url: 'http://bob-lab:9001/' });
    expect(fs.readFileSync(d.loc.unitPath, 'utf8')).toContain(`WorkingDirectory=${root}`);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('NANOCLAW_OPENSHELL_UI_PORT=9001\n');
    expect(calls.filter((c) => c[0] !== 'is-active')).toEqual([
      ['daemon-reload'],
      ['enable', d.loc.unit],
      ['restart', d.loc.unit],
    ]);
  });

  it('refuses without systemd, and when the UI server is missing', async () => {
    await expect(enableUi(root, undefined, { ...deps([]), serviceManager: () => 'launchd' })).rejects.toThrow(
      /systemd/,
    );
    fs.rmSync(path.join(root, UI_SERVER_RELATIVE));
    await expect(enableUi(root, undefined, deps([]))).rejects.toThrow(/UI server not found/);
  });

  it('disable stops, disables and removes the unit', async () => {
    const calls: string[][] = [];
    const d = deps(calls);
    await enableUi(root, 9001, d);
    calls.length = 0;
    expect(disableUi(root, d)).toMatchObject({ removed: true });
    expect(fs.existsSync(d.loc.unitPath)).toBe(false);
    expect(calls).toEqual([['disable', '--now', d.loc.unit], ['daemon-reload']]);
  });

  it('opt-in: unanswered without a TTY declines and writes nothing', async () => {
    await run([]);
    expect(fs.existsSync(path.join(root, '.env'))).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('STATUS: skipped'));
  });
});
