import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_MOUNT_TARGETS,
  buildOpenShellImage,
  openShellConfigured,
  openShellImageDockerfile,
  workdirConflicts,
  type DockerRunner,
} from './openshell-image.js';

function fakeDocker(opts: { base?: boolean; build?: boolean; workdir?: string } = {}) {
  const calls: { args: string[]; input?: string }[] = [];
  const run: DockerRunner = (args, input) => {
    calls.push({ args, input });
    if (args[0] === 'image' && args.includes('{{.Id}}')) {
      return { status: opts.base === false ? 1 : 0, stdout: 'sha256:abc\n', stderr: '' };
    }
    if (args[0] === 'build') return { status: opts.build === false ? 1 : 0, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: `${opts.workdir ?? '/sandbox'}\n`, stderr: '' };
  };
  return { run, calls };
}

describe('OpenShell-compatible agent image', () => {
  it('the stock WORKDIR collides with the /workspace mount; /sandbox does not', () => {
    expect(workdirConflicts('/workspace/group')).toContain('/workspace');
    expect(workdirConflicts('/app')).toEqual(['/app/.nanoclaw-session.json', '/app/src', '/app/skills']);
    expect(workdirConflicts('/sandbox')).toEqual([]);
    expect(workdirConflicts('/')).toEqual([...AGENT_MOUNT_TARGETS]);
  });

  it('derives from the base with WORKDIR moved to /sandbox and honest labels (the demo script’s recipe)', () => {
    const dockerfile = openShellImageDockerfile('nanoclaw-agent-v2-abc:latest', 'sha256:abc');
    expect(dockerfile.split('\n').slice(0, 5)).toEqual([
      'FROM nanoclaw-agent-v2-abc:latest',
      'USER root',
      'RUN mkdir -p /sandbox && chown node:node /sandbox',
      'USER node',
      'WORKDIR /sandbox',
    ]);
    expect(dockerfile).toContain('LABEL dev.nanoclaw.image-source="derived"');
    expect(dockerfile).toContain('LABEL dev.nanoclaw.derived-from="sha256:abc"');
  });

  it('builds :openshell from :latest and checks the result’s WORKDIR', () => {
    const docker = fakeDocker();
    const result = buildOpenShellImage('/tmp/install-x', docker.run, 'img:latest', 'img:openshell');
    expect(result).toEqual({ ok: true, image: 'img:openshell', base: 'img:latest', workdir: '/sandbox' });
    expect(docker.calls.map((c) => c.args)).toEqual([
      ['image', 'inspect', '--format', '{{.Id}}', 'img:latest'],
      ['build', '-t', 'img:openshell', '-'],
      ['image', 'inspect', '--format', '{{.Config.WorkingDir}}', 'img:openshell'],
    ]);
    expect(docker.calls[1].input).toMatch(/^FROM img:latest\n/);
  });

  it('reports a missing base, a failed build, and a WORKDIR that still overlaps a mount', () => {
    expect(buildOpenShellImage('/r', fakeDocker({ base: false }).run, 'b', 'd')).toMatchObject({
      ok: false,
      reason: 'base-missing',
    });
    expect(buildOpenShellImage('/r', fakeDocker({ build: false }).run, 'b', 'd')).toMatchObject({
      ok: false,
      reason: 'build-failed',
    });
    expect(buildOpenShellImage('/r', fakeDocker({ workdir: '/workspace/group' }).run, 'b', 'd')).toMatchObject({
      ok: false,
      reason: 'workdir-conflict',
    });
  });

  it('AGENT_MOUNT_TARGETS covers every container path container-runner.ts mounts', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'container-runner.ts'), 'utf8');
    const literal = [...source.matchAll(/containerPath:\s*'([^']+)'/g)].map((m) => m[1]);
    const constants = [...source.matchAll(/'(\/workspace\/[^']+)'/g)].map((m) => m[1]);
    expect(literal.length).toBeGreaterThan(3);
    for (const target of new Set([...literal, ...constants])) expect(AGENT_MOUNT_TARGETS).toContain(target);
  });
});

describe('openShellConfigured', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reads NANOCLAW_RUNTIME_DRIVER from the environment, then .env', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-configured-'));
    dirs.push(dir);
    vi.stubEnv('NANOCLAW_RUNTIME_DRIVER', '');
    expect(openShellConfigured(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, '.env'), 'NANOCLAW_RUNTIME_DRIVER="openshell"\n');
    expect(openShellConfigured(dir)).toBe(true);
    vi.stubEnv('NANOCLAW_RUNTIME_DRIVER', 'docker');
    expect(openShellConfigured(dir)).toBe(false);
  });
});
