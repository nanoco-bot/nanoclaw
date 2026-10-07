/**
 * `ncl openshell-provider-*` — attach OpenShell GATEWAY providers to an agent
 * group, durably: every sandbox the group gets from then on is created with
 * `--provider <name>` (src/drivers/openshell/register.ts reads
 * openshell_group_providers at each sandbox creation). Verbs: attach / detach / list.
 *
 * Not the AI model provider: `ncl groups config update --provider` sets
 * container_configs.provider (claude/openai/…). This resource's flag is
 * `--openshell-provider` so the two never collide.
 *
 * Credentials: `attach --type T --credentials '{"KEY":"value"}'` first creates
 * the provider in the OpenShell gateway (`openshell provider create … --credential
 * KEY`, value in the child's environment only — prefer `--stdin-json` so it is
 * not in shell history either). NanoClaw stores the key NAMES and an HMAC of
 * each value, never the value. Without `--type`, the provider must already
 * exist in the gateway (`openshell provider get` is checked first).
 *
 * hostOnly: which credentials a sandbox gets is the operator's decision.
 * Changes apply to sandboxes created afterwards; a running sandbox keeps what
 * it started with (`openshell sandbox provider attach` changes a live one).
 */
import {
  attachGroupProvider,
  detachGroupProvider,
  listGroupProviders,
  type GroupProvider,
} from '../../db/openshell-group-resources.js';
import {
  assertProviderName,
  assertProviderType,
  providerCreateInvocation,
  providerGetArgs,
  stringMap,
} from '../../drivers/openshell/provider-commands.js';
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
const PROVIDER_ARG: ColumnDef = {
  name: 'openshell_provider',
  type: 'string',
  required: true,
  description: 'OpenShell gateway provider name (not the AI model provider).',
};

/** Never let a credential value reach an error message. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

function render(data: unknown): string {
  const d = data as { group: { folder: string }; providers?: GroupProvider[]; message?: string };
  if (d.message) return d.message;
  const rows = d.providers ?? [];
  if (rows.length === 0) return `No OpenShell providers attached to ${d.group.folder}.`;
  return rows
    .map(
      (p) =>
        `${p.name}${p.type ? ` (${p.type})` : ''}${p.credentialKeys.length ? `  keys: ${p.credentialKeys.join(', ')}` : ''}  attached ${p.attachedAt}`,
    )
    .join('\n');
}

registerResource({
  name: 'openshell-provider',
  plural: 'openshell-provider',
  table: '',
  idColumn: 'group',
  description:
    'OpenShell gateway providers attached to an agent group; every new sandbox of the group gets them. ' +
    'Not the AI model provider (`groups config --provider`). Operator-only.',
  columns: [GROUP_ARG],
  operations: {},
  customOperations: {
    attach: {
      access: 'approval',
      hostOnly: true,
      description:
        "Attach an OpenShell provider to a group's sandboxes (from the next sandbox on).\n" +
        'With --type, first create it in the OpenShell gateway with --credentials (JSON object KEY → value; ' +
        'prefer --stdin-json). Values go only to the gateway; NanoClaw keeps key names and a hash.',
      args: [
        GROUP_ARG,
        PROVIDER_ARG,
        {
          name: 'type',
          type: 'string',
          description: 'Create the provider with this OpenShell type first (e.g. anthropic, github).',
        },
        {
          name: 'credentials',
          type: 'json',
          description: 'With --type: JSON object of credential env-var name → value.',
        },
        { name: 'config', type: 'json', description: 'With --type: JSON object of provider config key → value.' },
      ],
      examples: [
        'ncl openshell-provider attach --group alice --openshell-provider github-alice',
        `echo '{"credentials":{"GITHUB_TOKEN":"…"}}' | ncl openshell-provider attach --group alice --openshell-provider github-alice --type github --stdin-json`,
      ],
      handler: async (args, ctx: CallerContext) => {
        const group = await resolveAgentGroup(args.group);
        const name = assertProviderName(args.openshell_provider);
        const credentials = stringMap(args.credentials, 'credential');
        const config = stringMap(args.config, 'config');
        const secrets = Object.values(credentials);
        const type = args.type === undefined ? null : assertProviderType(args.type);
        if (!type && (secrets.length > 0 || Object.keys(config).length > 0)) {
          throw new Error('--credentials / --config need --type: they create the provider in the OpenShell gateway');
        }
        const cli = openShellCommandCli();
        const base = {
          verb: 'provider-attach' as const,
          caller: ctx.caller,
          group: { id: group.id, folder: group.folder },
        };
        const providerInfo = { name, type, credentialKeys: Object.keys(credentials).sort() };
        let command: string[];
        try {
          if (type) {
            const create = providerCreateInvocation({ name, type, credentials, config });
            command = create.args;
            await cli.run(create.args, { env: create.env });
          } else {
            // The gateway is the authority on whether the provider exists.
            command = providerGetArgs(name);
            await cli.run(command);
          }
        } catch (err) {
          const message = scrub(err instanceof Error ? err.message : String(err), secrets);
          logChange({ ...base, provider: providerInfo, ok: false, error: message });
          // No cause on purpose: the original error is unscrubbed and could carry a credential value.
          // eslint-disable-next-line preserve-caught-error
          throw new Error(
            type
              ? `openshell provider create failed: ${message}`
              : `OpenShell has no provider '${name}' (${message}); create it first or pass --type`,
          );
        }
        const row = await attachGroupProvider({ agentGroupId: group.id, name, type, credentials });
        logChange({ ...base, command, provider: providerInfo, ok: true });
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          created: Boolean(type),
          provider: { name: row.name, type: row.type, credentialKeys: row.credentialKeys, attachedAt: row.attachedAt },
          message: `${type ? `Created OpenShell provider ${name} (${type}) and attached` : `Attached OpenShell provider ${name}`} to ${group.folder}; its next sandbox gets it.`,
        };
      },
      formatHuman: render,
    },
    detach: {
      access: 'approval',
      hostOnly: true,
      description:
        'Detach an OpenShell provider from a group (from the next sandbox on). The provider stays in the gateway.',
      args: [GROUP_ARG, PROVIDER_ARG],
      examples: ['ncl openshell-provider detach --group alice --openshell-provider github-alice'],
      handler: async (args, ctx: CallerContext) => {
        const group = await resolveAgentGroup(args.group);
        const name = assertProviderName(args.openshell_provider);
        const removed = await detachGroupProvider(group.id, name);
        if (!removed) throw new Error(`OpenShell provider '${name}' is not attached to ${group.folder}`);
        logChange({
          verb: 'provider-detach',
          caller: ctx.caller,
          group: { id: group.id, folder: group.folder },
          provider: { name },
          ok: true,
        });
        return {
          group: { id: group.id, folder: group.folder, name: group.name },
          message: `Detached OpenShell provider ${name} from ${group.folder}; its next sandbox will not get it.`,
        };
      },
      formatHuman: render,
    },
    list: {
      access: 'open',
      hostOnly: true,
      description: 'OpenShell providers attached to a group (names, types, credential KEY names — never values).',
      args: [GROUP_ARG],
      examples: ['ncl openshell-provider list --group alice'],
      handler: async (args) => {
        const group = await resolveAgentGroup(args.group);
        const providers = (await listGroupProviders(group.id)).map(({ credentialHashes: _h, ...p }) => p);
        return { group: { id: group.id, folder: group.folder, name: group.name }, providers };
      },
      formatHuman: render,
    },
  },
});
