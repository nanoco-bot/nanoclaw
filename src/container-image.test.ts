/**
 * Agent image selection: the OpenShell driver picks the derived `:openshell`
 * image, and CONTAINER_IMAGE / NANOCLAW_RUNTIME_DRIVER written to `.env` take
 * effect (the service has no EnvironmentFile=; src/config.ts reads `.env`
 * in-process through its readEnvFile allowlist).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getContainerImageBase, getOpenShellContainerImage, resolveContainerImage } from './install-slug.js';

describe('resolveContainerImage', () => {
  const base = getContainerImageBase('/tmp/some-install');

  it('defaults to :latest on docker and to the derived :openshell image on the openshell driver', () => {
    expect(resolveContainerImage({}, '/tmp/some-install')).toBe(`${base}:latest`);
    expect(resolveContainerImage({ NANOCLAW_RUNTIME_DRIVER: 'docker' }, '/tmp/some-install')).toBe(`${base}:latest`);
    expect(resolveContainerImage({ NANOCLAW_RUNTIME_DRIVER: 'OpenShell' }, '/tmp/some-install')).toBe(
      `${base}:openshell`,
    );
    expect(getOpenShellContainerImage('/tmp/some-install')).toBe(`${base}:openshell`);
  });

  it('an explicit CONTAINER_IMAGE always wins; CONTAINER_IMAGE_BASE moves both defaults', () => {
    expect(
      resolveContainerImage(
        { CONTAINER_IMAGE: 'registry/x:1', NANOCLAW_RUNTIME_DRIVER: 'openshell' },
        '/tmp/some-install',
      ),
    ).toBe('registry/x:1');
    expect(resolveContainerImage({ CONTAINER_IMAGE_BASE: 'custom', NANOCLAW_RUNTIME_DRIVER: 'openshell' })).toBe(
      'custom:openshell',
    );
  });
});

describe('src/config.ts reads image selection from .env', () => {
  let cwd: string;
  let previous: string;

  beforeEach(() => {
    previous = process.cwd();
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'config-image-'));
    process.chdir(cwd);
    vi.resetModules();
    vi.stubEnv('CONTAINER_IMAGE', '');
    vi.stubEnv('CONTAINER_IMAGE_BASE', '');
    vi.stubEnv('NANOCLAW_RUNTIME_DRIVER', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.chdir(previous);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('CONTAINER_IMAGE in .env takes effect', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'CONTAINER_IMAGE=nanoclaw-agent-v2-x:openshell\n');
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe('nanoclaw-agent-v2-x:openshell');
  });

  it('NANOCLAW_RUNTIME_DRIVER=openshell in .env selects the derived image without any CONTAINER_IMAGE', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'NANOCLAW_RUNTIME_DRIVER=openshell\n');
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe(`${config.CONTAINER_IMAGE_BASE}:openshell`);
  });

  it('process.env still wins over .env', async () => {
    fs.writeFileSync(path.join(cwd, '.env'), 'CONTAINER_IMAGE=from-file:1\n');
    vi.stubEnv('CONTAINER_IMAGE', 'from-process:2');
    const config = await import('./config.js');
    expect(config.CONTAINER_IMAGE).toBe('from-process:2');
  });

  it('the readEnvFile allowlist names CONTAINER_IMAGE (and its base / the driver)', () => {
    const source = fs.readFileSync(path.join(previous, 'src', 'config.ts'), 'utf8');
    const allowlist = source.slice(source.indexOf('readEnvFile(['), source.indexOf(']);'));
    for (const key of ['CONTAINER_IMAGE', 'CONTAINER_IMAGE_BASE', 'NANOCLAW_RUNTIME_DRIVER']) {
      expect(allowlist).toContain(`'${key}'`);
    }
  });
});
