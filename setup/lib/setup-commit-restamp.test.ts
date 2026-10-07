/**
 * Issue: the service step stamps the upgrade marker, then a channel skill
 * applied later (pairing, init-first-agent) commits `setup: apply <skill>`,
 * moving HEAD — and the first `systemctl --user restart` after setup stopped at
 * the upgrade tripwire. withSetupCommit now carries a sanctioned marker across
 * setup's own commit.
 *
 * Runs against a real Git checkout and the real boot gate
 * (enforceUpgradeTripwire), with the marker under that checkout's data/.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
let previous: string;

const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

async function modules() {
  // upgrade-state resolves its marker path from process.cwd() at import time.
  vi.resetModules();
  const upgrade = await import('../../src/upgrade-state.js');
  const commit = await import('./setup-commit.js');
  return { ...upgrade, ...commit };
}

/** What the host does on boot: exits 1 when the tripwire trips. */
function boots(enforce: () => void): boolean {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('tripwire');
  }) as typeof process.exit);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    enforce();
    return true;
  } catch {
    return false;
  } finally {
    exit.mockRestore();
  }
}

/** A channel skill applied after the service step: new files + a barrel line. */
const applyTelegram = async () => {
  mkdirSync(join(root, 'src', 'channels'), { recursive: true });
  writeFileSync(join(root, 'src', 'channels', 'telegram.ts'), 'export const telegram = 1;\n');
  writeFileSync(join(root, 'src', 'channels', 'index.ts'), "import './telegram.js';\n");
};

beforeEach(() => {
  previous = process.cwd();
  root = mkdtempSync(join(tmpdir(), 'restamp-'));
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'package.json'), '{"name":"nanoclaw","version":"2026.10.0-rc.1"}\n');
  writeFileSync(join(root, '.gitignore'), 'data/\n.env\n');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  process.chdir(root);
});
afterEach(() => {
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('upgrade marker across setup’s own skill commits', () => {
  it('service step stamps, a channel skill commits later, the next restart still boots', async () => {
    const m = await modules();
    m.writeUpgradeState({ via: 'setup' }); // setup/service.ts, before the first start
    expect(boots(m.enforceUpgradeTripwire)).toBe(true);
    const before = git('rev-parse', 'HEAD');

    await m.withSetupCommit(root, 'add-telegram', applyTelegram, () => {});

    expect(git('rev-parse', 'HEAD')).not.toBe(before);
    expect(git('log', '-1', '--format=%s')).toBe('setup: apply add-telegram');
    expect(m.readUpgradeState()).toMatchObject({ commit: git('rev-parse', 'HEAD'), via: 'setup: apply add-telegram' });
    expect(boots(m.enforceUpgradeTripwire)).toBe(true);
  });

  it('control: the same commit without the re-stamp is exactly the crash loop that was reported', async () => {
    const m = await modules();
    m.writeUpgradeState({ via: 'setup' });
    const snapshot = m.snapshotTree(root);
    await applyTelegram();
    expect(m.commitSetupChanges(root, snapshot, 'setup: apply add-telegram').committed.length).toBeGreaterThan(0);
    expect(boots(m.enforceUpgradeTripwire)).toBe(false);
  });

  it('never creates a marker where none existed (before the service step)', async () => {
    const m = await modules();
    await m.withSetupCommit(root, 'add-telegram', applyTelegram, () => {});
    expect(m.readUpgradeState()).toBeNull();
  });

  it('does not launder a checkout that was already off the sanctioned path', async () => {
    const m = await modules();
    m.writeUpgradeState({ via: 'setup' });
    writeFileSync(join(root, 'local.txt'), 'raw edit\n'); // a commit outside setup
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'raw');
    expect(boots(m.enforceUpgradeTripwire)).toBe(false);

    await m.withSetupCommit(root, 'add-telegram', applyTelegram, () => {});
    expect(boots(m.enforceUpgradeTripwire)).toBe(false);
  });

  it('a skill apply that changes nothing makes no commit and leaves the marker alone', async () => {
    const m = await modules();
    const stamped = m.writeUpgradeState({ via: 'setup' });
    await m.withSetupCommit(
      root,
      'noop',
      async () => {},
      () => {},
    );
    expect(m.readUpgradeState()).toEqual(stamped);
  });
});
