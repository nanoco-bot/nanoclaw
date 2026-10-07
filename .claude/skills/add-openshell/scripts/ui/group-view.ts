/**
 * Per-agent-group views for the setup UI, as pure functions: which sandbox a
 * group's "Pending approvals" tab looks at, and the group's audit log merged
 * from the two existing logs. No I/O here; routes.ts feeds them.
 */
import type { DecisionRecord, HistoryEntry } from './history.js';

export interface GroupSummary {
  id: string;
  name: string;
  folder: string;
}

export interface SessionSummary {
  id: string;
  status: string;
  container_status: string;
  created_at: string;
}

export interface SandboxCandidate {
  sandbox: string;
  sessionId: string;
  createdAt: string;
  containerStatus: string;
}

/**
 * The group's live sandboxes, default first. A group can have several live
 * sessions (one per conversation/thread), each its own OpenShell sandbox.
 * Default: the most recently created ACTIVE session whose container is
 * running; failing that, the most recently created active session. Closed
 * sessions are not candidates. The UI offers the rest as a plain select.
 */
export function sandboxCandidates(
  sessions: readonly SessionSummary[],
  sandboxOf: (sessionId: string) => string,
): SandboxCandidate[] {
  return sessions
    .filter((s) => s.status === 'active')
    .sort(
      (a, b) =>
        Number(b.container_status === 'running') - Number(a.container_status === 'running') ||
        b.created_at.localeCompare(a.created_at),
    )
    .map((s) => ({
      sandbox: sandboxOf(s.id),
      sessionId: s.id,
      createdAt: s.created_at,
      containerStatus: s.container_status,
    }));
}

/** One line of a policy change log record (src/cli/resources/openshell-change-log.ts), as read from disk. */
export interface ChangeRecord {
  ts: string;
  verb: string;
  caller?: string;
  sandbox?: string;
  group?: { id: string; folder?: string };
  command?: string[];
  ok: boolean;
  error?: string;
  preset?: { name: string; version: number; rule: string };
  provider?: { name: string; type?: string | null; credentialKeys?: string[] };
  rule?: { name: string; host?: string; ports?: number[]; binaries?: string[] };
}

export interface AuditEntry {
  ts?: string;
  /** Which log it came from: the ncl change log, this UI's decision log, or OpenShell's own listing. */
  source: 'change-log' | 'decision-log' | 'openshell';
  action: string;
  outcome: 'approved' | 'rejected' | 'applied' | 'failed';
  sandbox?: string;
  detail: string;
  actor?: string;
  error?: string;
}

function changeDetail(r: ChangeRecord): string {
  if (r.preset) return `preset ${r.preset.name} v${r.preset.version} · rule ${r.preset.rule}`;
  if (r.provider) {
    const keys = r.provider.credentialKeys?.length ? ` · keys ${r.provider.credentialKeys.join(', ')}` : '';
    return `provider ${r.provider.name}${r.provider.type ? ` (${r.provider.type})` : ''}${keys}`;
  }
  if (r.rule) {
    const where = r.rule.host ? ` ${r.rule.host}:${(r.rule.ports ?? []).join(',')}` : '';
    return `network path ${r.rule.name}${where}`;
  }
  return r.command ? `openshell ${r.command.join(' ')}` : '';
}

/**
 * The group's audit log: policy/provider/network changes (change log) and
 * approve/reject decisions (UI decision log, plus OpenShell-reported ones the
 * log has no record of), approved AND denied/failed alike, newest first.
 * A record belongs to the group when it names the group, or names one of the
 * group's sandboxes (any of its sessions, past or present).
 */
export function groupAudit(input: {
  group: GroupSummary;
  sandboxes: ReadonlySet<string>;
  changes: readonly ChangeRecord[];
  decisions: readonly (DecisionRecord & { group?: { id: string } })[];
  /** OpenShell-only decisions (history.ts mergeHistory, source 'openshell'). */
  remote?: readonly HistoryEntry[];
}): AuditEntry[] {
  const mine = (r: { group?: { id: string }; sandbox?: string }) =>
    r.group?.id === input.group.id || (r.sandbox !== undefined && input.sandboxes.has(r.sandbox));
  const entries: AuditEntry[] = [];
  for (const r of input.changes) {
    if (!mine(r)) continue;
    entries.push({
      ts: r.ts,
      source: 'change-log',
      action: r.verb,
      outcome: r.ok ? 'applied' : 'failed',
      ...(r.sandbox ? { sandbox: r.sandbox } : {}),
      detail: changeDetail(r),
      ...(r.caller ? { actor: r.caller } : {}),
      ...(r.error ? { error: r.error } : {}),
    });
  }
  for (const d of input.decisions) {
    if (!mine(d)) continue;
    entries.push({
      ts: d.ts,
      source: 'decision-log',
      action: d.decision === 'approved' ? 'approve' : 'reject',
      outcome: d.ok ? d.decision : 'failed',
      sandbox: d.sandbox,
      detail: `chunk ${d.chunkId}${d.reason ? ` · ${d.reason}` : ''}`,
      actor: d.actor,
      ...(d.error ? { error: d.error } : {}),
    });
  }
  entries.sort((a, b) => (b.ts ?? '').localeCompare(a.ts ?? ''));
  for (const h of input.remote ?? []) {
    if (h.source !== 'openshell' || !input.sandboxes.has(h.sandbox)) continue;
    entries.push({
      source: 'openshell',
      action: h.decision === 'approved' ? 'approve' : 'reject',
      outcome: h.decision === 'approved' ? 'approved' : 'rejected',
      sandbox: h.sandbox,
      detail: `chunk ${h.chunkId}${h.rule ? ` · ${h.rule}` : ''}`,
      actor: 'openshell (outside NanoClaw)',
    });
  }
  return entries;
}
