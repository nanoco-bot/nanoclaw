/**
 * `ncl openshell-policy-*` — operate NVIDIA OpenShell sandbox policy from the
 * host. Flat command registry: resource `openshell-policy` (distinct from the
 * unrelated core `policies` resource, agent-to-agent message approval), verbs
 * list / view / approve / reject / add-rule.
 *
 * Every command shells out to the `openshell` CLI this install is configured
 * with (OPENSHELL_BIN / OPENSHELL_GATEWAY, `.env` or environment — the same
 * CLI the session driver uses). There is no npm client for OpenShell's gRPC
 * API; the CLI is the supported surface.
 *
 * All five are hostOnly: sandbox policy is the boundary an agent runs inside,
 * so no agent may read or change it, whatever its cli_scope or approvals.
 *
 * Coverage, stated plainly (OpenShell RFC 0002): list / approve / reject act
 * on live rule PROPOSALS, which exist only for network egress
 * (`network_policies`). Filesystem / Landlock / process policy is fixed when a
 * sandbox starts and has no proposal flow. view / add-rule read and edit the
 * full policy document directly.
 */
import { INSTALL_SLUG } from '../../config.js';
import { getSession } from '../../db/sessions.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import { configuredOpenShellCli } from '../../drivers/openshell/config.js';
import {
  assertSandboxName,
  policyUpdateArgs,
  policyViewArgs,
  proposalsNote,
  proposalsState,
  repeated,
  ruleApproveArgs,
  ruleListArgs,
  ruleRejectArgs,
  type ProposalsState,
  type RuleStatus,
} from '../../drivers/openshell/policy-commands.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import { registerResource, type ColumnDef } from '../crud.js';

/** Test seam: the CLI the commands run. */
let cliFactory: () => OpenShellCli = () => configuredOpenShellCli();
export function setOpenShellPolicyCli(factory: (() => OpenShellCli) | null): void {
  cliFactory = factory ?? (() => configuredOpenShellCli());
}

const TARGET_ARGS: ColumnDef[] = [
  {
    name: 'sandbox',
    type: 'string',
    description: 'OpenShell sandbox name (as shown by `openshell sandbox list`). Give this or --session.',
  },
  {
    name: 'session',
    type: 'string',
    description: "NanoClaw session id; resolved to that session's sandbox name. Give this or --sandbox.",
  },
];

interface PolicyCommandResult {
  sandbox: string;
  command: string[];
  output: string;
  proposals?: ProposalsState;
  note?: string;
}

async function resolveSandbox(args: Record<string, unknown>): Promise<string> {
  const sandbox = typeof args.sandbox === 'string' ? args.sandbox : undefined;
  const session = typeof args.session === 'string' ? args.session : undefined;
  // `ncl openshell-policy view <name>` arrives as id=<name> via the dispatcher.
  const positional = typeof args.id === 'string' ? args.id : undefined;
  const given = [sandbox, session, positional].filter(Boolean);
  if (given.length !== 1) throw new Error('give exactly one of --sandbox <name> or --session <session-id>');
  if (session) {
    const row = await getSession(session);
    if (!row) throw new Error(`session not found: ${session}`);
    return sandboxName({ installSlug: INSTALL_SLUG, agentGroupId: row.agent_group_id, sessionId: row.id });
  }
  return assertSandboxName((sandbox ?? positional)!);
}

async function runCli(argv: string[], timeoutMs = 30_000): Promise<string> {
  const cli = cliFactory();
  try {
    return await cli.run(argv, { timeoutMs });
  } catch (err) {
    if (err instanceof OpenShellCliError && err.exitCode === 'ENOENT') {
      throw new Error(
        `openshell CLI not found at '${cli.bin}'. Install it or set OPENSHELL_BIN (setup: --step openshell).`,
        { cause: err },
      );
    }
    throw err;
  }
}

function render(data: unknown): string {
  const r = data as PolicyCommandResult;
  const lines = [r.output.trimEnd()];
  if (r.note) lines.push('', `Note: ${r.note}`);
  return lines.filter((l, i) => l || i > 0).join('\n');
}

const NETWORK_ONLY =
  'Rule proposals cover network egress only (OpenShell RFC 0002); filesystem and process policy is fixed at sandbox start.';

registerResource({
  name: 'openshell-policy',
  plural: 'openshell-policy',
  // Not DB-backed: no generic CRUD verbs are enabled, so no table is read.
  table: '',
  idColumn: 'sandbox',
  description:
    'NVIDIA OpenShell sandbox policy, via the configured `openshell` CLI. Unrelated to `policies` (agent-to-agent approval). ' +
    NETWORK_ONLY +
    ' Operator-only.',
  columns: TARGET_ARGS,
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      hostOnly: true,
      description:
        'List network rule proposals for a sandbox (`openshell rule get --status <status>`).\n' +
        NETWORK_ONLY +
        '\nAlso reports whether the sandbox has agent_policy_proposals_enabled: when it is off or unset (OpenShell default: off), the gateway generates no proposals and the list is always empty.',
      args: [
        ...TARGET_ARGS,
        {
          name: 'status',
          type: 'string',
          description: 'Which proposals to show.',
          enum: ['pending', 'approved', 'rejected'],
          default: 'pending',
        },
      ],
      examples: [
        'ncl openshell-policy list --session <session-id>',
        'ncl openshell-policy list --sandbox ncl-0123abcd',
      ],
      handler: async (args): Promise<PolicyCommandResult> => {
        const sandbox = await resolveSandbox(args);
        const command = ruleListArgs(sandbox, args.status as RuleStatus);
        const output = await runCli(command);
        let proposals: ProposalsState = 'unknown';
        try {
          proposals = proposalsState(await runCli(['settings', 'get', sandbox, '--json']));
        } catch {
          // Reported as 'unknown' below; never treated as enabled.
        }
        const note = proposalsNote(proposals);
        return { sandbox, command, output, proposals, ...(note ? { note } : {}) };
      },
      formatHuman: render,
    },
    view: {
      access: 'open',
      hostOnly: true,
      description:
        "Show a sandbox's current policy (`openshell policy get --full`): filesystem, process and network sections.",
      args: [
        ...TARGET_ARGS,
        { name: 'output', type: 'string', description: 'Output format.', enum: ['table', 'json'], default: 'table' },
        { name: 'base', type: 'boolean', description: 'Base policy without provider-composed entries.' },
        { name: 'rev', type: 'number', description: 'A stored policy revision (default: current).' },
      ],
      examples: [
        'ncl openshell-policy view --session <session-id>',
        'ncl openshell-policy view --sandbox ncl-0123abcd --output json',
      ],
      handler: async (args): Promise<PolicyCommandResult> => {
        const sandbox = await resolveSandbox(args);
        const command = policyViewArgs(sandbox, {
          output: args.output as 'table' | 'json',
          base: args.base === true,
          ...(args.rev !== undefined ? { rev: args.rev as number } : {}),
        });
        return { sandbox, command, output: await runCli(command) };
      },
      formatHuman: render,
    },
    approve: {
      access: 'approval',
      hostOnly: true,
      description:
        'Approve one pending network rule proposal (`openshell rule approve --chunk-id <id>`).\n' + NETWORK_ONLY,
      args: [
        ...TARGET_ARGS,
        { name: 'chunk_id', type: 'string', required: true, description: 'Proposal chunk id from `list`.' },
      ],
      examples: ['ncl openshell-policy approve --sandbox ncl-0123abcd --chunk-id <chunk-id>'],
      handler: async (args): Promise<PolicyCommandResult> => {
        const sandbox = await resolveSandbox(args);
        const command = ruleApproveArgs(sandbox, args.chunk_id as string);
        return { sandbox, command, output: await runCli(command) };
      },
      formatHuman: render,
    },
    reject: {
      access: 'approval',
      hostOnly: true,
      description:
        'Reject one pending network rule proposal (`openshell rule reject --chunk-id <id> --reason <text>`).\n' +
        NETWORK_ONLY,
      args: [
        ...TARGET_ARGS,
        { name: 'chunk_id', type: 'string', required: true, description: 'Proposal chunk id from `list`.' },
        { name: 'reason', type: 'string', required: true, description: 'Why it was rejected (recorded by OpenShell).' },
      ],
      examples: ['ncl openshell-policy reject --sandbox ncl-0123abcd --chunk-id <chunk-id> --reason "not needed"'],
      handler: async (args): Promise<PolicyCommandResult> => {
        const sandbox = await resolveSandbox(args);
        const command = ruleRejectArgs(sandbox, args.chunk_id as string, args.reason as string);
        return { sandbox, command, output: await runCli(command) };
      },
      formatHuman: render,
    },
    'add-rule': {
      access: 'approval',
      hostOnly: true,
      description:
        "Edit a sandbox's network policy directly (`openshell policy update`), without the proposal flow.\n" +
        'Each rule flag takes one value, or a JSON array of values to repeat it (rule specs contain commas, so they are never split). ' +
        'Formats follow OpenShell: --add-endpoint host:port[:access[:protocol[:enforcement[:options]]]], ' +
        '--add-allow / --add-deny host:port[,port...]:METHOD:path_glob (need --rule-name plus --binary or --any-binary), ' +
        '--remove-endpoint host:port, --remove-rule <rule-name>.',
      args: [
        ...TARGET_ARGS,
        { name: 'add_endpoint', type: 'string', description: 'Add or merge an endpoint.' },
        { name: 'remove_endpoint', type: 'string', description: 'Remove an endpoint (host:port).' },
        { name: 'add_allow', type: 'string', description: 'Append an L7 allow rule.' },
        { name: 'add_deny', type: 'string', description: 'Append an L7 deny rule.' },
        { name: 'remove_rule', type: 'string', description: 'Remove a network rule by name.' },
        { name: 'binary', type: 'string', description: 'Binary path(s) the rule applies to.' },
        { name: 'rule_name', type: 'string', description: 'Target rule name for L7 appends.' },
        { name: 'any_binary', type: 'boolean', description: 'The target rule allows any binary.' },
        { name: 'endpoint_path', type: 'string', description: 'Exact endpoint path for L7 appends.' },
        { name: 'dry_run', type: 'boolean', description: 'Preview the merged policy without sending it.' },
        { name: 'wait', type: 'boolean', description: 'Wait for the sandbox to load the new revision.' },
        { name: 'timeout', type: 'number', description: 'Seconds to wait with --wait (OpenShell default 60).' },
      ],
      examples: [
        'ncl openshell-policy add-rule --sandbox ncl-0123abcd --add-endpoint api.example.com:443 --binary /usr/bin/curl --dry-run',
        'ncl openshell-policy add-rule --session <session-id> --remove-rule example_api',
      ],
      handler: async (args): Promise<PolicyCommandResult> => {
        const sandbox = await resolveSandbox(args);
        const command = policyUpdateArgs(sandbox, {
          addEndpoint: repeated(args.add_endpoint, '--add-endpoint'),
          removeEndpoint: repeated(args.remove_endpoint, '--remove-endpoint'),
          addAllow: repeated(args.add_allow, '--add-allow'),
          addDeny: repeated(args.add_deny, '--add-deny'),
          removeRule: repeated(args.remove_rule, '--remove-rule'),
          binary: repeated(args.binary, '--binary'),
          ...(typeof args.rule_name === 'string' ? { ruleName: args.rule_name } : {}),
          anyBinary: args.any_binary === true,
          ...(typeof args.endpoint_path === 'string' ? { endpointPath: args.endpoint_path } : {}),
          dryRun: args.dry_run === true,
          wait: args.wait === true,
          ...(args.timeout !== undefined ? { timeout: args.timeout as number } : {}),
        });
        const waitSeconds = args.wait === true ? ((args.timeout as number | undefined) ?? 60) : 0;
        return { sandbox, command, output: await runCli(command, 30_000 + waitSeconds * 1000) };
      },
      formatHuman: render,
    },
  },
});
