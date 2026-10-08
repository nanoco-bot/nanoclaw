/**
 * Same-origin JSON API + static page for the OpenShell setup UI.
 *
 * Every side effect comes in through `UiDeps`, so tests drive real requests
 * through this handler with the CLIs mocked. No app-level auth by design: the
 * server sits behind the operator's password-gated reverse proxy. POSTs must
 * be `application/json`, which a cross-site page cannot send without a CORS
 * preflight this server never grants — a CSRF backstop, not authentication.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  chunkEndpoints,
  credentialScriptEnv,
  missingDeclaredCredentials,
  parseCredentialSource,
  parseRuleChunks,
  policyApproveFrame,
  policyListFrame,
  policyRejectFrame,
  policyViewFrame,
  providerCreateInvocation,
  providerGetArgs,
  providerListArgs,
  type CredentialSubmission,
  type PolicyFrame,
  type ProviderCreateInput,
  type RuleChunk,
} from './commands.js';
import {
  groupAudit,
  sandboxCandidates,
  type ChangeRecord,
  type GroupSummary,
  type SessionSummary,
} from './group-view.js';
import { ACTOR, appendDecision, mergeHistory, readDecisions } from './history.js';
import { isGenericType, mergeProfiles, type CustomProfileInput, type ProfileTemplate } from './profiles.js';
import {
  buildProfileYaml,
  parseGatewayTypes,
  profileDeleteArgs,
  profileImportArgs,
  profileListArgs,
  yamlProfileId,
  type NewTypeInput,
} from './provider-types.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface DispatchResult {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface UiDeps {
  /** `openshell <args>` with `env` added to the child environment. */
  runOpenShell(args: string[], env: Record<string, string>): Promise<ExecResult>;
  /** An `ncl openshell-policy-*` request, as the host caller. */
  dispatchPolicy(frame: PolicyFrame): Promise<DispatchResult>;
  /**
   * Any other `ncl` request the UI makes (custom provider profiles, per-group
   * OpenShell resources), as the host caller — in-process, against the
   * central DB. Same validation and storage as `ncl` itself.
   */
  dispatchNcl(frame: PolicyFrame): Promise<DispatchResult>;
  /**
   * `ncl groups restart --id <group>` on the HOST (over its ncl socket): the
   * host process owns the containers, so this process cannot restart them.
   */
  restartGroup(agentGroupId: string): Promise<DispatchResult>;
  /** The add-openshell skill's `scripts/auth.ts claude` with this environment. */
  runCredentialScript(env: NodeJS.ProcessEnv): Promise<ExecResult>;
  /** setup/verify.ts checkCredentials() for this install. */
  checkCredentials(): { credentials: string; credentialSource: string };
  gatewayKind(): string;
  /** Agent groups (central DB), for the per-group tabs. */
  listGroups(): Promise<GroupSummary[]>;
  /** A group's sessions (central DB): each is one OpenShell sandbox. */
  groupSessions(agentGroupId: string): Promise<SessionSummary[]>;
  /** The sandbox name the OpenShell driver gives a session (realize.ts sandboxName). */
  sandboxName(agentGroupId: string, sessionId: string): string;
  /** The ncl change log (data/openshell-policy/changes.jsonl). */
  changeLog: string;
  decisionLog: string;
  staticDir: string;
  now?: () => Date;
}

const MAX_BODY = 64 * 1024;

/** Build a frame/argv from request input; a validation error is the client's (400). */
function input<T>(build: () => T): T {
  try {
    return build();
  } catch (err) {
    throw new HttpError(400, (err as Error).message);
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'POST bodies must be application/json');
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    parts.push(chunk as Buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body is not a JSON object');
  }
}

/** Never echo a submitted secret back, even if a child process printed it. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[redacted]');
  return out;
}

function scrubExec(r: ExecResult, secrets: string[]): ExecResult {
  return { code: r.code, stdout: scrub(r.stdout, secrets), stderr: scrub(r.stderr, secrets) };
}

function keyValues(v: unknown, what: string): { key: string; value: string }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `${what} must be a list of {key, value}`);
  return v
    .filter(
      (row) =>
        row &&
        (String((row as { key?: unknown }).key ?? '').trim() || String((row as { value?: unknown }).value ?? '')),
    )
    .map((row) => ({
      key: String((row as { key?: unknown }).key ?? ''),
      value: String((row as { value?: unknown }).value ?? ''),
    }));
}

function policyData(r: DispatchResult): { output: string; note?: string; proposals?: string } {
  const d = (r.data ?? {}) as { output?: unknown; note?: unknown; proposals?: unknown };
  return {
    output: typeof d.output === 'string' ? d.output : '',
    ...(typeof d.note === 'string' ? { note: d.note } : {}),
    ...(typeof d.proposals === 'string' ? { proposals: d.proposals } : {}),
  };
}

/** The ncl change log, parsed leniently (torn / foreign lines skipped). */
function readChangeLog(file: string): ChangeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: ChangeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ChangeRecord;
      if (r && typeof r.verb === 'string' && typeof r.ts === 'string') out.push(r);
    } catch {
      // skip
    }
  }
  return out;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

export function createHandler(deps: UiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? (() => new Date());

  async function findGroup(id: string | null): Promise<GroupSummary> {
    if (!id) throw new HttpError(400, 'An agent group is required (?group=<id>)');
    const group = (await deps.listGroups()).find((g) => g.id === id);
    if (!group) throw new HttpError(404, `agent group not found: ${id}`);
    return group;
  }

  async function candidates(group: GroupSummary) {
    const sessions = await deps.groupSessions(group.id);
    return {
      live: sandboxCandidates(sessions, (sessionId) => deps.sandboxName(group.id, sessionId)),
      all: new Set(sessions.map((s) => deps.sandboxName(group.id, s.id))),
    };
  }

  /** An ncl call on the group's behalf; a refusal is the client's (400), with ncl's reason. */
  async function ncl(command: string, args: Record<string, unknown>, secrets: string[] = []): Promise<unknown> {
    const r = await deps.dispatchNcl({ command, args });
    if (!r.ok) throw new HttpError(400, scrub(r.error?.message ?? `${command} failed`, secrets));
    return r.data;
  }

  /** Shipped + custom templates; custom ones unavailable (e.g. no DB yet) degrade to shipped only, with the reason. */
  async function templates(): Promise<{ templates: ProfileTemplate[]; customError?: string }> {
    const r = await deps.dispatchNcl({ command: 'openshell-provider-profile-list', args: {} });
    if (!r.ok) return { templates: mergeProfiles([]), customError: r.error?.message ?? 'custom profiles unavailable' };
    const custom = ((r.data as { profiles?: CustomProfileInput[] } | undefined)?.profiles ??
      []) as CustomProfileInput[];
    return { templates: mergeProfiles(custom) };
  }

  /** The provider types the OpenShell gateway knows; a failed listing is reported, not thrown. */
  async function gatewayTypes(): Promise<{ types: ReturnType<typeof parseGatewayTypes>; error?: string }> {
    const run = await deps.runOpenShell(profileListArgs(), {});
    if (run.code !== 0) return { types: [], error: (run.stderr || run.stdout).trim() || 'profile list failed' };
    try {
      return { types: parseGatewayTypes(run.stdout) };
    } catch (err) {
      return { types: [], error: (err as Error).message };
    }
  }

  async function decide(decision: 'approved' | 'rejected', body: Record<string, unknown>) {
    const frame =
      decision === 'approved'
        ? policyApproveFrame(body.sandbox, body.chunkId)
        : policyRejectFrame(body.sandbox, body.chunkId, body.reason);
    // From a group tab: record the group too, so its audit log finds the decision.
    const group = body.group !== undefined && body.group !== '' ? await findGroup(String(body.group)) : undefined;
    const result = await deps.dispatchPolicy(frame);
    const sandbox = String(frame.args.sandbox);
    const chunkId = String(frame.args.chunk_id);
    appendDecision(deps.decisionLog, {
      ts: now().toISOString(),
      sandbox,
      chunkId,
      decision,
      ...(decision === 'rejected' ? { reason: String(frame.args.reason) } : {}),
      ok: result.ok,
      ...(result.ok ? {} : { error: result.error?.message ?? 'unknown error' }),
      actor: ACTOR,
      ...(group ? { group: { id: group.id, folder: group.folder } } : {}),
    });
    return {
      status: result.ok ? 200 : 502,
      body: {
        ok: result.ok,
        decision,
        sandbox,
        chunkId,
        ...policyData(result),
        ...(result.ok ? {} : { error: result.error?.message }),
      },
    };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ui.local');
    const method = req.method ?? 'GET';

    const asset = STATIC[url.pathname];
    if (method === 'GET' && asset) {
      const body = fs.readFileSync(path.join(deps.staticDir, asset.file));
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/status') {
      const cred = deps.checkCredentials();
      const t = await templates();
      send(res, 200, {
        gateway: deps.gatewayKind(),
        credential: { credentials: cred.credentials, ...parseCredentialSource(cred.credentialSource) },
        providerTypes: t.templates,
        ...(t.customError ? { customProfilesError: t.customError } : {}),
      });
      return;
    }

    // ---- per-agent-group tabs -------------------------------------------------
    if (method === 'GET' && url.pathname === '/api/groups') {
      send(res, 200, { groups: await deps.listGroups() });
      return;
    }

    if (url.pathname === '/api/groups/providers') {
      if (method === 'GET') {
        const group = await findGroup(url.searchParams.get('group'));
        send(res, 200, { group, ...((await ncl('openshell-provider-list', { group: group.id })) as object) });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const group = await findGroup(String(body.group ?? ''));
        const credentials = Object.fromEntries(
          keyValues(body.credentials, 'credentials').map((c) => [c.key.trim(), c.value]),
        );
        const config = Object.fromEntries(keyValues(body.config, 'config').map((c) => [c.key.trim(), c.value]));
        const type = String(body.type ?? '').trim();
        const secrets = Object.values(credentials);
        const data = await ncl(
          'openshell-provider-attach',
          {
            group: group.id,
            openshell_provider: String(body.name ?? ''),
            ...(type ? { type } : {}),
            ...(Object.keys(credentials).length ? { credentials } : {}),
            ...(Object.keys(config).length ? { config } : {}),
          },
          secrets,
        );
        // A provider attached live reaches new processes only; the agent's own
        // process keeps the environment it started with. Restarting gives it a
        // sandbox created with the provider. Never undoes the attach.
        const live = ((data as { live?: { ok: boolean }[] }).live ?? []).filter((l) => l.ok);
        let restart: { ok: boolean; restarted?: number; error?: string } | undefined;
        if (body.restart === true && live.length > 0) {
          const r = await deps.restartGroup(group.id);
          restart = r.ok
            ? { ok: true, restarted: Number((r.data as { restarted?: unknown })?.restarted ?? 0) }
            : { ok: false, error: r.error?.message ?? 'restart failed' };
        }
        send(res, 200, { ok: true, group, ...(data as object), ...(restart ? { restart } : {}) });
        return;
      }
      if (method === 'DELETE') {
        const group = await findGroup(url.searchParams.get('group'));
        const data = await ncl('openshell-provider-detach', {
          group: group.id,
          openshell_provider: url.searchParams.get('name') ?? '',
        });
        send(res, 200, { ok: true, group, ...(data as object) });
        return;
      }
    }

    if (url.pathname === '/api/groups/network') {
      if (method === 'GET') {
        const group = await findGroup(url.searchParams.get('group'));
        send(res, 200, { group, ...((await ncl('openshell-network-list', { group: group.id })) as object) });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const group = await findGroup(String(body.group ?? ''));
        const binaries = Array.isArray(body.binaries) ? body.binaries.map(String) : [String(body.binaries ?? '')];
        const data = await ncl('openshell-network-add', {
          group: group.id,
          name: String(body.name ?? ''),
          host: String(body.host ?? ''),
          ports: Array.isArray(body.ports) ? body.ports.join(',') : String(body.ports ?? ''),
          binary: JSON.stringify(binaries.map((b: string) => b.trim()).filter(Boolean)),
        });
        send(res, 200, { ok: true, group, ...(data as object) });
        return;
      }
      if (method === 'DELETE') {
        const group = await findGroup(url.searchParams.get('group'));
        const data = await ncl('openshell-network-remove', {
          group: group.id,
          name: url.searchParams.get('name') ?? '',
        });
        send(res, 200, { ok: true, group, ...(data as object) });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/groups/policy') {
      const group = await findGroup(url.searchParams.get('group'));
      const { live } = await candidates(group);
      const requested = url.searchParams.get('sandbox')?.trim();
      const chosen = requested ? live.find((c) => c.sandbox === requested) : live[0];
      if (requested && !chosen)
        throw new HttpError(400, `sandbox ${requested} is not a live sandbox of ${group.folder}`);
      if (!chosen) {
        send(res, 200, {
          ok: true,
          group,
          sandbox: null,
          sandboxes: [],
          chunks: [],
          note: `${group.folder} has no live session, so no sandbox to review.`,
        });
        return;
      }
      const frame = input(() => policyListFrame(chosen.sandbox, url.searchParams.get('status') || 'pending'));
      const result = await deps.dispatchPolicy(frame);
      const data = policyData(result);
      send(res, result.ok ? 200 : 502, {
        ok: result.ok,
        group,
        sandbox: chosen.sandbox,
        sandboxes: live,
        status: frame.args.status,
        ...data,
        chunks: parseRuleChunks(data.output).map((c) => ({ ...c, targets: chunkEndpoints(c) })),
        ...(result.ok ? {} : { error: result.error?.message }),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/groups/audit') {
      const group = await findGroup(url.searchParams.get('group'));
      const { live, all } = await candidates(group);
      const decisions = readDecisions(deps.decisionLog);
      // OpenShell's own approved/rejected listing for the default sandbox, as /api/history does.
      let remote: ReturnType<typeof mergeHistory> | undefined;
      let remoteError: string | undefined;
      if (live[0]) {
        const sandbox = live[0].sandbox;
        const [approved, rejected] = await Promise.all(
          (['approved', 'rejected'] as const).map((st) => deps.dispatchPolicy(policyListFrame(sandbox, st))),
        );
        if (approved.ok && rejected.ok) {
          remote = mergeHistory(decisions, {
            sandbox,
            approved: parseRuleChunks(policyData(approved).output),
            rejected: parseRuleChunks(policyData(rejected).output),
          });
        } else remoteError = (approved.ok ? rejected : approved).error?.message ?? 'OpenShell listing failed';
      }
      send(res, 200, {
        group,
        logs: { changes: deps.changeLog, decisions: deps.decisionLog },
        entries: groupAudit({ group, sandboxes: all, changes: readChangeLog(deps.changeLog), decisions, remote }),
        ...(remoteError ? { remoteError } : {}),
      });
      return;
    }

    // ---- OpenShell provider types (gateway profiles) ------------------------------
    if (url.pathname === '/api/types') {
      if (method === 'GET') {
        send(res, 200, await gatewayTypes());
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        let id: string;
        let yaml: string;
        try {
          if (typeof body.yaml === 'string' && body.yaml.trim()) {
            yaml = body.yaml;
            id = yamlProfileId(yaml);
          } else ({ id, yaml } = buildProfileYaml(body as unknown as NewTypeInput));
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        if ((await gatewayTypes()).types.some((t) => t.id === id))
          throw new HttpError(409, `OpenShell already has a provider type '${id}'; delete it first to replace it`);
        // `profile import` reads a file; the profile holds no credential value.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-profile-'));
        const file = path.join(dir, `${id}.yaml`);
        let run: ExecResult;
        try {
          fs.writeFileSync(file, yaml, { mode: 0o600 });
          run = await deps.runOpenShell(profileImportArgs(file), {});
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
        if (run.code !== 0)
          throw new HttpError(400, (run.stderr || run.stdout).trim() || 'openshell provider profile import failed');
        send(res, 200, { ok: true, id, yaml, ...(await gatewayTypes()) });
        return;
      }
      if (method === 'DELETE') {
        const args = input(() => profileDeleteArgs(url.searchParams.get('id') ?? ''));
        const run = await deps.runOpenShell(args, {});
        if (run.code !== 0)
          throw new HttpError(400, (run.stderr || run.stdout).trim() || 'openshell provider profile delete failed');
        send(res, 200, { ok: true, ...(await gatewayTypes()) });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/gateway') {
      const [status, version] = await Promise.all([
        deps.runOpenShell(['status'], {}),
        deps.runOpenShell(['--version'], {}),
      ]);
      // eslint-disable-next-line no-control-regex
      const text = status.stdout.replace(/\x1b\[[0-9;]*m/g, '');
      send(res, 200, {
        connected: status.code === 0 && /Status:\s*Connected/i.test(text),
        version: (version.stdout.match(/\d+\.\d+\.\d+\S*/) ?? [''])[0],
        server: (text.match(/Server:\s*(\S+)/) ?? [, ''])[1],
        ...(status.code === 0 ? {} : { error: (status.stderr || status.stdout).trim().split('\n').pop() }),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/profiles') {
      send(res, 200, await templates());
      return;
    }

    if (method === 'POST' && url.pathname === '/api/profiles') {
      const body = await readJson(req);
      const list = (v: unknown) =>
        Array.isArray(v) ? v.map(String).join(',') : v === undefined ? undefined : String(v);
      const r = await deps.dispatchNcl({
        command: 'openshell-provider-profile-create',
        args: {
          id: String(body.id ?? ''),
          ...(body.label !== undefined ? { label: String(body.label) } : {}),
          ...(body.type !== undefined && body.type !== '' ? { type: String(body.type) } : {}),
          ...(list(body.credentialKeys) !== undefined ? { credential_keys: list(body.credentialKeys) } : {}),
          ...(list(body.configKeys) !== undefined ? { config_keys: list(body.configKeys) } : {}),
          ...(body.description !== undefined ? { description: String(body.description) } : {}),
        },
      });
      if (!r.ok) throw new HttpError(400, r.error?.message ?? 'could not save the profile');
      send(res, 200, { ok: true, ...((r.data as object) ?? {}), ...(await templates()) });
      return;
    }

    if (method === 'DELETE' && url.pathname === '/api/profiles') {
      const id = url.searchParams.get('id') ?? '';
      const r = await deps.dispatchNcl({ command: 'openshell-provider-profile-delete', args: { id } });
      if (!r.ok) throw new HttpError(400, r.error?.message ?? 'could not delete the profile');
      send(res, 200, { ok: true, id, ...(await templates()) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/credential') {
      const body = await readJson(req);
      const submission = { kind: body.kind, value: body.value } as CredentialSubmission;
      let env: NodeJS.ProcessEnv;
      try {
        env = credentialScriptEnv(submission);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const run = scrubExec(await deps.runCredentialScript(env), [String(body.value ?? '')]);
      // The confirmation is read back from OpenShell, the way verify does.
      const cred = deps.checkCredentials();
      const detected = parseCredentialSource(cred.credentialSource);
      send(res, run.code === 0 && cred.credentials === 'configured' ? 200 : 502, {
        ok: run.code === 0 && cred.credentials === 'configured',
        script: run,
        credential: { credentials: cred.credentials, ...detected },
        gateway: deps.gatewayKind(),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/providers') {
      send(res, 200, { list: await deps.runOpenShell(providerListArgs(), {}) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/providers') {
      const body = await readJson(req);
      const input: ProviderCreateInput = {
        name: String(body.name ?? ''),
        type: String(body.type ?? ''),
        credentials: keyValues(body.credentials, 'credentials'),
        config: keyValues(body.config, 'config'),
        globalProfile: body.globalProfile === true,
      };
      let invocation;
      try {
        invocation = providerCreateInvocation(input);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const secrets = Object.values(invocation.env);
      const { templates: known } = await templates();
      const create = scrubExec(await deps.runOpenShell(invocation.args, invocation.env), secrets);
      // Read-back evidence: what the gateway now holds under that name.
      const readBack =
        create.code === 0 ? scrubExec(await deps.runOpenShell(providerGetArgs(input.name), {}), secrets) : undefined;
      send(res, create.code === 0 ? 200 : 502, {
        ok: create.code === 0,
        argv: ['openshell', ...invocation.args], // credential KEY names only; values went via the environment
        generic: isGenericType(input.type, known),
        missingDeclaredCredentials: missingDeclaredCredentials(input, known),
        create,
        ...(readBack ? { readBack } : {}),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/policy') {
      const frame = input(() =>
        policyListFrame(url.searchParams.get('sandbox'), url.searchParams.get('status') || 'pending'),
      );
      const result = await deps.dispatchPolicy(frame);
      const data = policyData(result);
      send(res, result.ok ? 200 : 502, {
        ok: result.ok,
        sandbox: frame.args.sandbox,
        status: frame.args.status,
        ...data,
        chunks: parseRuleChunks(data.output),
        ...(result.ok ? {} : { error: result.error?.message }),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/policy/view') {
      const result = await deps.dispatchPolicy(input(() => policyViewFrame(url.searchParams.get('sandbox'))));
      const data = policyData(result);
      let policy: unknown;
      try {
        policy = JSON.parse(data.output);
      } catch {
        policy = undefined; // show the raw text instead
      }
      send(res, result.ok ? 200 : 502, {
        ok: result.ok,
        output: data.output,
        ...(policy !== undefined ? { policy } : {}),
        ...(result.ok ? {} : { error: result.error?.message }),
      });
      return;
    }

    if (method === 'POST' && (url.pathname === '/api/policy/approve' || url.pathname === '/api/policy/reject')) {
      const body = await readJson(req);
      let outcome;
      try {
        outcome = await decide(url.pathname.endsWith('approve') ? 'approved' : 'rejected', body);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, (err as Error).message);
      }
      send(res, outcome.status, outcome.body);
      return;
    }

    if (method === 'GET' && url.pathname === '/api/history') {
      const sandbox = url.searchParams.get('sandbox')?.trim() || undefined;
      const local = readDecisions(deps.decisionLog);
      let remote: { sandbox: string; approved: RuleChunk[]; rejected: RuleChunk[] } | undefined;
      let remoteError: string | undefined;
      if (sandbox) {
        const [approved, rejected] = await Promise.all(
          (['approved', 'rejected'] as const).map((s) => deps.dispatchPolicy(policyListFrame(sandbox, s))),
        );
        if (approved.ok && rejected.ok) {
          remote = {
            sandbox,
            approved: parseRuleChunks(policyData(approved).output),
            rejected: parseRuleChunks(policyData(rejected).output),
          };
        } else {
          remoteError = (approved.ok ? rejected : approved).error?.message ?? 'OpenShell listing failed';
        }
      }
      send(res, 200, {
        logFile: deps.decisionLog,
        entries: mergeHistory(local, remote, sandbox),
        ...(remoteError ? { remoteError } : {}),
      });
      return;
    }

    throw new HttpError(404, 'Not found');
  }

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  };
}
