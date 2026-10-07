/**
 * `ncl openshell-network-*` — raw network paths (egress rules) for an agent
 * group, independent of any provider: every sandbox the group gets from then
 * on is created with them in its policy's `network_policies`
 * (openshell_group_egress, read by src/drivers/openshell/register.ts at each
 * sandbox creation; merged on top of NANOCLAW_OPENSHELL_POLICY_FILE's egress).
 * Verbs: add / remove / list.
 *
 * Per GROUP, unlike `ncl openshell-policy add-rule`, which edits one live
 * sandbox's policy and is lost when that sandbox is recreated. add / remove
 * do two things, in this order:
 *   1. the durable write (openshell_group_egress) — the primary guarantee:
 *      every sandbox the group gets from now on has the rule (or not);
 *   2. live apply to every sandbox the group has running NOW (sessions with
 *      container_status running/idle, as getRunningSessions defines it): the
 *      same `openshell policy update` add-rule runs — `--add-endpoint host:port
 *      --binary … --rule-name <name>` per port, or `--remove-rule <name>`.
 * Live apply is best-effort and reported per sandbox: one sandbox failing
 * neither stops the others nor undoes the durable write, and there is no
 * cross-sandbox rollback (as add-rule documents for one sandbox). Calls are
 * sequential, each with add-rule's 30 s CLI timeout.
 */
import {
  listGroupEgressRules,
  putGroupEgressRule,
  removeGroupEgressRule,
  type GroupEgressRule,
} from '../../db/openshell-group-resources.js';
import { INSTALL_SLUG } from '../../config.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { openShellSettingsEnv } from '../../drivers/openshell/config.js';
import type { EgressRule } from '../../drivers/openshell/policy.js';
import { policyUpdateArgs, type PolicyUpdateOptions } from '../../drivers/openshell/policy-commands.js';
import { egressRuleUpdateOptions } from '../../drivers/openshell/preset-registry.js';
import { groupEgressRule } from '../../drivers/openshell/provider-commands.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import { settingsFromEnv } from '../../drivers/openshell/settings.js';
import { registerResource, type ColumnDef } from '../crud.js';
import type { CallerContext } from '../frame.js';
import { logChange } from './openshell-change-log.js';
import { resolveAgentGroup } from './openshell-group.js';
import { openShellCommandCli } from './openshell-policy.js';

const GROUP_ARG: ColumnDef = {
  name: 'group',
  type: 'string',
  required: true,
  description: 'Agent group: id, folder or name.',
};
const NAME_ARG: ColumnDef = {
  name: 'name',
  type: 'string',
  required: true,
  description: 'Rule name ([A-Za-z0-9][A-Za-z0-9_-]*, ≤63 bytes).',
};

function configuredFileRuleNames(folder: string): string[] {
  const settings = settingsFromEnv(openShellSettingsEnv());
  return [...(settings.policy.egress ?? []), ...(settings.groupPolicy?.[folder]?.egress ?? [])].map((r) => r.name);
}
/** Test seam: rule names already taken by the operator's policy file for a folder. */
let fileRuleNames: (folder: string) => string[] = configuredFileRuleNames;
export function setOpenShellNetworkFileRules(fn: ((folder: string) => string[]) | null): void {
  fileRuleNames = fn ?? configuredFileRuleNames;
}

/** add-rule's per-call CLI timeout (openshell-policy.ts runCli default). */
const LIVE_TIMEOUT_MS = 30_000;

export interface LiveResult {
  sandbox: string;
  ok: boolean;
  error?: string;
}

/** The group's running sandboxes: sessions whose container is running or idle (getRunningSessions' definition). */
async function runningSandboxes(agentGroupId: string): Promise<string[]> {
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  return sessions
    .filter((s) => s.container_status === 'running' || s.container_status === 'idle')
    .map((s) => sandboxName({ installSlug: INSTALL_SLUG, agentGroupId, sessionId: s.id }));
}

function logRule(rule: { name: string } & Partial<EgressRule>) {
  return {
    name: rule.name,
    ...(rule.host ? { host: rule.host } : {}),
    ...(rule.ports ? { ports: [...rule.ports] } : {}),
    ...(rule.binaries ? { binaries: [...rule.binaries] } : {}),
  };
}

/**
 * Fan one group change out to each running sandbox: that sandbox's
 * `openshell policy update` calls in turn; its first failing call is its
 * error. Never throws — a failure is a result, not an abort. Each call is
 * logged with its sandbox, so the group's audit log shows where it landed.
 */
async function applyLive(
  group: { id: string; folder: string },
  verb: 'network-add' | 'network-remove',
  rule: { name: string } & Partial<EgressRule>,
  calls: PolicyUpdateOptions[],
  caller: string,
): Promise<LiveResult[]> {
  const sandboxes = await runningSandboxes(group.id);
  if (sandboxes.length === 0) return [];
  const cli = openShellCommandCli();
  const results: LiveResult[] = [];
  for (const sandbox of sandboxes) {
    let error: string | undefined;
    for (const options of calls) {
      let command: string[] = [];
      try {
        command = policyUpdateArgs(sandbox, options);
        await cli.run(command, { timeoutMs: LIVE_TIMEOUT_MS });
        logChange({ verb, caller, group, sandbox, command, rule: logRule(rule), ok: true });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        logChange({ verb, caller, group, sandbox, command, rule: logRule(rule), ok: false, error });
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

function render(data: unknown): string {
  const d = data as { group: { folder: string }; rules?: GroupEgressRule[]; message?: string };
  if (d.message) return d.message;
  const rules = d.rules ?? [];
  if (rules.length === 0) return `No network paths for ${d.group.folder}.`;
  return rules.map((r) => `${r.name}: ${r.host}:${r.ports.join(',')}  (${r.binaries.join(', ')})`).join('\n');
}

registerResource({
  name: 'openshell-network',
  plural: 'openshell-network',
  table: '',
  idColumn: 'group',
  description:
    "Raw network paths (egress rules) for an agent group's OpenShell sandboxes, independent of providers. " +
    'add / remove are saved for future sandboxes and applied live to the group’s running ones. Operator-only.',
  columns: [GROUP_ARG],
  operations: {},
  customOperations: {
    add: {
      access: 'approval',
      hostOnly: true,
      description:
        "Allow a group's sandboxes to reach host:port(s), from the given binaries only. Saved for every sandbox the " +
        'group gets from now on, AND applied live to every sandbox the group has running now (one `openshell policy ' +
        'update` per running sandbox and port) — approving this can change several live sandboxes at once.\n' +
        'Same rule shape as the policy file (EgressRule); adding an existing name replaces it. Live apply is ' +
        'best-effort: each sandbox is reported applied or failed, and a failure never undoes the saved rule.',
      args: [
        GROUP_ARG,
        NAME_ARG,
        { name: 'host', type: 'string', required: true, description: 'Destination host name.' },
        { name: 'ports', type: 'string', required: true, description: 'TCP port(s): 443 or 443,8443.' },
        {
          name: 'binary',
          type: 'string',
          required: true,
          description: 'Executable allowed to connect; a JSON array for several.',
        },
      ],
      examples: [
        'ncl openshell-network add --group alice --name crm_api --host api.hubapi.com --ports 443 --binary /usr/local/bin/node',
      ],
      handler: async (args, ctx: CallerContext) => {
        const group = await resolveAgentGroup(args.group);
        const rule = groupEgressRule({ name: args.name, host: args.host, ports: args.ports, binaries: args.binary });
        let taken: string[] = [];
        try {
          taken = fileRuleNames(group.folder);
        } catch {
          // An unreadable policy file is the driver's to report; nothing to collide with here.
        }
        if (taken.includes(rule.name)) {
          throw new Error(
            `rule name '${rule.name}' is already used by NANOCLAW_OPENSHELL_POLICY_FILE for ${group.folder}; pick another`,
          );
        }
        await putGroupEgressRule(group.id, rule);
        const ref = { id: group.id, folder: group.folder };
        logChange({ verb: 'network-add', caller: ctx.caller, group: ref, rule: logRule(rule), ok: true });
        // After the durable write, never instead of it: live apply cannot fail the command.
        const live = await applyLive(ref, 'network-add', rule, egressRuleUpdateOptions(rule), ctx.caller);
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          rule,
          saved: true,
          live,
          message:
            `Network path ${rule.name} (${rule.host}:${rule.ports.join(',')}) saved for future sandboxes of ${group.folder}. ` +
            liveSummary(live),
        };
      },
      formatHuman: render,
    },
    remove: {
      access: 'approval',
      hostOnly: true,
      description:
        'Remove a group network path: from every sandbox the group gets from now on, AND live from every sandbox ' +
        'the group has running now (`openshell policy update --remove-rule <name>` per running sandbox) — approving ' +
        'this can change several live sandboxes at once. Live removal is best-effort and reported per sandbox.',
      args: [GROUP_ARG, NAME_ARG],
      examples: ['ncl openshell-network remove --group alice --name crm_api'],
      handler: async (args, ctx: CallerContext) => {
        const group = await resolveAgentGroup(args.group);
        const name = String(args.name);
        if (!(await removeGroupEgressRule(group.id, name)))
          throw new Error(`no network path '${name}' for ${group.folder}`);
        const ref = { id: group.id, folder: group.folder };
        logChange({ verb: 'network-remove', caller: ctx.caller, group: ref, rule: { name }, ok: true });
        const live = await applyLive(ref, 'network-remove', { name }, [{ removeRule: [name] }], ctx.caller);
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          saved: true,
          live,
          message: `Network path ${name} removed for future sandboxes of ${group.folder}. ${liveSummary(live)}`,
        };
      },
      formatHuman: render,
    },
    list: {
      access: 'open',
      hostOnly: true,
      description: "A group's network paths.",
      args: [GROUP_ARG],
      examples: ['ncl openshell-network list --group alice'],
      handler: async (args) => {
        const group = await resolveAgentGroup(args.group);
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          rules: await listGroupEgressRules(group.id),
        };
      },
      formatHuman: render,
    },
  },
});
