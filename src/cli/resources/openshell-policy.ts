/**
 * `ncl openshell-policy-*` — operate NVIDIA OpenShell sandbox policy from the
 * host. Flat command registry: resource `openshell-policy` (distinct from the
 * unrelated core `policies` resource, agent-to-agent message approval), verbs
 * list / view / approve / reject / add-rule / apply-preset.
 *
 * Every command shells out to the `openshell` CLI this install is configured
 * with (OPENSHELL_BIN / OPENSHELL_GATEWAY, `.env` or environment — the same
 * CLI the session driver uses). There is no npm client for OpenShell's gRPC
 * API; the CLI is the supported surface.
 *
 * All six are hostOnly: sandbox policy is the boundary an agent runs inside,
 * so no agent may read or change it, whatever its cli_scope or approvals.
 *
 * Change log: every policy change add-rule or apply-preset sends to OpenShell
 * (dry runs excluded, failed attempts included) is appended to
 * `data/openshell-policy/changes.jsonl` — owner-only, append-only, one JSON
 * line per `openshell policy update`. Preset rules also record the preset's
 * name and version, so the trail reads "github preset v1 applied", not just
 * raw rules.
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
import { loadPreset, presetUpdateOptions } from '../../drivers/openshell/preset-registry.js';
import { sandboxName } from '../../drivers/openshell/realize.js';
import { registerResource, type ColumnDef } from '../crud.js';
import { logChange, type PolicyChangeRecord } from './openshell-change-log.js';
import type { CallerContext } from '../frame.js';

/** Test seam: the CLI the commands run. */
let cliFactory: () => OpenShellCli = () => configuredOpenShellCli();
export function setOpenShellPolicyCli(factory: (() => OpenShellCli) | null): void {
  cliFactory = factory ?? (() => configuredOpenShellCli());
}
/** The CLI every `ncl openshell-*` resource runs (one seam for all of them). */
export function openShellCommandCli(): OpenShellCli {
  return cliFactory();
}

export { setOpenShellPolicyLog, type PolicyChangeRecord } from './openshell-change-log.js';

/** Run one policy change and log it, whatever the outcome. */
async function runLogged(
  argv: string[],
  record: Omit<PolicyChangeRecord, 'ts' | 'command' | 'ok' | 'error'>,
  timeoutMs?: number,
): Promise<string> {
  try {
    const output = await runCli(argv, timeoutMs);
    logChange({ ...record, command: argv, ok: true });
    return output;
  } catch (err) {
    logChange({ ...record, command: argv, ok: false, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
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

interface PresetApplyResult {
  sandbox: string;
  preset: { name: string; version: number; description: string };
  rules: readonly { name: string; host: string; ports: readonly number[]; binaries: readonly string[] }[];
  commands: string[][];
  dryRun: boolean;
  applied: number;
  output: string;
}

function renderPreset(data: unknown): string {
  const r = data as PresetApplyResult;
  const lines = [
    `${r.dryRun ? 'Dry run — nothing sent. ' : ''}Preset ${r.preset.name} v${r.preset.version} → sandbox ${r.sandbox}`,
    r.preset.description,
    '',
    ...r.rules.map((rule) => `  ${rule.name}: ${rule.host}:${rule.ports.join(',')}  (${rule.binaries.join(', ')})`),
    '',
    r.dryRun ? 'Would run:' : `Applied ${r.applied} change(s):`,
    ...r.commands.map((c) => `  openshell ${c.join(' ')}`),
  ];
  if (r.output) lines.push('', r.output);
  return lines.join('\n');
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
      handler: async (args, ctx: CallerContext): Promise<PolicyCommandResult> => {
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
        const timeoutMs = 30_000 + waitSeconds * 1000;
        // OpenShell's own --dry-run changes nothing, so there is nothing to log.
        const output =
          args.dry_run === true
            ? await runCli(command, timeoutMs)
            : await runLogged(command, { verb: 'add-rule', caller: ctx.caller, sandbox }, timeoutMs);
        return { sandbox, command, output };
      },
      formatHuman: render,
    },
    'apply-preset': {
      access: 'approval',
      hostOnly: true,
      description:
        'Apply a named, versioned egress preset (src/drivers/openshell/presets/<name>.yaml) to a sandbox: ' +
        'each rule becomes the same `openshell policy update --add-endpoint host:port --binary … --rule-name <rule>` ' +
        'that add-rule would run, one call per rule and port. Every change is logged with the preset name and version. ' +
        '--dry-run prints the rules and commands without calling openshell.',
      args: [
        ...TARGET_ARGS,
        { name: 'preset', type: 'string', required: true, description: 'Preset name, e.g. github.' },
        { name: 'dry_run', type: 'boolean', description: 'Print the rules and commands; send nothing.' },
        { name: 'wait', type: 'boolean', description: 'Wait for the sandbox to load each new revision.' },
        { name: 'timeout', type: 'number', description: 'Seconds to wait with --wait (OpenShell default 60).' },
      ],
      examples: [
        'ncl openshell-policy apply-preset --sandbox ncl-0123abcd --preset github --dry-run',
        'ncl openshell-policy apply-preset --session <session-id> --preset github',
      ],
      handler: async (args, ctx: CallerContext): Promise<PresetApplyResult> => {
        const sandbox = await resolveSandbox(args);
        const preset = loadPreset(args.preset as string);
        const steps = presetUpdateOptions(preset).map(({ rule, options }) => ({
          rule,
          command: policyUpdateArgs(sandbox, {
            ...options,
            wait: args.wait === true,
            ...(args.timeout !== undefined ? { timeout: args.timeout as number } : {}),
          }),
        }));
        const base = {
          sandbox,
          preset: { name: preset.name, version: preset.version, description: preset.description },
          rules: preset.rules,
          commands: steps.map((s) => s.command),
        };
        if (args.dry_run === true) return { ...base, dryRun: true, applied: 0, output: '' };
        const waitSeconds = args.wait === true ? ((args.timeout as number | undefined) ?? 60) : 0;
        const outputs: string[] = [];
        for (const [i, step] of steps.entries()) {
          try {
            outputs.push(
              await runLogged(
                step.command,
                {
                  verb: 'apply-preset',
                  caller: ctx.caller,
                  sandbox,
                  preset: { name: preset.name, version: preset.version, rule: step.rule },
                },
                30_000 + waitSeconds * 1000,
              ),
            );
          } catch (err) {
            // No rollback: OpenShell has no transaction across updates. Say exactly what landed.
            throw new Error(
              `preset ${preset.name} v${preset.version}: ${i} of ${steps.length} change(s) applied before rule ` +
                `'${step.rule}' failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
        }
        return { ...base, dryRun: false, applied: steps.length, output: outputs.join('\n').trim() };
      },
      formatHuman: renderPreset,
    },
  },
});
