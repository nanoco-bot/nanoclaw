/**
 * The setup wizard's OpenShell steps (setup/auto.ts calls these): the
 * "Enable OpenShell sandboxing?" choice, installing OpenShell, the agent
 * runtime (always Claude) and OpenShell's notes for the verify summary.
 */
import * as p from '@clack/prompts';

import { emit as phEmit } from '../lib/diagnostics.js';
import { fail, runQuietStep } from '../lib/runner.js';
import { brandBody } from '../lib/theme.js';
import { runWindowedStep } from '../lib/windowed-runner.js';
import * as setupLog from '../logs.js';
import { getPlatform } from '../platform.js';
import { hostSupport, unsupportedHostHint } from './install-step.js';
import { gatewayConfigRemedy } from './runtime.js';
import { OPENSHELL_DRIVER, OPENSHELL_GATEWAY_KIND, askOpenShell, readOpenShellEnv } from './step.js';

export { OPENSHELL_GATEWAY_KIND };

/** NANOCLAW_SKIP=openshell: no question, the copy stays as `.env` has it. */
export function openShellConfigured(): boolean {
  return readOpenShellEnv().NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() === OPENSHELL_DRIVER;
}

/**
 * "Enable OpenShell sandboxing?" — answered by, in order: NANOCLAW_OPENSHELL
 * (flag/env), an earlier answer already in `.env`, the operator (TTY only).
 * No answer means no, and no means nothing is written: Docker stays the
 * runtime exactly as before this step existed. A machine OpenShell is not
 * published for (an Intel Mac) is never asked; choosing OpenShell there
 * anyway (flag or `.env`) stops setup with the reason.
 */
export async function runOpenShellChoice(opts: { installSkipped: boolean }): Promise<boolean> {
  const existing = readOpenShellEnv();
  const alreadyEnabled = existing.NANOCLAW_RUNTIME_DRIVER?.trim().toLowerCase() === OPENSHELL_DRIVER;
  const flag = process.env.NANOCLAW_OPENSHELL?.trim().toLowerCase();
  const support = hostSupport();
  let enable: boolean;
  let bin = process.env.OPENSHELL_BIN?.trim() || existing.OPENSHELL_BIN;
  let gateway = process.env.OPENSHELL_GATEWAY?.trim() || existing.OPENSHELL_GATEWAY;
  if (flag === 'true' || flag === 'false') {
    enable = flag === 'true';
  } else if (alreadyEnabled) {
    enable = true;
  } else if (process.stdin.isTTY && support.ok) {
    const answers = await askOpenShell(existing);
    enable = answers.enable;
    bin = answers.bin ?? bin;
    gateway = answers.gateway ?? gateway;
  } else {
    // In place of a question whose only working answer is no.
    if (process.stdin.isTTY && !support.ok) {
      p.log.info(brandBody(`${support.reason} This install uses Docker sandboxing.`));
    }
    enable = false;
  }
  setupLog.userInput('openshell', String(enable));

  if (!enable) {
    if (alreadyEnabled && flag === 'false') {
      const res = await runQuietStep(
        'openshell',
        { running: 'Switching back to Docker sandboxing…', done: 'Docker sandboxing restored.' },
        ['--disable'],
      );
      if (!res.ok) await fail('openshell', "Couldn't switch back to Docker sandboxing.");
    }
    return false;
  }

  if (!support.ok) {
    await fail(
      'openshell',
      "OpenShell sandboxing isn't available on this machine.",
      unsupportedHostHint(support.reason),
    );
  }
  const chosenGateway = process.env.NANOCLAW_GATEWAY_PROVIDER?.trim().toLowerCase();
  if (chosenGateway && chosenGateway !== OPENSHELL_GATEWAY_KIND) {
    await fail(
      'openshell',
      `OpenShell sandboxing uses the OpenShell gateway, but '${chosenGateway}' was selected.`,
      'Re-run setup without a gateway selection, or without --openshell.',
    );
  }
  // OpenShell itself is installed by the openshell-install step, after Docker.
  const args = ['--enable', '--no-gateway', '--no-install'];
  if (bin) args.push('--bin', bin);
  if (gateway) args.push('--gateway', gateway);
  const res = await runQuietStep(
    'openshell',
    { running: 'Configuring OpenShell sandboxing…', done: 'OpenShell sandboxing enabled.' },
    args,
  );
  if (!res.ok) {
    await fail('openshell', "Couldn't enable OpenShell sandboxing.", 'See logs/setup-steps/ for details, then retry.');
  }
  // Not yet installed is expected here; only a skipped install leaves it missing.
  if (res.terminal?.fields.CLI_FOUND === 'false' && opts.installSkipped) {
    p.log.warn(
      brandBody(
        `The openshell CLI was not found at ${res.terminal?.fields.OPENSHELL_BIN}. Install it before starting NanoClaw.`,
      ),
    );
  }
  return true;
}

/**
 * Install OpenShell (`setup --step openshell-install`): its CLI and local
 * gateway through NVIDIA's installer at the versions.json pin (nothing when
 * already installed), then the gateway answers, its supervisor image is
 * pulled, and it accepts NanoClaw's mounts. Windowed: a first install
 * downloads the package and the gateway's images.
 */
export async function runOpenShellInstall(): Promise<void> {
  const res = await runWindowedStep('openshell-install', {
    running: 'Installing OpenShell…',
    done: 'OpenShell is installed and its gateway is running.',
    failed: "Couldn't finish installing OpenShell.",
  });
  if (res.ok) {
    if (Number(res.terminal?.fields.WARNINGS ?? 0) > 0) {
      p.log.warn(brandBody('OpenShell installed with a warning; see logs/setup-steps/openshell-install.log.'));
    }
    return;
  }
  const fields = res.terminal?.fields ?? {};
  // The gateway-settings hint is multi-line (TOML); the status block holds one line.
  const hint =
    fields.ERROR === 'gateway_config'
      ? gatewayConfigRemedy(getPlatform())
      : fields.HINT || 'See logs/setup-steps/ for the installer output, then retry.';
  await fail('openshell-install', fields.MESSAGE || "Couldn't install OpenShell.", hint, res.rawLog);
}

/**
 * The agent runtime on an OpenShell install: always Claude, never prompted.
 * The OpenShell gateway holds Claude credentials only (its auth.ts and
 * credential-store.ts refuse any other provider), so Codex/OpenCode/… cannot
 * work there and are not offered. A preset naming another provider is a
 * contradiction and stops setup rather than being silently overridden.
 */
export async function openShellAgentProvider(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_PROVIDER?.trim().toLowerCase();
  if (preset && preset !== 'claude') {
    await fail(
      'auth',
      `NANOCLAW_AGENT_PROVIDER=${preset} can't be used with OpenShell sandboxing.`,
      'The OpenShell gateway holds Claude credentials only. Unset NANOCLAW_AGENT_PROVIDER (or set it to claude), or re-run setup without OpenShell.',
    );
  }
  setupLog.userInput('agent_provider', 'claude');
  phEmit('agent_provider_chosen', { provider: 'claude', ...(preset ? { preset: true } : {}), openshell: true });
  p.log.info(brandBody('OpenShell sandboxing runs Claude — connecting your Claude account next.'));
  return 'claude';
}

/** The web console is a separate, opt-in skill; setup only says how to add it. */
export function openShellConsoleHint(): void {
  p.log.info(brandBody('Optional: run /add-openshell-console in Claude Code for a web console (localhost only).'));
}

/** OpenShell's lines for the verify summary, from verify's status fields. */
export function openShellVerifyNotes(fields: Record<string, string | undefined>): string[] {
  const notes: string[] = [];
  if (fields.CREDENTIALS !== 'configured') {
    notes.push(
      "• OpenShell has no Claude credential for this install, so agents can't reply. Run `pnpm exec tsx setup/index.ts --step gateway-auth`.",
    );
  }
  if (fields.OPENSHELL_GATEWAY && fields.OPENSHELL_GATEWAY !== 'connected') {
    notes.push(
      "• OpenShell's gateway isn't answering, so no sandbox can start. Run `pnpm exec tsx setup/index.ts --step openshell-install` to see why.",
    );
  } else if (fields.OPENSHELL_SUPERVISOR_IMAGE === 'missing') {
    notes.push(
      `• OpenShell's supervisor image is missing, so no sandbox can start. Run \`docker pull ${fields.OPENSHELL_SUPERVISOR_IMAGE_REF}\`.`,
    );
  }
  return notes;
}
