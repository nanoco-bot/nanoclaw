/**
 * Live fan-out for per-GROUP OpenShell changes (`ncl openshell-network
 * add/remove`, `ncl openshell-provider attach/detach`): after the durable
 * write, the same change is sent to every sandbox the group has running NOW
 * (sessions with container_status running/idle, as getRunningSessions defines
 * it).
 *
 * Best-effort and reported per sandbox: one sandbox failing neither stops the
 * others nor undoes the durable write, and there is no cross-sandbox rollback.
 * Calls are sequential, each with add-rule's 30 s CLI timeout.
 */
import { INSTALL_SLUG } from '../../config.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import { logChange, type ChangeVerb, type PolicyChangeRecord } from './openshell-change-log.js';
import { openShellCommandCli } from './openshell-policy.js';

/** add-rule's per-call CLI timeout (openshell-policy.ts runCli default). */
export const LIVE_TIMEOUT_MS = 30_000;

export interface LiveResult {
  sandbox: string;
  ok: boolean;
  error?: string;
}

/** One `openshell` argv for a sandbox; built inside the per-call try, so a validation error is that sandbox's error. */
export type LiveStep = (sandbox: string) => string[];

/** The group's running sandboxes: sessions whose container is running or idle (getRunningSessions' definition). */
async function runningSandboxes(agentGroupId: string): Promise<string[]> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  return sessions
    .filter((s) => s.container_status === 'running' || s.container_status === 'idle')
    .map((s) => sandboxName({ installSlug: INSTALL_SLUG, agentGroupId, sessionId: s.id }));
}

/**
 * Run `steps` in turn on each running sandbox of the group; a sandbox's first
 * failing step is its error. Never throws — a failure is a result, not an
 * abort. Each call is logged with its sandbox, so the group's audit log shows
 * where it landed.
 */
export async function applyLive(
  group: { id: string; folder: string },
  verb: ChangeVerb,
  steps: LiveStep[],
  record: Pick<PolicyChangeRecord, 'rule' | 'provider'>,
  caller: string,
): Promise<LiveResult[]> {
  const sandboxes = await runningSandboxes(group.id);
  if (sandboxes.length === 0) return [];
  const cli = openShellCommandCli();
  const results: LiveResult[] = [];
  for (const sandbox of sandboxes) {
    let error: string | undefined;
    for (const step of steps) {
      let command: string[] = [];
      try {
        command = step(sandbox);
        await cli.run(command, { timeoutMs: LIVE_TIMEOUT_MS });
        logChange({ verb, caller, group, sandbox, command, ...record, ok: true });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logChange({ verb, caller, group, sandbox, command, ...record, ok: false, error });
        break;
      }
    }
    results.push(error === undefined ? { sandbox, ok: true } : { sandbox, ok: false, error });
  }
  return results;
}

/** "Applied live to a, b. Failed on c: why." — or that nothing was running. */
export function liveSummary(live: readonly LiveResult[]): string {
  if (live.length === 0) return 'No running sandbox to apply it to now.';
  const ok = live.filter((r) => r.ok).map((r) => r.sandbox);
  return [
    ok.length ? `Applied live to ${ok.join(', ')}.` : '',
    ...live.filter((r) => !r.ok).map((r) => `Failed on ${r.sandbox}: ${r.error}.`),
  ]
    .filter(Boolean)
    .join(' ');
}
