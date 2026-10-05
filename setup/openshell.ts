/**
 * Step: openshell — opt this copy into NVIDIA OpenShell sandboxing.
 *
 *   pnpm exec tsx setup/index.ts --step openshell                 # asks (TTY), default: no
 *   pnpm exec tsx setup/index.ts --step openshell -- --enable --bin /usr/local/bin/openshell [--gateway <name>]
 *   pnpm exec tsx setup/index.ts --step openshell -- --disable    # back to Docker
 *
 * Declining changes nothing: no `.env` write, Docker stays the runtime (its
 * default when NANOCLAW_RUNTIME_DRIVER is unset). Enabling writes, in one
 * atomic `.env` update:
 *   - NANOCLAW_RUNTIME_DRIVER=openshell          (read by src/drivers/index.ts)
 *   - OPENSHELL_BIN (absolute when resolvable), optional OPENSHELL_GATEWAY
 *   - the sandbox policy defaults the NanoClaw agent image needs, ONLY where
 *     the operator has not set them already;
 * then installs the `openshell` gateway through the same skill-driven path as
 * every other gateway (`installGateway`, which stamps NANOCLAW_GATEWAY_PROVIDER
 * only after the skill fully applies). `--no-gateway` leaves that to the
 * caller — the setup wizard's own gateway step does it.
 *
 * Settings are `.env` keys because that is where the host reads every other
 * runtime setting from (`readSetting` in src/drivers/index.ts); this step
 * writes them through `upsertEnvVars`, the canonical writer.
 */
import * as p from '@clack/prompts';

import { readEnvFile } from '../src/env.js';
import { log } from '../src/log.js';
import { getInstallSlug } from '../src/install-slug.js';
import { installGateway } from './gateways/install.js';
import { buildOpenShellImage, type DockerRunner, realDocker } from './lib/openshell-image.js';
import { RELAY_PORT_KEY, relayPortEnv, selectRelayPort, type RelayPortChoice } from './lib/openshell-relay-port.js';
import { resolveBinary } from './lib/resolve-binary.js';
import { removeEnvVar, upsertEnvVars } from './set-env.js';
import { emitStatus } from './status.js';

export const OPENSHELL_DRIVER = 'openshell';
export const OPENSHELL_GATEWAY_KIND = 'openshell';

/**
 * Sandbox policy defaults for the shipped agent image, as verified live in
 * the POC (nanoco-bot/poc-nvidia-openshell): the runner lives under /app with
 * pnpm/bun tooling under /pnpm and /opt; HOME is /home/node. The model relay
 * egress rule lets only the agent runtimes reach the host alias + relay port.
 * The relay PORT is not a default: it is chosen per install (selectRelayPort)
 * and written to both NANOCLAW_OPENSHELL_MODEL_RELAY_PORT and
 * NANOCLAW_OPENSHELL_GATEWAY_PORTS from one value, every time.
 */
export const OPENSHELL_POLICY_DEFAULTS: Readonly<Record<string, string>> = {
  NANOCLAW_OPENSHELL_BASE_RO: '/usr,/bin,/lib,/lib64,/etc,/app,/pnpm,/opt',
  NANOCLAW_OPENSHELL_BASE_RW: '/tmp,/home/node',
  NANOCLAW_OPENSHELL_GATEWAY_HOST: 'host.openshell.internal',
  NANOCLAW_OPENSHELL_GATEWAY_BINARIES: '/usr/local/bin/bun,/usr/local/bin/node',
};

const READ_KEYS = [
  'NANOCLAW_RUNTIME_DRIVER',
  'NANOCLAW_GATEWAY_PROVIDER',
  'OPENSHELL_BIN',
  'OPENSHELL_GATEWAY',
  RELAY_PORT_KEY,
  'NANOCLAW_OPENSHELL_GATEWAY_PORTS',
  ...Object.keys(OPENSHELL_POLICY_DEFAULTS),
];

export interface OpenShellAnswers {
  enable: boolean;
  /** As entered; resolved to an absolute path by `planOpenShellEnv` when possible. */
  bin?: string;
  /** OpenShell gateway name for the CLI (OPENSHELL_GATEWAY); blank = CLI default. */
  gateway?: string;
}

export interface OpenShellPlan {
  writes: Record<string, string>;
  warnings: string[];
}

/** Pure: what enabling writes to `.env`, given what is already there. */
export function planOpenShellEnv(
  answers: OpenShellAnswers,
  existing: Record<string, string | undefined>,
  relayPort: number,
  which: (bin: string) => string | undefined = (bin) => resolveBinary(bin),
): OpenShellPlan {
  const warnings: string[] = [];
  const requested = answers.bin?.trim() || existing.OPENSHELL_BIN?.trim() || 'openshell';
  const resolved = which(requested);
  if (!resolved) {
    warnings.push(
      `openshell CLI not found at '${requested}'; NanoClaw will fail to start sessions until it is installed there.`,
    );
  }
  const writes: Record<string, string> = {
    NANOCLAW_RUNTIME_DRIVER: OPENSHELL_DRIVER,
    OPENSHELL_BIN: resolved ?? requested,
  };
  const gateway = answers.gateway?.trim();
  if (gateway) writes.OPENSHELL_GATEWAY = gateway;
  for (const [key, value] of Object.entries(OPENSHELL_POLICY_DEFAULTS)) {
    if (!existing[key]?.trim()) writes[key] = value;
  }
  // Relay port and egress allow-list port: always both, always the same value.
  Object.assign(writes, relayPortEnv(relayPort));
  return { writes, warnings };
}

export function parseOpenShellArgs(args: string[]): Partial<OpenShellAnswers> & { installGateway: boolean } {
  const out: Partial<OpenShellAnswers> & { installGateway: boolean } = { installGateway: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--enable') out.enable = true;
    else if (arg === '--disable') out.enable = false;
    else if (arg === '--no-gateway') out.installGateway = false;
    else if (arg === '--bin' && args[i + 1] !== undefined) out.bin = args[++i];
    else if (arg === '--gateway' && args[i + 1] !== undefined) out.gateway = args[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return out;
}

/** The interactive question, shared by `--step openshell` and the setup wizard. */
export async function askOpenShell(existing: Record<string, string | undefined>): Promise<OpenShellAnswers> {
  const enabled = existing.NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() === OPENSHELL_DRIVER;
  const enable = await p.confirm({
    message: 'Enable OpenShell sandboxing? (runs agents in NVIDIA OpenShell sandboxes instead of plain Docker)',
    initialValue: enabled,
  });
  if (p.isCancel(enable) || !enable) return { enable: false };
  const bin = await p.text({
    message: 'Path to the openshell CLI',
    placeholder: 'openshell',
    initialValue: existing.OPENSHELL_BIN || resolveBinary('openshell') || '',
  });
  if (p.isCancel(bin)) return { enable: false };
  const gateway = await p.text({
    message: 'OpenShell gateway name (leave blank for the CLI default)',
    placeholder: 'default',
    initialValue: existing.OPENSHELL_GATEWAY ?? '',
  });
  return { enable: true, bin: String(bin), gateway: p.isCancel(gateway) ? undefined : String(gateway ?? '') };
}

export function readOpenShellEnv(projectRoot = process.cwd()): Record<string, string> {
  return readEnvFile(READ_KEYS, projectRoot);
}

export interface EnableResult extends OpenShellPlan {
  port: RelayPortChoice;
  /** The derived `:openshell` image, built now when a base image already exists. */
  image:
    | { status: 'built'; tag: string }
    | { status: 'pending'; detail: string }
    | { status: 'failed'; detail: string };
}

/**
 * Enable: pick this install's relay port, write the plan atomically, and
 * derive the OpenShell image if the base is already here (otherwise the
 * `container` step builds it, since the driver is now configured).
 */
export async function enableOpenShell(
  answers: OpenShellAnswers,
  projectRoot = process.cwd(),
  deps: { docker?: DockerRunner; selectPort?: typeof selectRelayPort } = {},
): Promise<EnableResult> {
  const existing = readOpenShellEnv(projectRoot);
  const port = await (deps.selectPort ?? selectRelayPort)(existing, getInstallSlug(projectRoot));
  const plan = planOpenShellEnv(answers, existing, port.port);
  if (port.replaced) {
    plan.warnings.push(
      `OpenShell relay port ${port.replaced.port} ${port.replaced.why === 'taken' ? 'is in use by another process' : 'was the shared legacy default'}; this install now uses ${port.port}. Restart NanoClaw for it to take effect.`,
    );
  }
  upsertEnvVars(plan.writes, projectRoot);
  log.info('OpenShell sandboxing enabled', { keys: Object.keys(plan.writes), relayPort: port.port });

  let image: EnableResult['image'];
  const docker = deps.docker ?? realDocker;
  const derived = buildOpenShellImage(projectRoot, docker);
  if (derived.ok) image = { status: 'built', tag: derived.image };
  else if (derived.reason === 'base-missing') image = { status: 'pending', detail: derived.detail };
  else image = { status: 'failed', detail: derived.detail };
  return { ...plan, port, image };
}

/** Disable: back to the Docker default. Leaves OPENSHELL_* settings for a later re-enable. */
export function disableOpenShell(): { gatewayCleared: boolean } {
  // removeEnvVar works on process.cwd(): setup steps always run from the project root.
  const existing = readOpenShellEnv();
  removeEnvVar('NANOCLAW_RUNTIME_DRIVER');
  const gatewayCleared = existing.NANOCLAW_GATEWAY_PROVIDER?.trim().toLowerCase() === OPENSHELL_GATEWAY_KIND;
  if (gatewayCleared) removeEnvVar('NANOCLAW_GATEWAY_PROVIDER');
  return { gatewayCleared };
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseOpenShellArgs(args);
  const existing = readOpenShellEnv();
  let answers: OpenShellAnswers;
  if (parsed.enable !== undefined) {
    answers = { enable: parsed.enable, bin: parsed.bin, gateway: parsed.gateway };
  } else if (process.stdin.isTTY) {
    answers = await askOpenShell(existing);
  } else {
    // Non-interactive and unasked: the default is "no" — change nothing.
    answers = { enable: false };
  }

  if (!answers.enable) {
    if (parsed.enable === false) {
      const { gatewayCleared } = disableOpenShell();
      emitStatus('OPENSHELL', {
        STATUS: 'success',
        ENABLED: false,
        RUNTIME_DRIVER: 'docker',
        ...(gatewayCleared ? { NEXT: 'select another gateway: setup/index.ts --step gateway' } : {}),
      });
      return;
    }
    emitStatus('OPENSHELL', {
      STATUS: 'skipped',
      ENABLED: false,
      RUNTIME_DRIVER: existing.NANOCLAW_RUNTIME_DRIVER || 'docker',
    });
    return;
  }

  const plan = await enableOpenShell(answers);
  for (const warning of plan.warnings) log.warn(warning);
  if (plan.image.status === 'failed') {
    emitStatus('OPENSHELL', {
      STATUS: 'failed',
      ENABLED: true,
      ERROR: 'openshell_image_failed',
      DETAIL: plan.image.detail.split('\n').slice(-1)[0] ?? '',
    });
    process.exit(1);
  }
  let gateway = 'deferred';
  if (parsed.installGateway) {
    const entry = await installGateway(OPENSHELL_GATEWAY_KIND);
    gateway = entry.kind;
  }
  emitStatus('OPENSHELL', {
    STATUS: 'success',
    ENABLED: true,
    RUNTIME_DRIVER: OPENSHELL_DRIVER,
    OPENSHELL_BIN: plan.writes.OPENSHELL_BIN,
    RELAY_PORT: plan.port.port,
    // 'pending' = no base image yet; the container step derives it.
    OPENSHELL_IMAGE: plan.image.status === 'built' ? plan.image.tag : plan.image.status,
    GATEWAY: gateway,
    CLI_FOUND: !plan.warnings.some((w) => w.startsWith('openshell CLI not found')),
    WARNINGS: plan.warnings.length,
  });
}
