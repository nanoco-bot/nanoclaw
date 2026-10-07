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

// ---------------------------------------------------------------------------
// Per-agent-group audit: every append-only log that can name the group
// ---------------------------------------------------------------------------

/** One line of `ncl openshell-policy add-rule|apply-preset`'s data/openshell-policy/changes.jsonl. */
export interface PolicyChangeLine {
  ts: string;
  verb: string;
  caller?: string;
  sandbox: string;
  command?: string[];
  ok: boolean;
  error?: string;
  preset?: { name: string; version: number; rule: string };
}

/** One line of `ncl openshell-provider-*`'s data/openshell-provider/changes.jsonl. */
export interface ProviderChangeLine {
  ts: string;
  verb: string;
  caller?: string;
  group?: string;
  provider?: string;
  ok: boolean;
  error?: string;
  persisted?: boolean;
  providers?: string[];
  live?: { sandbox: string; ok: boolean; error?: string }[];
}

export interface AuditEntry {
  ts?: string;
  /** network-decision: approve/reject; network-change: add-rule/apply-preset; provider: attach/detach. */
  kind: 'network-decision' | 'network-change' | 'provider';
  action: string;
  sandbox?: string;
  subject: string;
  ok?: boolean;
  detail?: string;
  actor?: string;
  source: 'ui-log' | 'policy-log' | 'provider-log' | 'openshell';
}

/** Every parseable JSON object line, oldest first; torn lines skipped. Generic over the three logs. */
export function readJsonl<T>(file: string, valid: (r: T) => boolean): T[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as T;
      if (r && typeof r === 'object' && valid(r)) out.push(r);
    } catch {
      // skip
    }
  }
  return out;
}

export const readPolicyChanges = (file: string) =>
  readJsonl<PolicyChangeLine>(file, (r) => typeof r.sandbox === 'string' && typeof r.verb === 'string');
export const readProviderChangeLines = (file: string) =>
  readJsonl<ProviderChangeLine>(file, (r) => typeof r.verb === 'string');

/**
 * The combined history of one agent group, newest first:
 *  - provider attach/detach whose `group` is the group's id;
 *  - network-rule decisions (this UI's approve/reject log) and direct network
 *    changes (add-rule / apply-preset) on any of the group's sandboxes —
 *    `sandboxes` is every sandbox name the group has had (one per session);
 *  - decisions OpenShell lists for the group's live sandboxes that no local
 *    log recorded (no timestamp or actor: made outside NanoClaw's tools).
 */
export function groupAudit(input: {
  groupId: string;
  sandboxes: ReadonlySet<string>;
  decisions: DecisionRecord[];
  policyChanges: PolicyChangeLine[];
  providerChanges: ProviderChangeLine[];
  openshellOnly?: HistoryEntry[];
}): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const r of input.providerChanges) {
    if (r.group !== input.groupId || (r.verb !== 'attach' && r.verb !== 'detach')) continue;
    const live = r.live ?? [];
    const liveText = live.length
      ? `live: ${live.map((l) => `${l.sandbox} ${l.ok ? 'ok' : `failed (${l.error ?? ''})`}`).join(', ')}`
      : 'no live sandbox';
    out.push({
      ts: r.ts,
      kind: 'provider',
      action: r.verb,
      subject: r.provider ?? '',
      ok: r.ok,
      detail: r.ok ? liveText : `${r.error ?? 'failed'}${r.persisted ? ' (group config was saved)' : ''}`,
      actor: r.caller,
      source: 'provider-log',
    });
  }
  for (const r of input.decisions) {
    if (!input.sandboxes.has(r.sandbox)) continue;
    out.push({
      ts: r.ts,
      kind: 'network-decision',
      action: r.decision,
      sandbox: r.sandbox,
      subject: r.chunkId,
      ok: r.ok,
      detail: r.ok ? r.reason : r.error,
      actor: r.actor,
      source: 'ui-log',
    });
  }
  for (const r of input.policyChanges) {
    if (!input.sandboxes.has(r.sandbox)) continue;
    out.push({
      ts: r.ts,
      kind: 'network-change',
      action: r.verb,
      sandbox: r.sandbox,
      subject: r.preset
        ? `${r.preset.name} v${r.preset.version} · ${r.preset.rule}`
        : (r.command ?? []).slice(3).join(' '),
      ok: r.ok,
      detail: r.ok ? undefined : r.error,
      actor: r.caller,
      source: 'policy-log',
    });
  }
  out.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  for (const h of input.openshellOnly ?? []) {
    out.push({
      kind: 'network-decision',
      action: h.decision,
      sandbox: h.sandbox,
      subject: h.rule ? `${h.chunkId} · ${h.rule}` : h.chunkId,
      source: 'openshell',
    });
  }
  return out;
}
