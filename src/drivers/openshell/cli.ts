/**
 * The one process-spawning seam the OpenShell driver sits on.
 *
 * Why the CLI and not `@nvidia/openshell-sdk`: the TypeScript SDK exists
 * (README SDK table, `sdk/typescript`), but at v0.1.2 it is distributed only via
 * GitHub Packages, which requires a `read:packages` token + `.npmrc` on every
 * machine that installs this overlay — a credential in the install path of a
 * host whose whole design keeps credentials out of it. The CLI is also the
 * surface that was verified end to end against the lab gateway (bind mounts via
 * `--driver-config-json`). Keeping every gateway call behind this interface
 * means swapping in the SDK later is a one-file change.
 *
 * Async on purpose (unlike NanoClaw's sync docker `Cli`): the polling watch
 * calls the gateway every few seconds, and `execFileSync` would block the host
 * event loop for the length of each round trip.
 */
import { execFile } from 'node:child_process';

export interface OpenShellCli {
  readonly bin: string;
  /**
   * Run to completion; resolves stdout. Rejects with an `OpenShellCliError` on non-zero exit.
   * `env` adds variables to this one child only — how credential VALUES reach
   * `openshell provider create --credential KEY` without ever touching argv.
   */
  run(args: string[], opts?: { timeoutMs?: number; env?: Record<string, string> }): Promise<string>;
}

export class OpenShellCliError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number | string | null,
  ) {
    super(message);
    this.name = 'OpenShellCliError';
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;

export function realOpenShellCli(bin = 'openshell', extraEnv: Record<string, string> = {}): OpenShellCli {
  return {
    bin,
    run(args, opts) {
      return new Promise((resolve, reject) => {
        execFile(
          bin,
          args,
          {
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBuffer: 16 * 1024 * 1024,
            // Machine-read output: never colorize. Gateway selection
            // (OPENSHELL_GATEWAY / OPENSHELL_GATEWAY_ENDPOINT) is inherited,
            // or supplied from `.env` via `extraEnv` (see config.ts).
            env: { ...process.env, ...extraEnv, ...(opts?.env ?? {}), OPENSHELL_COLOR: 'never', NO_COLOR: '1' },
          },
          (error, stdout, stderr) => {
            if (!error) {
              resolve(stdout.toString());
              return;
            }
            const err = error as NodeJS.ErrnoException & { code?: number | string };
            const text = stderr.toString().trim();
            reject(new OpenShellCliError(text || err.message, text || err.message, err.code ?? null));
          },
        );
      });
    },
  };
}
