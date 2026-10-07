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
import path from 'node:path';

import {
  MAX_PROFILE_YAML,
  credentialScriptEnv,
  groupProvidersFrame,
  missingDeclaredCredentials,
  parseCredentialSource,
  parseRuleChunks,
  policyAddRuleFrame,
  policyApplyPresetFrame,
  policyApproveFrame,
  policyListFrame,
  policyRejectFrame,
  policyViewFrame,
  profileImportFrame,
  profileListFrame,
  providerAttachFrame,
  providerCreateInvocation,
  providerDetachFrame,
  providerGetArgs,
  providerListArgs,
  type CredentialSubmission,
  type NclFrame,
  type PolicyFrame,
  type ProviderCreateInput,
  type RuleChunk,
} from './commands.js';
import {
  ACTOR,
  appendDecision,
  groupAudit,
  mergeHistory,
  readDecisions,
  readPolicyChanges,
  readProviderChangeLines,
} from './history.js';
import { PROVIDER_PROFILES, isGenericType } from './profiles.js';

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
  /** An `ncl openshell-provider-*` request, as the host caller (needs the central DB). */
  dispatchProvider(frame: NclFrame): Promise<DispatchResult>;
  /** Agent groups, for the group selector (central DB). */
  listGroups(): Promise<GroupSummary[]>;
  /** Every sandbox name the group has had — one per session (central DB), live or not. */
  groupSandboxNames(groupId: string): Promise<string[]>;
  /** The egress presets `apply-preset` accepts. */
  listPresets(): PresetSummary[];
  /** The add-openshell skill's `scripts/auth.ts claude` with this environment. */
  runCredentialScript(env: NodeJS.ProcessEnv): Promise<ExecResult>;
  /** setup/verify.ts checkCredentials() for this install. */
  checkCredentials(): { credentials: string; credentialSource: string };
  gatewayKind(): string;
  decisionLog: string;
  /** `ncl openshell-policy add-rule|apply-preset` log: data/openshell-policy/changes.jsonl. */
  policyChangeLog: string;
  /** `ncl openshell-provider-*` log: data/openshell-provider/changes.jsonl. */
  providerChangeLog: string;
  staticDir: string;
  now?: () => Date;
}

export interface GroupSummary {
  id: string;
  name: string;
  folder: string;
}

export interface PresetSummary {
  name: string;
  version: number;
  description: string;
}

const MAX_BODY = 64 * 1024;
/** Profile YAML travels in the body: its own cap plus JSON-escaping headroom. */
const MAX_PROFILE_BODY = MAX_PROFILE_YAML * 2 + 4096;

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

async function readJson(req: IncomingMessage, maxBody = MAX_BODY): Promise<Record<string, unknown>> {
  const type = String(req.headers['content-type'] ?? '');
  if (!type.toLowerCase().startsWith('application/json'))
    throw new HttpError(415, 'POST bodies must be application/json');
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBody) throw new HttpError(413, 'Request body too large');
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

function failure(r: DispatchResult): { error?: string } {
  return r.ok ? {} : { error: r.error?.message ?? 'unknown error' };
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

export function createHandler(deps: UiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? (() => new Date());

  async function decide(decision: 'approved' | 'rejected', body: Record<string, unknown>) {
    const frame =
      decision === 'approved'
        ? policyApproveFrame(body.sandbox, body.chunkId)
        : policyRejectFrame(body.sandbox, body.chunkId, body.reason);
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
      send(res, 200, {
        gateway: deps.gatewayKind(),
        credential: { credentials: cred.credentials, ...parseCredentialSource(cred.credentialSource) },
        providerTypes: PROVIDER_PROFILES.map((p) => ({ ...p, generic: p.credentialKeys.length === 0 })),
      });
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
      // The confirmation is what the relay will actually see, read back the way verify does.
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
      const create = scrubExec(await deps.runOpenShell(invocation.args, invocation.env), secrets);
      // Read-back evidence: what the gateway now holds under that name.
      const readBack =
        create.code === 0 ? scrubExec(await deps.runOpenShell(providerGetArgs(input.name), {}), secrets) : undefined;
      send(res, create.code === 0 ? 200 : 502, {
        ok: create.code === 0,
        argv: ['openshell', ...invocation.args], // credential KEY names only; values went via the environment
        generic: isGenericType(input.type),
        missingDeclaredCredentials: missingDeclaredCredentials(input),
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

    // ---- network paths: direct edits (add-rule / apply-preset) -------------------

    if (method === 'GET' && url.pathname === '/api/presets') {
      send(res, 200, { presets: deps.listPresets() });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/policy/add-rule') {
      const body = await readJson(req);
      const frame = input(() =>
        policyAddRuleFrame(body.sandbox, {
          addEndpoint: body.addEndpoint as string,
          removeEndpoint: body.removeEndpoint as string,
          removeRule: body.removeRule as string,
          binary: body.binary as string,
          ruleName: body.ruleName as string,
          anyBinary: body.anyBinary === true,
          dryRun: body.dryRun === true,
        }),
      );
      const result = await deps.dispatchPolicy(frame);
      send(res, result.ok ? 200 : 502, { ok: result.ok, ...policyData(result), ...failure(result) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/policy/apply-preset') {
      const body = await readJson(req);
      const frame = input(() => policyApplyPresetFrame(body.sandbox, body.preset, body.dryRun));
      const result = await deps.dispatchPolicy(frame);
      send(res, result.ok ? 200 : 502, { ok: result.ok, result: result.data ?? null, ...failure(result) });
      return;
    }

    // ---- system-wide: provider profiles ------------------------------------------

    if (method === 'GET' && url.pathname === '/api/profiles') {
      const result = await deps.dispatchProvider(profileListFrame());
      send(res, result.ok ? 200 : 502, { ok: result.ok, ...policyData(result), ...failure(result) });
      return;
    }

    if (method === 'POST' && url.pathname === '/api/profiles') {
      const body = await readJson(req, MAX_PROFILE_BODY);
      const frame = input(() => profileImportFrame(body.yaml, body.global));
      const result = await deps.dispatchProvider(frame);
      send(res, result.ok ? 200 : 502, { ok: result.ok, ...policyData(result), ...failure(result) });
      return;
    }

    // ---- per agent group ------------------------------------------------------------

    if (method === 'GET' && url.pathname === '/api/groups') {
      send(res, 200, { groups: await deps.listGroups() });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/group/providers') {
      const result = await deps.dispatchProvider(input(() => groupProvidersFrame(url.searchParams.get('group'))));
      send(res, result.ok ? 200 : 502, { ok: result.ok, ...((result.data as object) ?? {}), ...failure(result) });
      return;
    }

    if (
      method === 'POST' &&
      (url.pathname === '/api/group/providers/attach' || url.pathname === '/api/group/providers/detach')
    ) {
      const body = await readJson(req);
      const frame = input(() =>
        url.pathname.endsWith('/attach')
          ? providerAttachFrame(body.group, body.provider)
          : providerDetachFrame(body.group, body.provider),
      );
      // The resource persists, applies to live sandboxes, and writes the audit log.
      const result = await deps.dispatchProvider(frame);
      send(res, result.ok ? 200 : 502, { ok: result.ok, result: result.data ?? null, ...failure(result) });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/audit') {
      const groupId = input(() => {
        const g = url.searchParams.get('group')?.trim();
        if (!g) throw new Error('An agent group is required');
        return g;
      });
      const listing = await deps.dispatchProvider(groupProvidersFrame(groupId));
      const live = listing.ok
        ? (((listing.data as { sandboxes?: { name: string }[] }).sandboxes ?? []).map((s) => s.name) as string[])
        : [];
      const sandboxes = new Set([...(await deps.groupSandboxNames(groupId)), ...live]);
      // Decisions OpenShell holds for the live sandboxes that no local log recorded.
      const decisions = readDecisions(deps.decisionLog);
      const openshellOnly = [];
      const remoteErrors: string[] = [];
      for (const sandbox of live) {
        const [approved, rejected] = await Promise.all(
          (['approved', 'rejected'] as const).map((s) => deps.dispatchPolicy(policyListFrame(sandbox, s))),
        );
        if (!approved.ok || !rejected.ok) {
          remoteErrors.push(`${sandbox}: ${(approved.ok ? rejected : approved).error?.message ?? 'listing failed'}`);
          continue;
        }
        const remote = {
          sandbox,
          approved: parseRuleChunks(policyData(approved).output),
          rejected: parseRuleChunks(policyData(rejected).output),
        };
        openshellOnly.push(...mergeHistory(decisions, remote, sandbox).filter((h) => h.source === 'openshell'));
      }
      send(res, 200, {
        group: groupId,
        sandboxes: [...sandboxes],
        logFiles: [deps.providerChangeLog, deps.policyChangeLog, deps.decisionLog],
        entries: groupAudit({
          groupId,
          sandboxes,
          decisions,
          policyChanges: readPolicyChanges(deps.policyChangeLog),
          providerChanges: readProviderChangeLines(deps.providerChangeLog),
          openshellOnly,
        }),
        ...(listing.ok ? {} : { liveError: listing.error?.message ?? 'could not list live sandboxes' }),
        ...(remoteErrors.length ? { remoteErrors } : {}),
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
