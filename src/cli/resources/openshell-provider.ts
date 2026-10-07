/**
 * `ncl openshell-provider-*` — NVIDIA OpenShell providers from the host.
 *
 * Two scopes in one resource:
 *
 *  - PER AGENT GROUP — attach / detach / list (`--group <id|folder>`).
 *    OpenShell's own `sandbox provider attach` changes ONE running sandbox,
 *    and NanoClaw creates a fresh sandbox for every session, so a hand-made
 *    attachment is gone when the session ends. These verbs persist the
 *    group's provider list (`container_configs.openshell_providers`); the
 *    OpenShell driver passes one `--provider <name>` per entry to every
 *    `sandbox create` for that group (realize.ts createArgs). attach/detach
 *    ALSO apply the change at once to every live sandbox of the group
 *    (`openshell sandbox provider attach|detach <sandbox> <provider>`), so it
 *    takes effect without waiting for a new session.
 *
 *  - SYSTEM-WIDE — profile-list / profile-import / profile-update. Provider
 *    PROFILES (templates such as a custom "granola" profile) are gateway-wide;
 *    these wrap `openshell provider profile list|import|update` and take no
 *    group. Provider INSTANCES are created with plain `openshell provider
 *    create` (or the setup UI) — also gateway-wide; attaching one to a group
 *    is what attach does.
 *
 * All verbs are hostOnly: providers carry credentials into a sandbox, so no
 * agent may read or change them, whatever its cli_scope or approvals.
 *
 * Audit log: every attach/detach ATTEMPT (success or failure, including a
 * refused group or provider) and every profile import/update is appended to
 * `data/openshell-provider/changes.jsonl` — owner-only, append-only, one JSON
 * line per attempt, the same pattern as openshell-policy's changes.jsonl.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DATA_DIR, INSTALL_SLUG } from '../../config.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getGroupOpenShellProviders, setGroupOpenShellProviders } from '../../db/container-configs.js';
import { OpenShellCliError, type OpenShellCli } from '../../drivers/openshell/cli.js';
import { configuredOpenShellCli } from '../../drivers/openshell/config.js';
import {
  assertProfileId,
  assertProviderName,
  isProviderNotFound,
  profileImportArgs,
  profileListArgs,
  profileUpdateArgs,
  providerGetArgs,
  sandboxProviderAttachArgs,
  sandboxProviderDetachArgs,
  type ProfileOutput,
} from '../../drivers/openshell/provider-commands.js';
import { listingPhase, parseSandboxList, type OpenShellSandboxDoc } from '../../drivers/openshell/realize.js';
import { LABELS } from '../../drivers/types.js';
import type { AgentGroup } from '../../types.js';
import { registerResource, type ColumnDef } from '../crud.js';
import type { CallerContext } from '../frame.js';

/** Test seam: the CLI the commands run. */
let cliFactory: () => OpenShellCli = () => configuredOpenShellCli();
export function setOpenShellProviderCli(factory: (() => OpenShellCli) | null): void {
  cliFactory = factory ?? (() => configuredOpenShellCli());
}

/** Where attach/detach/profile changes are logged. */
export function openShellProviderLogPath(dataDir: string = DATA_DIR): string {
  return path.join(dataDir, 'openshell-provider', 'changes.jsonl');
}
let logPath: () => string = () => openShellProviderLogPath();
/** Test seam. */
export function setOpenShellProviderLog(file: string | null): void {
  logPath = file ? () => file : () => openShellProviderLogPath();
}

export interface LiveProviderChange {
  sandbox: string;
  /** The exact `openshell` argv sent. */
  command: string[];
  ok: boolean;
  error?: string;
}

export interface ProviderChangeRecord {
  ts: string;
  verb: 'attach' | 'detach' | 'profile-import' | 'profile-update';
  caller: string;
  /** attach/detach: the agent group id (as resolved; the raw argument if it did not resolve). */
  group?: string;
  provider?: string;
  /** profile-update: the profile id. */
  profile?: string;
  /** Whether the whole attempt succeeded; failed attempts are logged too. */
  ok: boolean;
  error?: string;
  /** attach/detach: whether the group's persisted list was written. */
  persisted?: boolean;
  /** attach/detach: the group's provider list after the attempt. */
  providers?: string[];
  /** attach/detach: what was sent to each live sandbox of the group. */
  live?: LiveProviderChange[];
  /** profile-*: the exact `openshell` argv sent. */
  command?: string[];
}

function logChange(record: Omit<ProviderChangeRecord, 'ts'>): void {
  const file = logPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', { mode: 0o600 });
}

/** All parseable records, oldest first; a torn line is skipped, not fatal. */
export function readProviderChanges(file: string = logPath()): ProviderChangeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ProviderChangeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ProviderChangeRecord;
      if (r && typeof r.verb === 'string' && typeof r.ts === 'string') out.push(r);
    } catch {
      // skip
    }
  }
  return out;
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

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function resolveGroup(raw: unknown): Promise<AgentGroup> {
  const ref = typeof raw === 'string' ? raw.trim() : '';
  if (!ref) throw new Error('--group <agent-group-id or folder> is required');
  const group = (await getAgentGroup(ref)) ?? (await getAgentGroupByFolder(ref));
  if (!group) throw new Error(`agent group not found: ${ref}`);
  return group;
}

export interface LiveSandbox {
  name: string;
  phase: string;
}

/**
 * The group's sandboxes OpenShell currently holds that have not ended — the
 * same label selector the driver adopts by (install + group + agent role).
 * Paginated and bounded like the driver's own listing.
 */
export async function liveSandboxesForGroup(agentGroupId: string): Promise<LiveSandbox[]> {
  const selector = `${LABELS.install}=${INSTALL_SLUG},${LABELS.group}=${agentGroupId},${LABELS.role}=agent`;
  const docs: OpenShellSandboxDoc[] = [];
  let token = '';
  for (let page = 0; page < 1000; page++) {
    const out = await runCli([
      'sandbox',
      'list',
      '--selector',
      selector,
      '--page-size',
      '100',
      ...(token ? ['--page-token', token] : []),
      '-o',
      'json',
    ]);
    const { sandboxes, nextPageToken } = parseSandboxList(out);
    docs.push(...sandboxes);
    if (!nextPageToken) break;
    token = nextPageToken;
  }
  return docs
    .filter((d) => d.labels?.[LABELS.group] === agentGroupId && listingPhase(d.phase) !== 'terminal')
    .map((d) => ({ name: d.name, phase: String(d.phase ?? 'Unknown') }));
}

/** A live attach of something already attached (or detach of something absent) is the desired end state. */
function alreadyInState(verb: 'attach' | 'detach', err: unknown): boolean {
  const msg = message(err);
  return verb === 'attach' ? /already (attached|exists)|AlreadyExists/i.test(msg) : /not attached/i.test(msg);
}

export interface GroupProviderResult {
  group: { id: string; name: string; folder: string };
  verb: 'attach' | 'detach';
  provider: string;
  /** False when the list already was in the requested state. */
  changed: boolean;
  providers: string[];
  live: LiveProviderChange[];
}

async function changeGroupProvider(
  verb: 'attach' | 'detach',
  args: Record<string, unknown>,
  ctx: CallerContext,
): Promise<GroupProviderResult> {
  let groupRef = typeof args.group === 'string' ? args.group : String(args.group ?? '');
  const providerRef = typeof args.provider === 'string' ? args.provider : String(args.provider ?? '');
  let persisted = false;
  let providers: string[] | undefined;
  const live: LiveProviderChange[] = [];
  try {
    const provider = assertProviderName(providerRef);
    const group = await resolveGroup(args.group);
    groupRef = group.id;
    const before = await getGroupOpenShellProviders(group.id);

    if (verb === 'attach') {
      // The gateway is the authority on what exists; never persist a name it does not know.
      try {
        await runCli(providerGetArgs(provider));
      } catch (err) {
        if (isProviderNotFound(err)) {
          throw new Error(
            `provider not found: ${provider} (create it first: openshell provider create --name ${provider} …)`,
            { cause: err },
          );
        }
        throw new Error(`could not verify provider ${provider} with OpenShell: ${message(err)}`, { cause: err });
      }
    } else if (!before.includes(provider)) {
      throw new Error(
        `provider not found on group ${group.folder}: ${provider} is not attached (attached: ${before.join(', ') || 'none'})`,
      );
    }

    const after = verb === 'attach' ? [...new Set([...before, provider])] : before.filter((p) => p !== provider);
    const changed = after.length !== before.length;
    // Durable first: every sandbox created from here on carries the new list.
    if (changed) await setGroupOpenShellProviders(group.id, after);
    persisted = true;
    providers = after;

    // Then the sandboxes already running for the group.
    let sandboxes: LiveSandbox[];
    try {
      sandboxes = await liveSandboxesForGroup(group.id);
    } catch (err) {
      throw new Error(
        `${verb} of ${provider} saved for group ${group.folder} (applies to every new session), but the live sandboxes ` +
          `could not be listed, so none was changed now: ${message(err)}`,
        { cause: err },
      );
    }
    for (const sb of sandboxes) {
      const command =
        verb === 'attach' ? sandboxProviderAttachArgs(sb.name, provider) : sandboxProviderDetachArgs(sb.name, provider);
      try {
        await runCli(command);
        live.push({ sandbox: sb.name, command, ok: true });
      } catch (err) {
        if (alreadyInState(verb, err)) live.push({ sandbox: sb.name, command, ok: true });
        else live.push({ sandbox: sb.name, command, ok: false, error: message(err) });
      }
    }
    const failed = live.filter((l) => !l.ok);
    if (failed.length > 0) {
      throw new Error(
        `${verb} of ${provider} saved for group ${group.folder} (applies to every new session), and applied to ` +
          `${live.length - failed.length} of ${live.length} live sandbox(es); failed on: ` +
          failed.map((f) => `${f.sandbox} (${f.error})`).join('; '),
      );
    }

    logChange({ verb, caller: ctx.caller, group: group.id, provider, ok: true, persisted, providers: after, live });
    return {
      group: { id: group.id, name: group.name, folder: group.folder },
      verb,
      provider,
      changed,
      providers: after,
      live,
    };
  } catch (err) {
    logChange({
      verb,
      caller: ctx.caller,
      group: groupRef,
      provider: providerRef,
      ok: false,
      error: message(err),
      persisted,
      ...(providers ? { providers } : {}),
      live,
    });
    throw err;
  }
}

function renderChange(data: unknown): string {
  const r = data as GroupProviderResult;
  const lines = [
    r.changed
      ? `${r.verb === 'attach' ? 'Attached' : 'Detached'} ${r.provider} ${r.verb === 'attach' ? 'to' : 'from'} group ${r.group.folder} (${r.group.id}).`
      : `${r.provider} was already ${r.verb === 'attach' ? 'attached to' : 'absent from'} group ${r.group.folder}; nothing to save.`,
    `Every new sandbox for this group gets: ${r.providers.length ? r.providers.join(', ') : '(no providers)'}`,
    r.live.length
      ? `Applied now to ${r.live.length} live sandbox(es): ${r.live.map((l) => l.sandbox).join(', ')}`
      : 'No live sandbox for this group right now; takes effect with the next session.',
  ];
  return lines.join('\n');
}

export interface GroupProviderList {
  group: { id: string; name: string; folder: string };
  providers: string[];
  sandboxes?: LiveSandbox[];
  sandboxesError?: string;
}

function renderList(data: unknown): string {
  const r = data as GroupProviderList;
  const lines = [
    `Group ${r.group.folder} (${r.group.id})`,
    `Attached providers: ${r.providers.length ? r.providers.join(', ') : '(none)'}`,
  ];
  if (r.sandboxes)
    lines.push(
      `Live sandboxes: ${r.sandboxes.length ? r.sandboxes.map((s) => `${s.name} [${s.phase}]`).join(', ') : '(none)'}`,
    );
  if (r.sandboxesError) lines.push(`Live sandboxes: could not list (${r.sandboxesError})`);
  return lines.join('\n');
}

// ---------- profiles (system-wide) ----------

/** Inline YAML is staged in a private temp file for `-f`; bounded like OpenShell's own --url fetch. */
const MAX_INLINE_YAML = 1024 * 1024;

async function withProfileFile<T>(args: Record<string, unknown>, run: (file: string) => Promise<T>): Promise<T> {
  const file = typeof args.file === 'string' ? args.file.trim() : '';
  const yaml = typeof args.yaml === 'string' ? args.yaml : '';
  if ((file ? 1 : 0) + (yaml ? 1 : 0) !== 1)
    throw new Error('give exactly one of --file <path> or --yaml <inline YAML>');
  if (file) {
    const abs = path.resolve(file);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch (err) {
      throw new Error(`profile file not found: ${abs}`, { cause: err });
    }
    if (!st.isFile()) throw new Error(`profile file is not a regular file: ${abs}`);
    return run(abs);
  }
  if (Buffer.byteLength(yaml, 'utf8') > MAX_INLINE_YAML) throw new Error('inline profile YAML is larger than 1 MiB');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-openshell-profile-'));
  const staged = path.join(dir, 'profile.yaml');
  try {
    fs.writeFileSync(staged, yaml, { mode: 0o600 });
    return await run(staged);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface ProfileCommandResult {
  command: string[];
  output: string;
}

const renderProfile = (data: unknown) => (data as ProfileCommandResult).output.trimEnd();

async function runLoggedProfile(
  verb: 'profile-import' | 'profile-update',
  command: string[],
  ctx: CallerContext,
  profile?: string,
): Promise<ProfileCommandResult> {
  // A staged inline file's path is meaningless after the call; log it as such.
  const logged = command.map((a, i) =>
    command[i - 1] === '-f' && path.basename(path.dirname(a)).startsWith('nanoclaw-openshell-profile-')
      ? '<inline yaml>'
      : a,
  );
  try {
    const output = await runCli(command);
    logChange({ verb, caller: ctx.caller, ...(profile ? { profile } : {}), command: logged, ok: true });
    return { command: logged, output };
  } catch (err) {
    logChange({
      verb,
      caller: ctx.caller,
      ...(profile ? { profile } : {}),
      command: logged,
      ok: false,
      error: message(err),
    });
    throw err;
  }
}

const GROUP_ARG: ColumnDef = {
  name: 'group',
  type: 'string',
  required: true,
  description: 'Agent group id or folder (see `ncl groups list`).',
};
const PROVIDER_ARG: ColumnDef = {
  name: 'provider',
  type: 'string',
  required: true,
  description: 'OpenShell provider instance name (as created by `openshell provider create --name`).',
};
const PROFILE_SOURCE_ARGS: ColumnDef[] = [
  { name: 'file', type: 'string', description: 'Path to a provider profile YAML file. Give this or --yaml.' },
  { name: 'yaml', type: 'string', description: 'The profile YAML inline. Give this or --file.' },
  { name: 'global', type: 'boolean', description: 'Platform-scoped profile (OpenShell --global).' },
];

registerResource({
  name: 'openshell-provider',
  plural: 'openshell-provider',
  // Not DB-backed through crud: no generic CRUD verbs are enabled.
  table: '',
  idColumn: 'group',
  description:
    'NVIDIA OpenShell providers, via the configured `openshell` CLI. attach/detach/list: durable per-agent-group ' +
    'provider attachments — every sandbox created for the group gets them, and live sandboxes are updated at once. ' +
    'profile-list/import/update: system-wide provider profiles. Operator-only.',
  columns: [GROUP_ARG, PROVIDER_ARG],
  operations: {},
  customOperations: {
    attach: {
      access: 'approval',
      hostOnly: true,
      description:
        "Attach a provider to an agent group, durably: saved to the group's config so every new sandbox is created " +
        "with `--provider <name>`, and attached now to each of the group's live sandboxes " +
        '(`openshell sandbox provider attach <sandbox> <provider>`). The provider must exist (`openshell provider get`).',
      args: [GROUP_ARG, PROVIDER_ARG],
      examples: ['ncl openshell-provider attach --group main --provider granola'],
      handler: (args, ctx) => changeGroupProvider('attach', args, ctx),
      formatHuman: renderChange,
    },
    detach: {
      access: 'approval',
      hostOnly: true,
      description:
        "Detach a provider from an agent group: removed from the group's config (new sandboxes no longer get it) and " +
        "detached now from each of the group's live sandboxes (`openshell sandbox provider detach`).",
      args: [GROUP_ARG, PROVIDER_ARG],
      examples: ['ncl openshell-provider detach --group main --provider granola'],
      handler: (args, ctx) => changeGroupProvider('detach', args, ctx),
      formatHuman: renderChange,
    },
    list: {
      access: 'open',
      hostOnly: true,
      description:
        "List the providers attached to an agent group, and the group's live sandboxes (best effort: the group's " +
        'list is shown even when the gateway cannot be reached).',
      args: [GROUP_ARG],
      examples: ['ncl openshell-provider list --group main'],
      handler: async (args): Promise<GroupProviderList> => {
        const group = await resolveGroup(args.group);
        const base = {
          group: { id: group.id, name: group.name, folder: group.folder },
          providers: await getGroupOpenShellProviders(group.id),
        };
        try {
          return { ...base, sandboxes: await liveSandboxesForGroup(group.id) };
        } catch (err) {
          return { ...base, sandboxesError: message(err) };
        }
      },
      formatHuman: renderList,
    },
    'profile-list': {
      access: 'open',
      hostOnly: true,
      description: 'List provider profiles on the gateway (`openshell provider profile list`). System-wide.',
      args: [
        {
          name: 'output',
          type: 'string',
          description: 'Output format.',
          enum: ['table', 'json', 'yaml'],
          default: 'table',
        },
        { name: 'global', type: 'boolean', description: 'Platform-scoped profiles (OpenShell --global).' },
      ],
      examples: ['ncl openshell-provider profile-list', 'ncl openshell-provider profile-list --output json'],
      handler: async (args): Promise<ProfileCommandResult> => {
        const command = profileListArgs({ output: args.output as ProfileOutput, global: args.global === true });
        return { command, output: await runCli(command) };
      },
      formatHuman: renderProfile,
    },
    'profile-import': {
      access: 'approval',
      hostOnly: true,
      description:
        'Import a provider profile (`openshell provider profile import -f <file>`), from a file path or inline YAML ' +
        '(staged in a private temp file, removed afterwards). System-wide: no group. Logged.',
      args: PROFILE_SOURCE_ARGS,
      examples: [
        'ncl openshell-provider profile-import --file ./granola.yaml',
        'ncl openshell-provider profile-import --yaml "$(cat granola.yaml)"',
      ],
      handler: (args, ctx) =>
        withProfileFile(args, (file) =>
          runLoggedProfile('profile-import', profileImportArgs(file, { global: args.global === true }), ctx),
        ),
      formatHuman: renderProfile,
    },
    'profile-update': {
      access: 'approval',
      hostOnly: true,
      description:
        'Replace an existing custom provider profile (`openshell provider profile update <id> -f <file>`), from a ' +
        'file path or inline YAML. System-wide: no group. Logged.',
      args: [
        { name: 'id', type: 'string', required: true, description: 'Profile id to update.' },
        ...PROFILE_SOURCE_ARGS,
      ],
      examples: ['ncl openshell-provider profile-update granola --file ./granola.yaml'],
      handler: async (args, ctx) => {
        const id = assertProfileId(args.id);
        return withProfileFile(args, (file) =>
          runLoggedProfile('profile-update', profileUpdateArgs(id, file, { global: args.global === true }), ctx, id),
        );
      },
      formatHuman: renderProfile,
    },
  },
});
