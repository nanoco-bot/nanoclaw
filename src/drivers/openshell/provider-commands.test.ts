import { describe, expect, it } from 'vitest';

import {
  assertProfileId,
  assertProviderName,
  isProviderNotFound,
  profileImportArgs,
  profileListArgs,
  profileUpdateArgs,
  providerFlags,
  providerGetArgs,
  sandboxProviderAttachArgs,
  sandboxProviderDetachArgs,
  sandboxProviderListArgs,
} from './provider-commands.js';

describe('provider argv builders', () => {
  it('sandbox provider attach / detach / list name the sandbox explicitly', () => {
    expect(sandboxProviderAttachArgs('ncl-0123abcd', 'granola')).toEqual([
      'sandbox',
      'provider',
      'attach',
      'ncl-0123abcd',
      'granola',
    ]);
    expect(sandboxProviderDetachArgs('ncl-0123abcd', 'granola')).toEqual([
      'sandbox',
      'provider',
      'detach',
      'ncl-0123abcd',
      'granola',
    ]);
    expect(sandboxProviderListArgs('ncl-0123abcd', 'json')).toEqual([
      'sandbox',
      'provider',
      'list',
      'ncl-0123abcd',
      '-o',
      'json',
    ]);
  });

  it('refuses a bad sandbox or provider name', () => {
    expect(() => sandboxProviderAttachArgs('Not_A_Label', 'granola')).toThrow(/sandbox name/);
    expect(() => sandboxProviderAttachArgs('ncl-1', '-rf')).toThrow(/provider name/);
    expect(() => providerGetArgs('')).toThrow(/provider name/);
  });

  it('provider get', () => {
    expect(providerGetArgs('granola')).toEqual(['provider', 'get', 'granola']);
  });

  it('providerFlags: one --provider each, deduplicated, order kept', () => {
    expect(providerFlags(['a', 'b', 'a'])).toEqual(['--provider', 'a', '--provider', 'b']);
    expect(providerFlags([])).toEqual([]);
  });

  it('profile list / import / update', () => {
    expect(profileListArgs()).toEqual(['provider', 'profile', 'list', '-o', 'table']);
    expect(profileListArgs({ output: 'json', global: true })).toEqual([
      'provider',
      'profile',
      'list',
      '-o',
      'json',
      '--global',
    ]);
    expect(profileImportArgs('/tmp/granola.yaml')).toEqual([
      'provider',
      'profile',
      'import',
      '-f',
      '/tmp/granola.yaml',
    ]);
    expect(profileImportArgs('/tmp/g.yaml', { global: true })).toContain('--global');
    expect(profileUpdateArgs('granola', '/tmp/g.yaml')).toEqual([
      'provider',
      'profile',
      'update',
      'granola',
      '-f',
      '/tmp/g.yaml',
    ]);
  });

  it('refuses a profile file path that reads as a flag, and a bad profile id', () => {
    expect(() => profileImportArgs('--global')).toThrow(/may not start with '-'/);
    expect(() => profileImportArgs('')).toThrow(/required/);
    expect(() => profileUpdateArgs('Granola', '/tmp/g.yaml')).toThrow(/profile id/);
    expect(() => assertProfileId('-x')).toThrow(/profile id/);
  });

  it('assertProviderName accepts what `provider create --name` accepts', () => {
    expect(assertProviderName('Anthropic.main_1-x')).toBe('Anthropic.main_1-x');
    expect(() => assertProviderName('x'.repeat(64))).toThrow();
  });

  it('isProviderNotFound recognizes the CLI not-found shapes', () => {
    expect(isProviderNotFound(new Error('status: NotFound, message: "provider not found"'))).toBe(true);
    expect(isProviderNotFound(new Error("provider 'x' does not exist"))).toBe(true);
    expect(isProviderNotFound(new Error('transport error: Connection refused'))).toBe(false);
  });
});
