/**
 * Per-agent-group views for the setup console, as pure functions: which
 * sandboxes of a group can take a live change, newest running first.
 * No I/O here; routes.ts feeds them.
 */

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
