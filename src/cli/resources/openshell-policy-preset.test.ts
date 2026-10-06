/**
 * `ncl openshell-policy apply-preset` through the real dispatcher, against a
 * recording fake `openshell` CLI (no binary, no gateway): same argv as add-rule
 * by hand, provenance in the change log, dry run sends nothing, clean failures.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import type { OpenShellCli } from '../../drivers/openshell/cli.js';
import { setPresetsDir } from '../../drivers/openshell/preset-registry.js';
import { registerResourceHelpCommands } from '../commands/help.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import { listCommands } from '../registry.js';
import './index.js';
import { setOpenShellPolicyCli, setOpenShellPolicyLog, type PolicyChangeRecord } from './openshell-policy.js';

registerResourceHelpCommands();

const host: CallerContext = { caller: 'host' };
const agent: CallerContext = { caller: 'agent', sessionId: 's', agentGroupId: 'ag-1', messagingGroupId: 'mg' };

const TWO_RULES = `name: pair
version: 3
description: Two rules for the equivalence test.
rules:
  - name: pair_api
    host: api.example.com
    ports: [443]
    binaries: [/usr/local/bin/node]
  - name: pair_git
    host: git.example.com
    ports: [443]
    binaries: [/usr/bin/git, /usr/local/bin/bun]
`;

let tmp: string;
let logFile: string;
let calls: string[][];
let failOn: ((args: string[]) => boolean) | null;

function fakeCli(): OpenShellCli {
  return {
    bin: '/usr/bin/openshell',
    async run(args) {
      calls.push(args);
      if (failOn?.(args)) throw new Error('gateway said no');
      return `updated ${args[2]}`;
    },
  };
}

async function ok(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  const res = await dispatch({ id: 'r', command, args }, ctx);
  if (!res.ok) throw new Error(res.error.message);
  return res;
}
async function errorOf(command: string, args: Record<string, unknown>, ctx: CallerContext = host) {
  const res = await dispatch({ id: 'r', command, args }, ctx);
  return res.ok ? '' : res.error.message;
}
const logged = (): PolicyChangeRecord[] =>
  fs.existsSync(logFile)
    ? fs
        .readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : [];

beforeEach(async () => {
  await runMigrations(await initTestDb());
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'os-preset-cli-'));
  fs.mkdirSync(path.join(tmp, 'presets'));
  fs.writeFileSync(path.join(tmp, 'presets', 'pair.yaml'), TWO_RULES);
  logFile = path.join(tmp, 'log', 'changes.jsonl');
  calls = [];
  failOn = null;
  setOpenShellPolicyCli(fakeCli);
  setOpenShellPolicyLog(logFile);
  setPresetsDir(path.join(tmp, 'presets'));
});
afterEach(async () => {
  setOpenShellPolicyCli(null);
  setOpenShellPolicyLog(null);
  setPresetsDir(null);
  await closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ncl openshell-policy apply-preset', () => {
  it('is operator-only and approval-tier, like add-rule', async () => {
    const cmd = listCommands().find((c) => c.name === 'openshell-policy-apply-preset')!;
    const addRule = listCommands().find((c) => c.name === 'openshell-policy-add-rule')!;
    expect(cmd.hostOnly).toBe(true);
    expect(cmd.access).toBe(addRule.access);
    expect(cmd.access).toBe('approval');
    expect(await errorOf('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair' }, agent)).toMatch(
      /operator-only/,
    );
    expect(calls).toEqual([]);
  });

  it('a two-rule preset runs exactly the commands add-rule runs when given those two rules by hand', async () => {
    await ok('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair' });
    const viaPreset = calls;

    calls = [];
    await ok('openshell-policy-add-rule', {
      sandbox: 'ncl-abc',
      'add-endpoint': 'api.example.com:443',
      binary: '/usr/local/bin/node',
      'rule-name': 'pair_api',
    });
    await ok('openshell-policy-add-rule', {
      sandbox: 'ncl-abc',
      'add-endpoint': 'git.example.com:443',
      binary: JSON.stringify(['/usr/bin/git', '/usr/local/bin/bun']),
      'rule-name': 'pair_git',
    });

    expect(viaPreset).toEqual(calls);
    expect(viaPreset).toEqual([
      [
        'policy',
        'update',
        'ncl-abc',
        '--add-endpoint',
        'api.example.com:443',
        '--binary',
        '/usr/local/bin/node',
        '--rule-name',
        'pair_api',
      ],
      [
        'policy',
        'update',
        'ncl-abc',
        '--add-endpoint',
        'git.example.com:443',
        '--binary',
        '/usr/bin/git',
        '--binary',
        '/usr/local/bin/bun',
        '--rule-name',
        'pair_git',
      ],
    ]);
  });

  it('every applied rule lands in the change log like add-rule’s, plus the preset name and version', async () => {
    await ok('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair' });
    await ok('openshell-policy-add-rule', {
      sandbox: 'ncl-abc',
      'add-endpoint': 'x.example.com:443',
      binary: '/usr/bin/curl',
    });
    const records = logged();
    expect(records.map(({ ts: _ts, ...r }) => r)).toEqual([
      {
        verb: 'apply-preset',
        caller: 'host',
        sandbox: 'ncl-abc',
        preset: { name: 'pair', version: 3, rule: 'pair_api' },
        command: calls[0],
        ok: true,
      },
      {
        verb: 'apply-preset',
        caller: 'host',
        sandbox: 'ncl-abc',
        preset: { name: 'pair', version: 3, rule: 'pair_git' },
        command: calls[1],
        ok: true,
      },
      { verb: 'add-rule', caller: 'host', sandbox: 'ncl-abc', command: calls[2], ok: true },
    ]);
    for (const r of records) expect(Date.parse(r.ts)).not.toBeNaN();
    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('--dry-run prints the rules and commands and never calls the openshell CLI', async () => {
    const res = await ok('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair', 'dry-run': true });
    expect(calls).toEqual([]);
    expect(logged()).toEqual([]);
    expect(res.data).toMatchObject({ dryRun: true, applied: 0, preset: { name: 'pair', version: 3 } });
    expect(res.human).toContain('Dry run — nothing sent. Preset pair v3 → sandbox ncl-abc');
    expect(res.human).toContain('pair_git: git.example.com:443  (/usr/bin/git, /usr/local/bin/bun)');
    expect(res.human).toContain(
      'openshell policy update ncl-abc --add-endpoint api.example.com:443 --binary /usr/local/bin/node --rule-name pair_api',
    );
  });

  it('a nonexistent preset fails cleanly before anything runs', async () => {
    expect(await errorOf('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'nope' })).toBe(
      "unknown egress preset 'nope' (available: pair)",
    );
    expect(await errorOf('openshell-policy-apply-preset', { sandbox: 'ncl-abc' })).toMatch(/--preset is required/);
    expect(calls).toEqual([]);
    expect(logged()).toEqual([]);
  });

  it('a broken preset file fails cleanly before anything runs', async () => {
    fs.writeFileSync(path.join(tmp, 'presets', 'pair.yaml'), `${TWO_RULES}extra: 1\n`);
    expect(await errorOf('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair' })).toMatch(
      /pair\.yaml: root: unknown key 'extra'/,
    );
    expect(calls).toEqual([]);
  });

  it('a failure part-way says exactly what landed, and logs the failed attempt too', async () => {
    failOn = (args) => args.includes('git.example.com:443');
    expect(await errorOf('openshell-policy-apply-preset', { sandbox: 'ncl-abc', preset: 'pair' })).toBe(
      "preset pair v3: 1 of 2 change(s) applied before rule 'pair_git' failed: gateway said no",
    );
    expect(logged().map((r) => [r.preset?.rule, r.ok, r.error])).toEqual([
      ['pair_api', true, undefined],
      ['pair_git', false, 'gateway said no'],
    ]);
  });

  it('add-rule --dry-run (OpenShell’s own preview) is not logged: nothing changed', async () => {
    await ok('openshell-policy-add-rule', {
      sandbox: 'ncl-abc',
      'add-endpoint': 'x.example.com:443',
      binary: '/usr/bin/curl',
      'dry-run': true,
    });
    expect(calls).toHaveLength(1);
    expect(logged()).toEqual([]);
  });
});
