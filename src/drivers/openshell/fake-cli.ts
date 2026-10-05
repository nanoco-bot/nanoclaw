/**
 * A scripted `openshell` CLI: no gateway, no Docker. Each call is recorded;
 * the first matching rule (regex over the space-joined argv) answers it.
 */
import type { OpenShellCli } from './cli.js';
import { OpenShellCliError } from './cli.js';

export interface FakeRule {
  match: RegExp;
  stdout?: string | ((args: string[]) => string);
  /** stderr text of a failing exit. */
  fails?: string;
  /** Inspect side effects at call time (e.g. read the policy file before it is removed). */
  onCall?: (args: string[]) => void;
  /** Consume after this many matches. */
  times?: number;
}

export class FakeOpenShellCli implements OpenShellCli {
  readonly bin = 'openshell';
  readonly calls: string[][] = [];
  rules: FakeRule[] = [];

  async run(args: string[]): Promise<string> {
    this.calls.push(args);
    const line = args.join(' ');
    const idx = this.rules.findIndex((r) => r.match.test(line));
    if (idx === -1) throw new Error(`FakeOpenShellCli: unscripted call: openshell ${line}`);
    const rule = this.rules[idx];
    if (rule.times !== undefined && --rule.times <= 0) this.rules.splice(idx, 1);
    rule.onCall?.(args);
    if (rule.fails !== undefined) throw new OpenShellCliError(rule.fails, rule.fails, 1);
    return typeof rule.stdout === 'function' ? rule.stdout(args) : (rule.stdout ?? '');
  }

  callsMatching(re: RegExp): string[][] {
    return this.calls.filter((c) => re.test(c.join(' ')));
  }
}

export function sandboxJson(doc: Record<string, unknown>): string {
  return JSON.stringify(doc);
}

export function listJson(sandboxes: Record<string, unknown>[], next = ''): string {
  return JSON.stringify({ sandboxes, next_page_token: next });
}

export const quietLogger = { debug: () => {}, info: () => {}, warn: () => {} };
