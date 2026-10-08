import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createCredentialStore, storeModelCredential, storedModelCredentialKind } from './credential-store.js';
import type { OpenShellCli } from '../../../../src/drivers/openshell/cli.js';
import { MODEL_PROFILE_ID, modelProviderName } from '../../../../src/drivers/openshell/model-provider.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { detectInstalledOpenShell } from './detect.js';
import { resolveBinary } from '../../../../setup/openshell/resolve-binary.js';
import { preflight } from './preflight.js';

const READY = { NANOCLAW_RUNTIME_DRIVER: 'openshell', OPENSHELL_BIN: '/opt/openshell/bin/openshell' };
const found = () => '/opt/openshell/bin/openshell';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('openshell gateway preflight', () => {
  it('passes a copy configured by the openshell setup step', () => {
    expect(preflight(READY, found)).toEqual({ errors: [], warnings: [] });
  });

  it('refuses a docker-driver copy: only the OpenShell driver attaches the credential', () => {
    const { errors } = preflight({ ...READY, NANOCLAW_RUNTIME_DRIVER: '' }, found);
    expect(errors.join('\n')).toMatch(/requires NANOCLAW_RUNTIME_DRIVER=openshell.*'docker'/);
  });

  it('only warns about a missing or PATH-relative CLI', () => {
    expect(preflight(READY, () => undefined)).toMatchObject({
      errors: [],
      warnings: [expect.stringMatching(/not found/)],
    });
    expect(preflight({ ...READY, OPENSHELL_BIN: 'openshell' }, found).warnings.join()).toMatch(/fixed PATH/);
  });

  it('resolves binaries by path or PATH search', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-bin-'));
    roots.push(dir);
    const bin = path.join(dir, 'openshell');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    expect(resolveBinary(bin)).toBe(bin);
    expect(resolveBinary('openshell', dir)).toBe(bin);
    expect(resolveBinary('openshell', '/nonexistent')).toBeUndefined();
  });
});

describe('openshell gateway detection and credential store', () => {
  it('detects an openshell-driver copy from .env only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openshell-detect-'));
    roots.push(root);
    expect(detectInstalledOpenShell(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER=docker\n');
    expect(detectInstalledOpenShell(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_RUNTIME_DRIVER="openshell"\n');
    expect(detectInstalledOpenShell(root)).toBe(true);
  });

  it('holds only the Claude credential', async () => {
    const store = createCredentialStore();
    await expect(store.save('codex', { kind: 'api-key', value: 'x' })).rejects.toThrow(
      /holds only the Claude credential/,
    );
    expect(await store.has('codex')).toBe(false);
  });
});

describe('the Claude credential as an OpenShell provider', () => {
  /** A recording `openshell` that knows some profiles and providers. */
  function fakeCli(state: { profiles: string[]; providers: { name: string; type: string }[] }) {
    const calls: { args: string[]; env?: Record<string, string> }[] = [];
    const cli: OpenShellCli = {
      bin: 'openshell',
      async run(args, opts) {
        calls.push({ args, env: opts?.env });
        if (args.join(' ') === 'provider profile list -o json')
          return JSON.stringify(state.profiles.map((id) => ({ id })));
        if (args.join(' ') === 'provider list -o json') return JSON.stringify({ providers: state.providers });
        return '';
      },
    };
    return { cli, calls };
  }
  const root = process.cwd();
  const name = modelProviderName(getInstallSlug(root));
  const SECRET = 'sk-ant-oat01-secret';

  it('first time: imports the profile, then creates the provider with the value only in the child env', async () => {
    const { cli, calls } = fakeCli({ profiles: [], providers: [] });
    expect(await storeModelCredential({ kind: 'oauth', value: SECRET }, root, cli)).toBe('created');
    expect(calls.map((c) => c.args.slice(0, 3).join(' '))).toEqual([
      'provider profile list',
      'provider profile import',
      'provider list -o',
      'provider create --name',
    ]);
    const create = calls.at(-1)!;
    expect(create.args).toEqual([
      'provider',
      'create',
      '--name',
      name,
      '--type',
      MODEL_PROFILE_ID.oauth,
      '--credential',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
    expect(create.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: SECRET });
    expect(calls.flatMap((c) => c.args).join(' ')).not.toContain(SECRET);
  });

  it('same kind: updates in place and waits for attached sandboxes', async () => {
    const { cli, calls } = fakeCli({
      profiles: [MODEL_PROFILE_ID.oauth],
      providers: [{ name, type: MODEL_PROFILE_ID.oauth }],
    });
    expect(await storeModelCredential({ kind: 'oauth', value: SECRET }, root, cli)).toBe('updated');
    expect(calls.at(-1)!.args).toEqual([
      'provider',
      'update',
      name,
      '--credential',
      'CLAUDE_CODE_OAUTH_TOKEN',
      '--wait',
    ]);
    expect(calls.some((c) => c.args[2] === 'import')).toBe(false);
  });

  it('other kind: recreates the provider with the other profile', async () => {
    const { cli, calls } = fakeCli({
      profiles: [MODEL_PROFILE_ID.oauth, MODEL_PROFILE_ID['api-key']],
      providers: [{ name, type: MODEL_PROFILE_ID.oauth }],
    });
    expect(await storeModelCredential({ kind: 'api-key', value: 'sk-ant-api03-k' }, root, cli)).toBe('replaced');
    expect(calls.slice(-2).map((c) => c.args.slice(0, 2).join(' '))).toEqual(['provider delete', 'provider create']);
  });

  it('reports the stored kind, or null', async () => {
    expect(await storedModelCredentialKind(root, fakeCli({ profiles: [], providers: [] }).cli)).toBeNull();
    const withKey = fakeCli({ profiles: [], providers: [{ name, type: MODEL_PROFILE_ID['api-key'] }] });
    expect(await storedModelCredentialKind(root, withKey.cli)).toBe('api-key');
  });
});

describe('agent guidance', () => {
  it('never contains the literal placeholder prefix (OpenShell refuses model requests that carry it)', () => {
    const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'payload', 'container', 'skills');
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toMatch(/openshell:resolve/i);
  });
});
