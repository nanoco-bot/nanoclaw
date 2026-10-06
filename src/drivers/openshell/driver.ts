/**
 * OpenShellSessionDriver — NanoClaw's SessionDriver realized as NVIDIA OpenShell
 * sandboxes (Docker compute driver), via the `openshell` CLI.
 *
 * Structure mirrors the shipped DockerSessionDriver (vendor/nanoclaw/src/drivers/docker-driver.ts):
 * capabilities / ensureReady / prepare (validate, build realization,
 * idempotency, rollback) / listSessions / watchSessions / reapResidue.
 *
 * Where the realization necessarily differs:
 *
 * - prepare() vs start(). OpenShell has no "create but don't start": `sandbox
 *   create` provisions AND launches the main process. The seam says prepare
 *   allocates and starts nothing — and the host runs its gateway-admission
 *   gate between the two — so prepare() validates, compiles the policy and
 *   driver-config, and resolves idempotency; start() performs the create. A
 *   gateway that rejects the mount therefore fails start(), which the host
 *   already handles by calling stop() (full teardown).
 * - watchSessions() is HONEST POLLING, not an event stream. The CLI has no
 *   watch verb (the gateway's WatchSandboxes RPC is reachable only through the
 *   SDK's raw client). Polling re-lists on an interval and diffs phases; it
 *   satisfies the contract (best-effort hints, one subscription per install,
 *   bounded backoff, never gives up) at the cost of latency up to one interval.
 *   `capabilities().watchMode` says so in the boot log.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { realOpenShellCli, type OpenShellCli } from './cli.js';
import {
  assertDriverConfigMatchesPolicy,
  compileDriverConfig,
  compilePolicy,
  renderPolicyYaml,
  type CompiledPolicy,
  type DriverConfig,
  type PolicyOptions,
} from './policy.js';
import { policyOptionsFor } from './group-policy.js';
import { assertHostMounts, type Lstat } from './host-mount.js';
import {
  createArgs,
  handleStatus,
  cliErrorSummary,
  isAlreadyExists,
  isNotFound,
  isTerminalPhase,
  listingPhase,
  normalizeOpenShellError,
  parseSandboxDoc,
  parseSandboxList,
  recordedFailure,
  sandboxLabels,
  sandboxName,
  type OpenShellSandboxDoc,
} from './realize.js';
import {
  LABELS,
  asFailureError,
  isGatewayOwned,
  log as seamLog,
  specInvalid,
  validateSpec,
  type DriverCapabilities,
  type MountPolicy,
  type SessionDriver,
  type SessionEvent,
  type SessionExecSpec,
  type SessionHandle,
  type SessionKey,
  type SessionPhase,
  type SessionSnapshot,
  type SessionSpec,
  type SessionStatus,
  type SessionWatch,
} from './seam.js';

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
}

export interface OpenShellDriverOptions extends MountPolicy {
  cli?: OpenShellCli;
  /** Default policy options for every session. */
  policy?: PolicyOptions;
  /**
   * Per-agent-group overrides keyed by group FOLDER (the spec's
   * `nanoclaw-group-folder` label), merged over `policy` — see group-policy.ts.
   */
  groupPolicy?: Record<string, PolicyOptions>;
  /** Watch poll interval. Default 2000ms. */
  pollIntervalMs?: number;
  /** Where the transient policy file is written for `--policy`. Default os.tmpdir(). */
  tmpDir?: string;
  /** fs.lstatSync, injectable for tests of the mount-source symlink check (host-mount.ts). */
  lstat?: Lstat;
  logger?: Logger;
}

/**
 * The vendored DriverCapabilities plus one honesty field core does not read
 * but does log at boot (`Session runtime driver selected`): how watchSessions
 * learns about changes. Features gate on capabilities, never on driver kind —
 * so the limitation is declared here rather than left for someone to infer
 * from `kind === 'openshell'`.
 */
export interface OpenShellCapabilities extends DriverCapabilities {
  watchMode: 'polling';
}

const DEFAULT_POLL_MS = 2_000;
const WATCH_RECOVERY_BASE_MS = 1_000;
const WATCH_RECOVERY_MAX_MS = 30_000;
const LIST_PAGE_SIZE = 100;

interface InstallWatch {
  subscribers: Set<(event: SessionEvent) => void>;
  attempt: number;
  /** Last observed listing phase per key id; null until the first successful poll. */
  last: Map<string, { key: SessionKey; phase: SessionPhase }> | null;
  timer: NodeJS.Timeout | null;
  stopped: boolean;
}

function keyId(key: SessionKey): string {
  return `${key.installSlug}\u0000${key.agentGroupId}\u0000${key.sessionId}`;
}

/** What prepare() hands start(): the realization, fully compiled, nothing allocated yet. */
interface PendingRealization {
  spec: SessionSpec;
  policy: CompiledPolicy;
  driverConfig: DriverConfig | null;
}

export class OpenShellSessionDriver implements SessionDriver {
  readonly kind = 'openshell' as const;
  readonly #cli: OpenShellCli;
  readonly #policy: MountPolicy;
  readonly #opts: OpenShellDriverOptions;
  readonly #log: Logger;
  readonly #watches = new Map<string, InstallWatch>();
  /** Every key handed out (prepare or list), per install — hinted when a poll no longer lists it. */
  readonly #knownKeys = new Map<string, Map<string, SessionKey>>();

  constructor(opts: OpenShellDriverOptions) {
    this.#opts = opts;
    this.#policy = {
      groupsRoot: opts.groupsRoot,
      dataRoot: opts.dataRoot,
      surfaceRoots: opts.surfaceRoots,
      materialsRoot: opts.materialsRoot,
      gatewayTrustRoot: opts.gatewayTrustRoot,
    };
    this.#cli = opts.cli ?? realOpenShellCli();
    this.#log = opts.logger ?? seamLog;
  }

  capabilities(): OpenShellCapabilities {
    return {
      // Docker compute driver: sibling containers, not VMs. (OpenShell has a VM
      // driver; this realization does not target it.)
      isolationTiers: ['container'],
      // Mount pinning is enforced host-side in code (validateSpec), exactly as
      // on Docker. The gateway's own resource_admission is disabled in the POC
      // deployment, so nothing out-of-process re-checks mounts. Do not flip
      // this until label-based admission is configured AND verified.
      admissionEnforced: false,
      // OpenShell enforces egress by policy (network_policies, default deny),
      // not by network topology.
      networkPolicy: 'declarative',
      encryptedVolumes: false,
      // pids: the Docker compute driver applies one gateway-wide
      // sandbox_pids_limit; there is no per-sandbox knob. shm: no CLI flag and
      // driver_config accepts only mounts/cdi_devices. Named, not faked.
      unrealized: ['pidsLimit', 'shmSizeMb'],
      sharedNetworkNamespace: false,
      // One sandbox per session; specs with auxiliary containers are refused.
      auxiliaryContainers: false,
      // Images are resolved by the OpenShell gateway's runtime; this driver
      // cannot vouch that `buildAgentGroupImage`'s local daemon is that runtime.
      imageBuild: false,
      watchMode: 'polling',
    };
  }

  /** Fatal-at-startup reachability: one cheap authenticated list against the configured gateway. */
  async ensureReady(): Promise<void> {
    try {
      await this.#cli.run(['sandbox', 'list', '--page-size', '1', '-o', 'json'], { timeoutMs: 15_000 });
    } catch (err) {
      throw new Error(
        'OpenShell gateway is required but unreachable: check that the `openshell` CLI is installed and ' +
          'OPENSHELL_GATEWAY / OPENSHELL_GATEWAY_ENDPOINT select a running gateway (`openshell sandbox list`).',
        { cause: err },
      );
    }
  }

  async prepare(spec: SessionSpec): Promise<SessionHandle> {
    // The shared host-side layer, same call the Docker driver makes: mount
    // classes, canonical paths, tier, secret-shaped env. Not re-implemented.
    validateSpec(spec, this.#policy, this.capabilities());
    // The filesystem half validateSpec deliberately leaves out (it is pure):
    // no symlink component in any mount source, no group-state/extra mount over
    // the image's system tree. Before anything is compiled from the paths.
    assertHostMounts(spec, this.#opts.lstat);

    const extra = spec.containers.filter((c) => c.role !== 'agent');
    if (extra.length > 0) {
      // Never validate-then-ignore a composed container (DriverCapabilities.auxiliaryContainers).
      throw specInvalid(
        `openshell driver does not realize auxiliary containers (${extra.map((c) => c.role).join(', ')})`,
      );
    }
    if (spec.networkAccess.target.kind === 'session-container') {
      throw specInvalid('session-container network target requires auxiliary containers');
    }
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const name = sandboxName(spec.key);

    // Compile everything up front: a spec this driver cannot realize fails
    // prepare(), before the host arms anything.
    const pending: PendingRealization = {
      spec,
      policy: compilePolicy(spec, agent, policyOptionsFor(spec, this.#opts.policy ?? {}, this.#opts.groupPolicy)),
      driverConfig: compileDriverConfig(agent),
    };
    // The bind list and the Landlock policy must agree on every mount's access.
    assertDriverConfigMatchesPolicy(pending.policy, pending.driverConfig);
    sandboxLabels(spec, agent); // labels are realized verbatim or refused — refuse now, not at create

    this.#remember(spec.key);

    // Idempotency on key.
    const existing = await this.#getOwned(name, spec.key);
    if (existing && !isTerminalPhase(existing.phase)) {
      return new OpenShellHandle(spec.key, name, this.#cli, this.#log, null, this.#opts.tmpDir);
    }
    if (existing) {
      // Our own corpse (sandboxes persist after the main process ends, unlike
      // `--rm` containers). Re-handing it out would loop: start() no-ops, the
      // hub reads a terminal, the host respawns into the same corpse.
      await this.#deleteQuietly(name);
    }
    return new OpenShellHandle(spec.key, name, this.#cli, this.#log, pending, this.#opts.tmpDir);
  }

  async listSessions(installSlug: string): Promise<SessionSnapshot[]> {
    const docs = await this.#list(`${LABELS.install}=${installSlug},${LABELS.role}=agent`);
    const out: SessionSnapshot[] = [];
    for (const doc of docs) {
      const labels = doc.labels ?? {};
      const agentGroupId = labels[LABELS.group];
      const sessionId = labels[LABELS.session];
      if (!agentGroupId || !sessionId) continue; // not reconstructible from labels — not ours to adopt
      const key: SessionKey = { installSlug, agentGroupId, sessionId };
      this.#remember(key);
      const failure = recordedFailure(doc);
      out.push({
        handle: new OpenShellHandle(key, doc.name, this.#cli, this.#log, null, this.#opts.tmpDir),
        phase: listingPhase(doc.phase),
        ...(failure ? { failure } : {}),
      });
    }
    return out;
  }

  watchSessions(installSlug: string, onEvent: (event: SessionEvent) => void): SessionWatch {
    let watch = this.#watches.get(installSlug);
    if (!watch) {
      watch = { subscribers: new Set(), attempt: 0, last: null, timer: null, stopped: false };
      this.#watches.set(installSlug, watch);
      this.#log.info('OpenShell session watch started (polling, not streaming)', {
        installSlug,
        intervalMs: this.#opts.pollIntervalMs ?? DEFAULT_POLL_MS,
      });
      this.#schedule(installSlug, watch, 0);
    }
    watch.subscribers.add(onEvent);
    const w = watch;
    return {
      stop: () => {
        w.subscribers.delete(onEvent);
        if (w.subscribers.size === 0 && this.#watches.get(installSlug) === w) {
          w.stopped = true;
          if (w.timer) clearTimeout(w.timer);
          this.#watches.delete(installSlug);
        }
      },
    };
  }

  /**
   * Sandboxes whose session ended but that were never deleted (a host that died
   * between end and teardown). Live and gateway-owned sandboxes are left alone.
   */
  async reapResidue(installSlug: string): Promise<void> {
    let docs: OpenShellSandboxDoc[];
    try {
      docs = await this.#list(`${LABELS.install}=${installSlug}`);
    } catch (err) {
      this.#log.warn('Failed to list OpenShell sandboxes for residue reaping', { err });
      return;
    }
    const stale = docs
      .filter((d) => isTerminalPhase(d.phase))
      .filter((d) => !isGatewayOwned(d.labels?.[LABELS.session], d.labels?.[LABELS.role]))
      .map((d) => d.name);
    for (const name of stale) await this.#deleteQuietly(name);
    if (stale.length > 0) this.#log.info('Removed ended OpenShell sandboxes', { count: stale.length, names: stale });
  }

  // ---------- internals ----------

  /** Paginated `sandbox list --selector`. */
  async #list(selector: string): Promise<OpenShellSandboxDoc[]> {
    const all: OpenShellSandboxDoc[] = [];
    let token = '';
    // Bounded: a gateway that keeps returning a token cannot spin this forever.
    for (let page = 0; page < 1000; page++) {
      let out: string;
      try {
        out = await this.#cli.run([
          'sandbox',
          'list',
          '--selector',
          selector,
          '--page-size',
          String(LIST_PAGE_SIZE),
          ...(token ? ['--page-token', token] : []),
          '-o',
          'json',
        ]);
      } catch (err) {
        throw normalizeOpenShellError(err);
      }
      const { sandboxes, nextPageToken } = parseSandboxList(out);
      all.push(...sandboxes);
      if (!nextPageToken) break;
      token = nextPageToken;
    }
    return all;
  }

  /**
   * The sandbox at `name`, if it is THIS session's. Name existence alone is not
   * ownership (a hand-made sandbox, or another install, can wear the name), so
   * canonical labels are verified and a mismatch refuses loudly.
   */
  async #getOwned(name: string, key: SessionKey): Promise<OpenShellSandboxDoc | null> {
    let doc: OpenShellSandboxDoc;
    try {
      doc = parseSandboxDoc(await this.#cli.run(['sandbox', 'get', name, '-o', 'json']));
    } catch (err) {
      if (isNotFound(err)) return null;
      throw normalizeOpenShellError(err);
    }
    const l = doc.labels ?? {};
    if (
      l[LABELS.install] === key.installSlug &&
      l[LABELS.group] === key.agentGroupId &&
      l[LABELS.session] === key.sessionId
    ) {
      return doc;
    }
    this.#log.warn('Sandbox name collision: existing sandbox is not this session', { name, wanted: key });
    throw asFailureError({ kind: 'unknown', retryable: false, opaqueRef: `name-collision-${name}` });
  }

  async #deleteQuietly(name: string): Promise<void> {
    try {
      await this.#cli.run(['sandbox', 'delete', name]);
    } catch (err) {
      if (!isNotFound(err)) this.#log.warn('Failed to delete OpenShell sandbox', { name, err });
    }
  }

  #remember(key: SessionKey): void {
    let known = this.#knownKeys.get(key.installSlug);
    if (!known) {
      known = new Map();
      this.#knownKeys.set(key.installSlug, known);
    }
    known.set(keyId(key), key);
  }

  #schedule(installSlug: string, watch: InstallWatch, delayMs: number): void {
    if (watch.stopped) return;
    watch.timer = setTimeout(() => void this.#poll(installSlug, watch), delayMs);
    watch.timer.unref?.();
  }

  /**
   * One poll: re-list, diff against the previous observation, emit hints.
   * Hints only — the session-events hub re-reads status() before acting, so a
   * spurious or duplicate hint is harmless; a missed one is what we avoid.
   */
  async #poll(installSlug: string, watch: InstallWatch): Promise<void> {
    let snapshots: SessionSnapshot[];
    try {
      snapshots = await this.listSessions(installSlug);
    } catch (err) {
      // Bounded backoff, never give up: an unrecovered watch ends supervision
      // for every session of the install at once. The gap is closed on recovery
      // because `last` is reset and the next success re-hints everything.
      const delay = Math.min(WATCH_RECOVERY_BASE_MS * 2 ** watch.attempt, WATCH_RECOVERY_MAX_MS);
      watch.attempt += 1;
      watch.last = null;
      this.#log.warn('OpenShell session poll failed; retrying', { installSlug, delayMs: delay, err });
      this.#schedule(installSlug, watch, delay);
      return;
    }
    watch.attempt = 0;
    const events = diffSnapshots(watch.last, snapshots, this.#knownKeys.get(installSlug));
    watch.last = new Map(snapshots.map((s) => [keyId(s.handle.key), { key: s.handle.key, phase: s.phase }]));
    for (const event of events) for (const subscriber of watch.subscribers) subscriber(event);
    this.#schedule(installSlug, watch, this.#opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  }
}

/**
 * Previous observation + fresh listing -> hints. `previous === null` is a
 * baseline (first poll, or first after a failed one): there is no prior state
 * to diff, so every listed corpse and every known key the list no longer shows
 * is hinted terminal — the same gap-closing rule the Docker driver applies on
 * reconnect.
 */
export function diffSnapshots(
  previous: Map<string, { key: SessionKey; phase: SessionPhase }> | null,
  snapshots: SessionSnapshot[],
  knownKeys: Map<string, SessionKey> | undefined,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const listed = new Set<string>();
  for (const s of snapshots) {
    const id = keyId(s.handle.key);
    listed.add(id);
    const before = previous?.get(id);
    if (previous === null) {
      if (s.phase === 'terminal') events.push({ key: s.handle.key, kind: 'terminal' });
      continue;
    }
    if (!before) {
      events.push({ key: s.handle.key, kind: s.phase === 'terminal' ? 'terminal' : 'phase' });
    } else if (before.phase !== s.phase) {
      events.push({ key: s.handle.key, kind: s.phase === 'terminal' ? 'terminal' : 'phase' });
    }
  }
  if (previous === null) {
    for (const [id, key] of knownKeys ?? []) if (!listed.has(id)) events.push({ key, kind: 'terminal' });
  } else {
    for (const [id, before] of previous) if (!listed.has(id)) events.push({ key: before.key, kind: 'terminal' });
  }
  return events;
}

class OpenShellHandle implements SessionHandle {
  #started = false;
  #stopping = false;

  constructor(
    readonly key: SessionKey,
    readonly name: string,
    private readonly cli: OpenShellCli,
    private readonly log: Logger,
    /** Present only between prepare and start; null for an adopted handle. */
    private readonly pending: PendingRealization | null,
    private readonly tmpDir: string | undefined,
  ) {}

  /** Realize: write the compiled policy, `sandbox create --detach`, roll back on failure. */
  async start(): Promise<void> {
    if (this.#started || !this.pending) return; // idempotent; an adopted session is already running
    this.#started = true;
    const { spec, policy, driverConfig } = this.pending;
    const agent = spec.containers.find((c) => c.role === 'agent')!;
    const dir = await fs.mkdtemp(path.join(this.tmpDir ?? os.tmpdir(), 'nanoclaw-openshell-'));
    const policyPath = path.join(dir, 'policy.yaml');
    try {
      await fs.writeFile(policyPath, renderPolicyYaml(policy), { mode: 0o600 });
      await this.cli.run(createArgs({ spec, container: agent, name: this.name, policyPath, driverConfig }));
    } catch (err) {
      this.log.warn('OpenShell sandbox create failed', {
        name: this.name,
        err: cliErrorSummary(err instanceof Error ? err.message : String(err)),
      });
      // Atomic: allocate all or leave nothing. A create that failed after the
      // gateway recorded the sandbox (e.g. provisioning error) leaves it behind.
      // Except "already exists": that sandbox is NOT ours to roll back — it is
      // a concurrent prepare/start of the same key, and deleting it would kill
      // a live session.
      if (!isAlreadyExists(err)) {
        try {
          await this.cli.run(['sandbox', 'delete', this.name]);
        } catch {
          /* never created, or already gone */
        }
      }
      throw normalizeOpenShellError(err);
    } finally {
      // The CLI read the file at create time; the gateway holds the policy now.
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async status(): Promise<SessionStatus> {
    let doc: OpenShellSandboxDoc;
    try {
      doc = parseSandboxDoc(await this.cli.run(['sandbox', 'get', this.name, '-o', 'json']));
    } catch (err) {
      if (!isNotFound(err)) throw normalizeOpenShellError(err);
      // Prepared but not yet created is not an end.
      return this.pending && !this.#started ? { phase: 'ready' } : { phase: 'stopped' };
    }
    const status = handleStatus(doc);
    // A host-requested stop is not a failure, whatever code the runtime used.
    if (this.#stopping && status.phase === 'failed') return { phase: 'stopped' };
    return status;
  }

  /**
   * Full teardown: `sandbox delete`. OpenShell has no per-call stop grace, so
   * `stopGraceSeconds` is not realized on this path (the gateway's own
   * termination behavior applies).
   */
  async stop(reason: string): Promise<void> {
    this.#stopping = true;
    this.log.info('Stopping OpenShell sandbox', { name: this.name, reason });
    try {
      await this.cli.run(['sandbox', 'delete', this.name]);
    } catch (err) {
      if (isNotFound(err)) return;
      throw normalizeOpenShellError(err);
    }
  }

  /** `openshell sandbox exec` against this session's sandbox — described, never executed. */
  execSpec(command: string[]): SessionExecSpec {
    return {
      bin: this.cli.bin,
      argsTty: ['sandbox', 'exec', '--name', this.name, '--tty', '--', ...command],
      argsPlain: ['sandbox', 'exec', '--name', this.name, '--no-tty', '--', ...command],
    };
  }
}
