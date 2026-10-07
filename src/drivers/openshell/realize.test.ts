/**
 * createArgs() — the `openshell sandbox create` argv, pure. Focus: the
 * per-agent-group `--provider` flags (one per attached provider).
 */
import { describe, expect, it } from 'vitest';

import { fixtureSpec } from '../spec-fixture.js';
import { createArgs, sandboxName, type CreateArgsInput } from './realize.js';

function input(providers: readonly string[]): CreateArgsInput {
  const spec = fixtureSpec();
  return {
    spec,
    container: spec.containers.find((c) => c.role === 'agent')!,
    name: sandboxName(spec.key),
    policyPath: '/tmp/x/policy.yaml',
    driverConfig: null,
    providers,
  };
}

const providerValues = (args: string[]) => args.flatMap((a, i) => (a === '--provider' ? [args[i + 1]] : []));

describe('createArgs — providers', () => {
  it('no attached providers: no --provider flag at all (pre-feature argv)', () => {
    const args = createArgs(input([]));
    expect(args).not.toContain('--provider');
    expect(args).toEqual(expect.arrayContaining(['--detach', '--no-tty', '--no-auto-providers', '-o', 'json']));
  });

  it('one attached provider: exactly one --provider <name>', () => {
    expect(providerValues(createArgs(input(['granola'])))).toEqual(['granola']);
  });

  it('several attached providers: one --provider per provider, in attach order', () => {
    const args = createArgs(input(['granola', 'github-main', 'anthropic.prod']));
    expect(providerValues(args)).toEqual(['granola', 'github-main', 'anthropic.prod']);
    expect(args.filter((a) => a === '--provider')).toHaveLength(3);
  });

  it('a duplicate in the stored list is emitted once', () => {
    expect(providerValues(createArgs(input(['granola', 'granola'])))).toEqual(['granola']);
  });

  it('keeps --no-auto-providers alongside --provider (a missing provider fails the create, never auto-created)', () => {
    const args = createArgs(input(['granola']));
    expect(args).toContain('--no-auto-providers');
  });

  it('places provider flags before the `--` command separator', () => {
    const args = createArgs(input(['granola', 'github-main']));
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.lastIndexOf('--provider')).toBeLessThan(sep);
    expect(args.slice(sep)).toEqual(['--', 'bash', '-c', 'exec bun run /app/src/index.ts']);
  });

  it.each([['-x'], ['--policy'], [''], ['has space'], ['a/b']])(
    'refuses a provider name the CLI could misread: %j',
    (bad) => {
      expect(() => createArgs(input([bad]))).toThrow(/not a valid OpenShell provider name/);
    },
  );
});
