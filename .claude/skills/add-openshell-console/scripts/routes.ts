/**
 * Same-origin JSON API + static page for the OpenShell setup console.
 *
 * A group's providers and network rules are saved in the OpenShell policy
 * file (the driver reads it for every new sandbox) and applied to the group's
 * running sandboxes with the `openshell` CLI. Blocked requests are OpenShell's
 * rule proposals. Every side effect comes in through `UiDeps`, so tests drive
 * real requests through this handler with the CLI mocked.
 *
 * No login of its own: the server binds localhost by default and is reached
 * through an SSH tunnel or the operator's password-gated proxy.
 */
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  addGroupProvider,
  putGroupEgressRule,
  readPolicyFile,
  removeGroupEgressRule,
  removeGroupProvider,
} from '../../../../src/drivers/openshell/policy-file.js';
import { appendActivity, readActivity, type ActivityRecord } from './activity.js';
import { sandboxCandidates, type GroupSummary, type SessionSummary } from './group-view.js';
import { HttpError, input, readJson, scrub, send } from './http.js';
import {
  addRuleArgs,
  applyLive,
  assertProviderName,
  chunkEndpoints,
  credentialScriptEnv,
  egressRule,
  parseCredentialSource,
  parseProviderList,
  parseRuleChunks,
  providerCreateInvocation,
  removeRuleArgs,
  ruleDecideArgs,
  ruleGetArgs,
  sandboxProviderArgs,
  type ExecResult,
  type KeyValue,
  type LiveResult,
} from './openshell-ops.js';
import {
  buildProfileYaml,
  parseGatewayTypes,
  profileDeleteArgs,
  profileImportArgs,
  profileListArgs,
  yamlProfileId,
  type NewTypeInput,
} from './provider-types.js';

export type { ExecResult } from './openshell-ops.js';

export interface UiDeps {
  /** `openshell <args>` with `env` added to the child environment. */
  runOpenShell(args: string[], env: Record<string, string>): Promise<ExecResult>;
  /** The add-openshell skill's `scripts/auth.ts claude` with this environment. */
  runCredentialScript(env: NodeJS.ProcessEnv): Promise<ExecResult>;
  /** setup/verify.ts checkCredentials() for this install. */
  checkCredentials(): { credentials: string; credentialSource: string };
  gatewayKind(): string;
  /** Agent groups (central DB). */
  listGroups(): Promise<GroupSummary[]>;
  /** A group's sessions (central DB): each is one OpenShell sandbox. */
  groupSessions(agentGroupId: string): Promise<SessionSummary[]>;
  /** The sandbox name the OpenShell driver gives a session. */
  sandboxName(agentGroupId: string, sessionId: string): string;
  /** `ncl groups restart --id <group>` on the HOST, which owns the containers. */
  restartGroup(agentGroupId: string): Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>;
  /** The OpenShell policy file (NANOCLAW_OPENSHELL_POLICY_FILE or the default). */
  policyFile: string;
  /** The console's activity log. */
  activityLog: string;
  /** Host names besides localhost the console answers to (a proxy's), lowercase. */
  allowedHosts?: readonly string[];
  staticDir: string;
  now?: () => Date;
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** The request's host name, without port or IPv6 brackets. */
function hostName(header: string | undefined): string {
  const h = String(header ?? '').toLowerCase();
  return h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
}

/**
 * DNS rebinding and cross-site requests: the Host must be local or allowed,
 * and a browser's Origin, when sent, must be that same host.
 */
function refusedRequest(req: IncomingMessage, allowed: ReadonlySet<string>): string | undefined {
  const host = hostName(req.headers.host);
  if (!LOCAL_HOSTS.has(host) && !allowed.has(host))
    return `host '${host}' is not allowed; add it to NANOCLAW_OPENSHELL_UI_ALLOWED_HOSTS`;
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET') {
    let originHost = '';
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return 'bad Origin';
    }
    if (originHost !== String(req.headers.host ?? '').toLowerCase()) return 'cross-origin requests are refused';
  }
  return undefined;
}

const CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'";

function liveSummary(live: readonly LiveResult[]): string {
  if (live.length === 0) return 'No running sandbox to apply it to now.';
  const ok = live.filter((r) => r.ok).map((r) => r.sandbox);
  return [
    ok.length ? `Applied live to ${ok.join(', ')}.` : '',
    ...live.filter((r) => !r.ok).map((r) => `Failed on ${r.sandbox}: ${r.error}.`),
  ]
    .filter(Boolean)
    .join(' ');
}

export function createHandler(deps: UiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const now = deps.now ?? (() => new Date());

  async function findGroup(id: unknown): Promise<GroupSummary> {
    if (!id) throw new HttpError(400, 'An agent group is required (?group=<id>)');
    const group = (await deps.listGroups()).find((g) => g.id === String(id));
    if (!group) throw new HttpError(404, `agent group not found: ${String(id)}`);
    return group;
  }

  /** The group's sandboxes that can take a live change, newest running first. */
  async function liveSandboxes(group: GroupSummary) {
    const sessions = await deps.groupSessions(group.id);
    return sandboxCandidates(
      sessions.filter((s) => s.container_status === 'running' || s.container_status === 'idle'),
      (sessionId) => deps.sandboxName(group.id, sessionId),
    );
  }

  function log(group: GroupSummary, record: Omit<ActivityRecord, 'ts' | 'group'>, live: readonly LiveResult[] = []) {
    const base = { ts: now().toISOString(), group: { id: group.id, folder: group.folder } };
    appendActivity(deps.activityLog, { ...base, ...record });
    for (const l of live)
      appendActivity(deps.activityLog, {
        ...base,
        ...record,
        sandbox: l.sandbox,
        outcome: l.ok ? 'applied' : 'failed',
        ...(l.ok ? {} : { error: l.error }),
      });
  }

  function editPolicy<T>(edit: () => T): T {
    try {
      return edit();
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  }

  async function gatewayTypes(): Promise<{ types: ReturnType<typeof parseGatewayTypes>; error?: string }> {
    const run = await deps.runOpenShell(profileListArgs(), {});
    if (run.code !== 0) return { types: [], error: (run.stderr || run.stdout).trim() || 'profile list failed' };
    try {
      return { types: parseGatewayTypes(run.stdout) };
    } catch (err) {
      return { types: [], error: (err as Error).message };
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://ui.local');
    const method = req.method ?? 'GET';
    const q = (key: string) => url.searchParams.get(key) ?? '';

    const asset = STATIC[url.pathname];
    if (method === 'GET' && asset) {
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': CSP,
      });
      res.end(fs.readFileSync(path.join(deps.staticDir, asset.file)));
      return;
    }

    // ---- install-wide -------------------------------------------------------
    if (method === 'GET' && url.pathname === '/api/status') {
      const cred = deps.checkCredentials();
      send(res, 200, {
        gateway: deps.gatewayKind(),
        credential: { credentials: cred.credentials, ...parseCredentialSource(cred.credentialSource) },
      });
      return;
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

    if (method === 'POST' && url.pathname === '/api/credential') {
      const body = await readJson(req);
      const env = input(() => credentialScriptEnv({ kind: body.kind, value: body.value }));
      const secret = String(body.value ?? '');
      const r = await deps.runCredentialScript(env);
      const run = { code: r.code, stdout: scrub(r.stdout, [secret]), stderr: scrub(r.stderr, [secret]) };
      const cred = deps.checkCredentials();
      const ok = run.code === 0 && cred.credentials === 'configured';
      send(res, ok ? 200 : 502, {
        ok,
        script: run,
        credential: { credentials: cred.credentials, ...parseCredentialSource(cred.credentialSource) },
        gateway: deps.gatewayKind(),
      });
      return;
    }

    // ---- service types (OpenShell provider profiles) ---------------------------
    if (url.pathname === '/api/types') {
      if (method === 'GET') {
        send(res, 200, await gatewayTypes());
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const { id, yaml } = input(() =>
          typeof body.yaml === 'string' && body.yaml.trim()
            ? { id: yamlProfileId(body.yaml), yaml: body.yaml }
            : buildProfileYaml(body as unknown as NewTypeInput),
        );
        if ((await gatewayTypes()).types.some((t) => t.id === id))
          throw new HttpError(409, `OpenShell already has a service type '${id}'; delete it first to replace it`);
        // `profile import` reads a file; the profile holds no credential value.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-profile-'));
        let run: ExecResult;
        try {
          const file = path.join(dir, `${id}.yaml`);
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
        const run = await deps.runOpenShell(
          input(() => profileDeleteArgs(q('id'))),
          {},
        );
        if (run.code !== 0)
          throw new HttpError(400, (run.stderr || run.stdout).trim() || 'openshell provider profile delete failed');
        send(res, 200, { ok: true, ...(await gatewayTypes()) });
        return;
      }
    }

    // ---- per agent group ------------------------------------------------------
    if (method === 'GET' && url.pathname === '/api/groups') {
      send(res, 200, { groups: await deps.listGroups() });
      return;
    }

    if (url.pathname === '/api/groups/providers') {
      if (method === 'GET') {
        const group = await findGroup(q('group'));
        const names = readPolicyFile(deps.policyFile).groups?.[group.folder]?.providers ?? [];
        const known = parseProviderList((await deps.runOpenShell(['provider', 'list', '-o', 'json'], {})).stdout);
        send(res, 200, {
          group,
          providers: names.map((name) => ({
            name,
            type: known.get(name)?.type ?? null,
            credentialKeys: known.get(name)?.credentialKeys ?? [],
            missing: !known.has(name),
          })),
        });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const group = await findGroup(body.group);
        const name = input(() => assertProviderName(body.name));
        const type = String(body.type ?? '').trim();
        const credentials = (Array.isArray(body.credentials) ? body.credentials : []) as KeyValue[];
        const secrets = credentials.map((c) => String(c?.value ?? ''));
        // The provider must exist in OpenShell before a group can use it.
        let run: ExecResult;
        if (type) {
          const create = input(() => providerCreateInvocation({ name, type, credentials }));
          run = await deps.runOpenShell(create.args, create.env);
        } else {
          run = await deps.runOpenShell(['provider', 'get', name], {});
        }
        if (run.code !== 0) {
          const why = scrub((run.stderr || run.stdout).trim(), secrets);
          throw new HttpError(
            400,
            type ? `openshell provider create failed: ${why}` : `OpenShell has no provider '${name}' (${why})`,
          );
        }
        editPolicy(() => addGroupProvider(deps.policyFile, group.folder, name));
        const sandboxes = (await liveSandboxes(group)).map((c) => c.sandbox);
        const live = await applyLive(sandboxes, (sb) => [sandboxProviderArgs('attach', sb, name)], deps.runOpenShell);
        log(
          group,
          { action: 'provider-attach', detail: `provider ${name}${type ? ` (${type})` : ''}`, outcome: 'applied' },
          live,
        );
        // A live attach reaches processes OpenShell starts afterwards, not the
        // agent's own running process; a restart gives it a sandbox with the key.
        let restart: { ok: boolean; restarted?: number; error?: string } | undefined;
        if (body.restart === true && live.some((l) => l.ok)) {
          const r = await deps.restartGroup(group.id);
          restart = r.ok
            ? { ok: true, restarted: Number((r.data as { restarted?: unknown })?.restarted ?? 0) }
            : { ok: false, error: r.error?.message ?? 'restart failed' };
          log(group, {
            action: 'restart',
            detail: 'restarted the agent to pick up the provider',
            outcome: restart.ok ? 'applied' : 'failed',
            ...(restart.error ? { error: restart.error } : {}),
          });
        }
        send(res, 200, {
          ok: true,
          group,
          live,
          ...(restart ? { restart } : {}),
          message: `Attached OpenShell provider ${name} to ${group.folder}. ${liveSummary(live)}`,
        });
        return;
      }
      if (method === 'DELETE') {
        const group = await findGroup(q('group'));
        const name = input(() => assertProviderName(q('name')));
        editPolicy(() => removeGroupProvider(deps.policyFile, group.folder, name));
        const sandboxes = (await liveSandboxes(group)).map((c) => c.sandbox);
        const live = await applyLive(sandboxes, (sb) => [sandboxProviderArgs('detach', sb, name)], deps.runOpenShell);
        log(group, { action: 'provider-detach', detail: `provider ${name}`, outcome: 'applied' }, live);
        send(res, 200, {
          ok: true,
          group,
          live,
          message: `Detached OpenShell provider ${name} from ${group.folder}. ${liveSummary(live)}`,
        });
        return;
      }
    }

    if (url.pathname === '/api/groups/network') {
      if (method === 'GET') {
        const group = await findGroup(q('group'));
        send(res, 200, { group, rules: readPolicyFile(deps.policyFile).groups?.[group.folder]?.egress ?? [] });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const group = await findGroup(body.group);
        const rule = input(() =>
          egressRule({ name: body.name, host: body.host, ports: body.ports, binaries: body.binaries }),
        );
        editPolicy(() => putGroupEgressRule(deps.policyFile, group.folder, rule));
        const sandboxes = (await liveSandboxes(group)).map((c) => c.sandbox);
        const live = await applyLive(sandboxes, (sb) => addRuleArgs(sb, rule), deps.runOpenShell);
        const where = `${rule.host}:${rule.ports.join(',')}`;
        log(group, { action: 'network-add', detail: `network rule ${rule.name} ${where}`, outcome: 'applied' }, live);
        send(res, 200, {
          ok: true,
          group,
          rule,
          live,
          message: `Network rule ${rule.name} (${where}) saved for ${group.folder}. ${liveSummary(live)}`,
        });
        return;
      }
      if (method === 'DELETE') {
        const group = await findGroup(q('group'));
        const name = q('name');
        editPolicy(() => removeGroupEgressRule(deps.policyFile, group.folder, name));
        const sandboxes = (await liveSandboxes(group)).map((c) => c.sandbox);
        const live = await applyLive(sandboxes, (sb) => [removeRuleArgs(sb, name)], deps.runOpenShell);
        log(group, { action: 'network-remove', detail: `network rule ${name}`, outcome: 'applied' }, live);
        send(res, 200, {
          ok: true,
          group,
          live,
          message: `Network rule ${name} removed for ${group.folder}. ${liveSummary(live)}`,
        });
        return;
      }
    }

    if (method === 'GET' && url.pathname === '/api/groups/policy') {
      const group = await findGroup(q('group'));
      const live = await liveSandboxes(group);
      const requested = q('sandbox').trim();
      const chosen = requested ? live.find((c) => c.sandbox === requested) : live[0];
      if (requested && !chosen) throw new HttpError(400, `${requested} is not a running sandbox of ${group.folder}`);
      if (!chosen) {
        send(res, 200, { ok: true, group, sandbox: null, sandboxes: [], chunks: [] });
        return;
      }
      const run = await deps.runOpenShell(
        input(() => ruleGetArgs(chosen.sandbox, q('status') || 'pending')),
        {},
      );
      send(res, run.code === 0 ? 200 : 502, {
        ok: run.code === 0,
        group,
        sandbox: chosen.sandbox,
        sandboxes: live,
        output: run.stdout,
        chunks: parseRuleChunks(run.stdout).map((c) => ({ ...c, targets: chunkEndpoints(c) })),
        ...(run.code === 0 ? {} : { error: (run.stderr || run.stdout).trim() }),
      });
      return;
    }

    if (method === 'POST' && (url.pathname === '/api/policy/approve' || url.pathname === '/api/policy/reject')) {
      const body = await readJson(req);
      const group = await findGroup(body.group);
      const decision = url.pathname.endsWith('approve') ? 'approve' : 'reject';
      const sandbox = String(body.sandbox ?? '');
      if (!(await liveSandboxes(group)).some((c) => c.sandbox === sandbox))
        throw new HttpError(400, `${sandbox} is not a running sandbox of ${group.folder}`);
      const run = await deps.runOpenShell(
        input(() => ruleDecideArgs(decision, sandbox, body.chunkId, body.reason)),
        {},
      );
      const ok = run.code === 0;
      log(group, {
        action: decision,
        detail: `request ${String(body.chunkId)}${body.reason ? ` (${String(body.reason)})` : ''}`,
        outcome: ok ? (decision === 'approve' ? 'approved' : 'rejected') : 'failed',
        sandbox,
        ...(ok ? {} : { error: (run.stderr || run.stdout).trim() }),
      });
      send(res, ok ? 200 : 502, {
        ok,
        output: run.stdout,
        ...(ok ? {} : { error: (run.stderr || run.stdout).trim() }),
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/api/groups/audit') {
      const group = await findGroup(q('group'));
      const entries = readActivity(deps.activityLog, group.id).map((r) => ({
        ts: r.ts,
        action: r.action,
        outcome: r.outcome,
        detail: r.detail,
        ...(r.sandbox ? { sandbox: r.sandbox } : {}),
        ...(r.error ? { error: r.error } : {}),
      }));
      send(res, 200, { group, entries, logs: { activity: deps.activityLog, policy: deps.policyFile } });
      return;
    }

    throw new HttpError(404, 'Not found');
  }

  const allowed = new Set((deps.allowedHosts ?? []).map((h) => h.toLowerCase()));
  return async (req, res) => {
    try {
      const refused = refusedRequest(req, allowed);
      if (refused) throw new HttpError(403, refused);
      await route(req, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  };
}
