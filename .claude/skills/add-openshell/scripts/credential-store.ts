/**
 * The OpenShell gateway's credential store: the agent's Claude credential is
 * an OpenShell provider (`nanoclaw-<install>-claude`), never a NanoClaw file.
 *
 * Values reach `openshell` only through the child's environment, with the
 * `--credential KEY` lookup form, so they never appear in argv. Only the
 * Claude credential is supported; other agent providers are refused.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProviderCredentialStore } from '../../../../setup/gateways/credential-store.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import type { OpenShellCli } from '../../../../src/drivers/openshell/cli.js';
import { configuredOpenShellCli } from '../../../../src/drivers/openshell/config.js';
import {
  MODEL_CREDENTIAL_ENV,
  MODEL_PROFILE_ID,
  modelProfileYaml,
  modelProviderName,
  type ModelCredentialKind,
} from '../../../../src/drivers/openshell/model-provider.js';

export interface ModelCredential {
  kind: ModelCredentialKind;
  value: string;
}

/** The kind a stored provider holds, by its type; null when OpenShell has no such provider. */
export async function storedModelCredentialKind(
  root = process.cwd(),
  cli: OpenShellCli = configuredOpenShellCli(),
): Promise<ModelCredentialKind | null> {
  const name = modelProviderName(getInstallSlug(root));
  const { providers = [] } = JSON.parse(await cli.run(['provider', 'list', '-o', 'json'])) as {
    providers?: { name?: string; type?: string }[];
  };
  const type = providers.find((p) => p.name === name)?.type;
  if (!type) return null;
  return (Object.keys(MODEL_PROFILE_ID) as ModelCredentialKind[]).find((k) => MODEL_PROFILE_ID[k] === type) ?? null;
}

async function ensureProfile(kind: ModelCredentialKind, cli: OpenShellCli): Promise<void> {
  const ids = (JSON.parse(await cli.run(['provider', 'profile', 'list', '-o', 'json'])) as { id?: string }[]).map(
    (p) => p.id,
  );
  if (ids.includes(MODEL_PROFILE_ID[kind])) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-openshell-profile-'));
  try {
    const file = path.join(dir, `${MODEL_PROFILE_ID[kind]}.yaml`);
    fs.writeFileSync(file, modelProfileYaml(kind), { mode: 0o600 });
    await cli.run(['provider', 'profile', 'import', '-f', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Store (or rotate) the Claude credential in OpenShell. Same kind: updated in
 * place, and attached sandboxes pick it up (`--wait`). Different kind: the
 * provider is recreated with the other profile, which reaches sandboxes
 * created from then on.
 */
export async function storeModelCredential(
  cred: ModelCredential,
  root = process.cwd(),
  cli: OpenShellCli = configuredOpenShellCli(),
): Promise<'created' | 'updated' | 'replaced'> {
  const name = modelProviderName(getInstallSlug(root));
  const key = MODEL_CREDENTIAL_ENV[cred.kind];
  const env = { [key]: cred.value };
  await ensureProfile(cred.kind, cli);
  const current = await storedModelCredentialKind(root, cli);
  if (current === cred.kind) {
    await cli.run(['provider', 'update', name, '--credential', key, '--wait'], { env });
    return 'updated';
  }
  if (current) await cli.run(['provider', 'delete', name]);
  await cli.run(['provider', 'create', '--name', name, '--type', MODEL_PROFILE_ID[cred.kind], '--credential', key], {
    env,
  });
  return current ? 'replaced' : 'created';
}

export function createCredentialStore(root = process.cwd()): ProviderCredentialStore {
  return {
    async has(provider) {
      return provider === 'claude' && (await storedModelCredentialKind(root)) !== null;
    },
    async save(provider, credential) {
      if (provider !== 'claude' || credential.kind !== 'api-key') {
        throw new Error(
          `The OpenShell gateway holds only the Claude credential; it cannot store one for provider '${provider}'.`,
        );
      }
      await storeModelCredential({ kind: 'api-key', value: credential.value }, root);
    },
  };
}
