/**
 * Approve/reject history.
 *
 * NanoClaw and the `openshell` CLI keep no audit log of policy decisions, so
 * the UI writes its own: one JSON line per approve/reject it performs,
 * appended to `data/openshell-setup-ui/decisions.jsonl` (owner-only, never
 * rewritten). That file is the source of truth for what the UI did. It lives
 * in `data/`, so it does not survive a wipe of the install's state — accepted
 * for v1.
 *
 * Decisions made elsewhere (plain `ncl`/`openshell`) are merged in best-effort
 * from OpenShell's own `rule get --status approved|rejected` listings, which
 * carry no timestamp or actor.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { RuleChunk } from './commands.js';

export const ACTOR = 'openshell-setup-ui';

export interface DecisionRecord {
  ts: string;
  sandbox: string;
  chunkId: string;
  decision: 'approved' | 'rejected';
  reason?: string;
  /** Whether OpenShell accepted the decision; failed attempts are logged too. */
  ok: boolean;
  error?: string;
  actor: string;
  /** The agent group the decision was made for, when made from a group tab. */
  group?: { id: string; folder: string };
}

export interface HistoryEntry {
  ts?: string;
  sandbox: string;
  chunkId: string;
  decision: string;
  reason?: string;
  ok?: boolean;
  error?: string;
  actor?: string;
  rule?: string;
  /** 'ui-log' = this UI's own record; 'openshell' = seen only in OpenShell's listings. */
  source: 'ui-log' | 'openshell';
}

export function decisionLogPath(dataDir: string): string {
  return path.join(dataDir, 'openshell-setup-ui', 'decisions.jsonl');
}

export function appendDecision(file: string, record: DecisionRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** All parseable records, oldest first; a torn or foreign line is skipped, not fatal. */
export function readDecisions(file: string): DecisionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: DecisionRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as DecisionRecord;
      if (r && typeof r.sandbox === 'string' && typeof r.chunkId === 'string' && typeof r.decision === 'string')
        out.push(r);
    } catch {
      // skip
    }
  }
  return out;
}

/**
 * Newest UI records first, then OpenShell-only decisions the UI log has no
 * successful record of (same sandbox + chunk + decision).
 */
export function mergeHistory(
  local: DecisionRecord[],
  remote: { sandbox: string; approved: RuleChunk[]; rejected: RuleChunk[] } | undefined,
  sandbox?: string,
): HistoryEntry[] {
  const mine = local.filter((r) => !sandbox || r.sandbox === sandbox);
  const entries: HistoryEntry[] = mine
    .slice()
    .reverse()
    .map((r) => ({ ...r, source: 'ui-log' as const }));
  if (remote) {
    const known = new Set(mine.filter((r) => r.ok).map((r) => `${r.sandbox}\0${r.chunkId}\0${r.decision}`));
    for (const [decision, chunks] of [
      ['approved', remote.approved],
      ['rejected', remote.rejected],
    ] as const) {
      for (const c of chunks) {
        if (known.has(`${remote.sandbox}\0${c.chunkId}\0${decision}`)) continue;
        entries.push({
          sandbox: remote.sandbox,
          chunkId: c.chunkId,
          decision,
          ...(c.rule ? { rule: c.rule } : {}),
          source: 'openshell',
        });
      }
    }
  }
  return entries;
}
