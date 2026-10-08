/**
 * The console's activity log (`data/openshell-console/activity.jsonl`,
 * owner-only, append-only): every group change it saves and applies, and every
 * blocked request it allows or denies, with the outcome per sandbox. Never
 * holds a credential value.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface ActivityRecord {
  ts: string;
  group: { id: string; folder: string };
  action: 'provider-attach' | 'provider-detach' | 'network-add' | 'network-remove' | 'approve' | 'reject' | 'restart';
  detail: string;
  outcome: 'applied' | 'failed' | 'approved' | 'rejected';
  sandbox?: string;
  error?: string;
}

export function appendActivity(file: string, record: ActivityRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
}

/** One group's records, newest first; torn or foreign lines are skipped. */
export function readActivity(file: string, groupId: string): ActivityRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ActivityRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ActivityRecord;
      if (r?.group?.id === groupId && typeof r.ts === 'string') out.push(r);
    } catch {
      // skip
    }
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}
