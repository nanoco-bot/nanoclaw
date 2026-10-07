/**
 * The OpenShell change log: `data/openshell-policy/changes.jsonl`, owner-only,
 * append-only, one JSON line per change NanoClaw sends to OpenShell or to its
 * own per-group OpenShell store. Written by `ncl openshell-policy add-rule` /
 * `apply-preset` (one line per `openshell policy update`), and by
 * `ncl openshell-provider attach/detach` and `ncl openshell-network add/remove`
 * (one line per group change). Failed attempts are logged too; dry runs are not.
 *
 * Never holds a credential value: provider lines carry key NAMES only.
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';

export type ChangeVerb =
  | 'add-rule'
  | 'apply-preset'
  | 'provider-attach'
  | 'provider-detach'
  | 'network-add'
  | 'network-remove';

export interface PolicyChangeRecord {
  ts: string;
  verb: ChangeVerb;
  caller: string;
  /** Per-sandbox changes (add-rule, apply-preset). */
  sandbox?: string;
  /** Per-group changes (provider/network): the agent group they were made for. */
  group?: { id: string; folder: string };
  /** The exact `openshell` argv sent, when one was. */
  command?: string[];
  /** Whether it took effect; failed attempts are logged too. */
  ok: boolean;
  error?: string;
  /** apply-preset only: which preset (and which of its rules) produced this change. */
  preset?: { name: string; version: number; rule: string };
  /** provider-*: the OpenShell provider; credential key NAMES only, never values. */
  provider?: { name: string; type?: string | null; credentialKeys?: string[] };
  /** network-*: the group rule. */
  rule?: { name: string; host?: string; ports?: number[]; binaries?: string[] };
}

const defaultLogPath = () => path.join(DATA_DIR, 'openshell-policy', 'changes.jsonl');
let logPath: () => string = defaultLogPath;

/** Test seam: where changes are logged (null restores the default). */
export function setOpenShellPolicyLog(file: string | null): void {
  logPath = file ? () => file : defaultLogPath;
}

export function changeLogPath(): string {
  return logPath();
}

export function logChange(record: Omit<PolicyChangeRecord, 'ts'>, now: Date = new Date()): void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ ts: now.toISOString(), ...record }) + '\n', { mode: 0o600 });
}

/** Every parseable record, oldest first; a torn or foreign line is skipped. */
export function readChanges(file: string = logPath()): PolicyChangeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: PolicyChangeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PolicyChangeRecord;
      if (r && typeof r.verb === 'string' && typeof r.ts === 'string') out.push(r);
    } catch {
      // skip
    }
  }
  return out;
}
