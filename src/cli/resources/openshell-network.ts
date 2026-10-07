/**
 * `ncl openshell-network-*` — raw network paths (egress rules) for an agent
 * group, independent of any provider: every sandbox the group gets from then
 * on is created with them in its policy's `network_policies`
 * (openshell_group_egress, read by src/drivers/openshell/register.ts at each
 * sandbox creation; merged on top of NANOCLAW_OPENSHELL_POLICY_FILE's egress).
 * Verbs: add / remove / list.
 *
 * Per GROUP, unlike `ncl openshell-policy add-rule`, which edits one live
 * sandbox's policy and is lost when that sandbox is recreated. A rule added
 * here applies to sandboxes created afterwards; use add-rule (or apply-preset)
 * to change a running one too.
 */
import {
  listGroupEgressRules,
  putGroupEgressRule,
  removeGroupEgressRule,
  type GroupEgressRule,
} from '../../db/openshell-group-resources.js';
import { openShellSettingsEnv } from '../../drivers/openshell/config.js';
import { groupEgressRule } from '../../drivers/openshell/provider-commands.js';
import { settingsFromEnv } from '../../drivers/openshell/settings.js';
import { registerResource, type ColumnDef } from '../crud.js';
import type { CallerContext } from '../frame.js';
import { logChange } from './openshell-change-log.js';
import { resolveAgentGroup } from './openshell-group.js';

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
    "Raw network paths (egress rules) for an agent group's OpenShell sandboxes, independent of providers. Operator-only.",
  columns: [GROUP_ARG],
  operations: {},
  customOperations: {
    add: {
      access: 'approval',
      hostOnly: true,
      description:
        "Allow a group's sandboxes to reach host:port(s), from the given binaries only (from the next sandbox on). " +
        'Same rule shape as the policy file (EgressRule); adding an existing name replaces it.',
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
        logChange({
          verb: 'network-add',
          caller: ctx.caller,
          group: { id: group.id, folder: group.folder },
          rule: { name: rule.name, host: rule.host, ports: [...rule.ports], binaries: [...rule.binaries] },
          ok: true,
        });
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          rule,
          message: `Network path ${rule.name} (${rule.host}:${rule.ports.join(',')}) added for ${group.folder}; its next sandbox gets it.`,
        };
      },
      formatHuman: render,
    },
    remove: {
      access: 'approval',
      hostOnly: true,
      description: 'Remove a group network path (from the next sandbox on).',
      args: [GROUP_ARG, NAME_ARG],
      examples: ['ncl openshell-network remove --group alice --name crm_api'],
      handler: async (args, ctx: CallerContext) => {
        const group = await resolveAgentGroup(args.group);
        const name = String(args.name);
        if (!(await removeGroupEgressRule(group.id, name)))
          throw new Error(`no network path '${name}' for ${group.folder}`);
        logChange({
          verb: 'network-remove',
          caller: ctx.caller,
          group: { id: group.id, folder: group.folder },
          rule: { name },
          ok: true,
        });
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          message: `Network path ${name} removed for ${group.folder}; its next sandbox will not have it.`,
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
