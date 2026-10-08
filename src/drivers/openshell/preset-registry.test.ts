/**
 * Egress presets: strict parsing (unknown keys fail, like parsePolicyConfig),
 * the shipped bundles load, and each rule expands to exactly the
 * `policyUpdateArgs` options add-rule would be given by hand.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { policyUpdateArgs } from './policy-commands.js';
import { listPresets, loadPreset, parsePreset, presetsDir, presetUpdateOptions } from './preset-registry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function dirWith(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'os-presets-'));
  dirs.push(d);
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
  return d;
}

const TWO_RULES = `
name: demo
version: 2
description: Two rules.
rules:
  - name: demo_api
    host: api.example.com
    ports: [443]
    binaries: [/usr/local/bin/node]
  - name: demo_git
    host: git.example.com
    ports: [443, 8443]
    binaries: [/usr/bin/git, /usr/local/bin/bun]
`;

describe('parsePreset (strict)', () => {
  it('parses a valid preset into EgressRules', () => {
    const p = parsePreset(TWO_RULES, 'demo');
    expect(p).toEqual({
      name: 'demo',
      version: 2,
      description: 'Two rules.',
      rules: [
        { name: 'demo_api', host: 'api.example.com', ports: [443], binaries: ['/usr/local/bin/node'] },
        {
          name: 'demo_git',
          host: 'git.example.com',
          ports: [443, 8443],
          binaries: ['/usr/bin/git', '/usr/local/bin/bun'],
        },
      ],
    });
  });

  it('an unknown top-level key fails, naming it and the file', () => {
    expect(() => parsePreset(`${TWO_RULES}\nauthor: me\n`, 'demo')).toThrow(
      "OpenShell egress preset demo.yaml: root: unknown key 'author'",
    );
  });

  it('an unknown key inside a rule fails (no allow/deny shape invented: rules are EgressRule)', () => {
    const text = TWO_RULES.replace(
      '    ports: [443]\n    binaries: [/usr/local/bin/node]',
      '    ports: [443]\n    allow: true\n    binaries: [/usr/local/bin/node]',
    );
    expect(() => parsePreset(text, 'demo')).toThrow("demo.yaml: rules[0]: unknown key 'allow'");
  });

  it.each([
    ['name must match the file', TWO_RULES.replace('name: demo\n', 'name: other\n'), /name: must be 'demo'/],
    [
      'version is a positive integer',
      TWO_RULES.replace('version: 2', 'version: 1.5'),
      /version: must be a positive integer/,
    ],
    ['version is required', TWO_RULES.replace('version: 2\n', ''), /version: must be a positive integer/],
    ['description is required', TWO_RULES.replace('description: Two rules.\n', ''), /description: must be a non-empty/],
    ['rules are non-empty', 'name: demo\nversion: 1\ndescription: x\nrules: []\n', /rules: must be a non-empty list/],
    ['ports are numbers', TWO_RULES.replace('ports: [443]', 'ports: ["443"]'), /ports must be an array of numbers/],
    [
      'binaries are absolute',
      TWO_RULES.replace('[/usr/local/bin/node]', '[node]'),
      /binary 'node' must be an absolute path/,
    ],
    ['a host is bare', TWO_RULES.replace('api.example.com', 'api.example.com:443'), /must be a bare host name/],
    ['rule names are unique', TWO_RULES.replace('demo_git', 'demo_api'), /duplicate rule name 'demo_api'/],
    ['rule names fit OpenShell', TWO_RULES.replace('demo_api', 'bad name'), /egress rule name 'bad name'/],
    ['duplicate YAML keys', TWO_RULES.replace('version: 2', 'version: 2\nversion: 3'), /yaml:/],
    ['not a mapping', '- just\n- a list\n', /root: must be a mapping/],
  ])('%s', (_what, text, error) => {
    expect(() => parsePreset(text, 'demo')).toThrow(error);
  });
});

describe('loadPreset / listPresets', () => {
  it('a nonexistent preset fails cleanly, listing what exists', () => {
    const d = dirWith({ 'demo.yaml': TWO_RULES });
    expect(() => loadPreset('nope', d)).toThrow("unknown egress preset 'nope' (available: demo)");
  });

  it('a name is never a path', () => {
    const d = dirWith({ 'demo.yaml': TWO_RULES });
    expect(() => loadPreset('../demo', d)).toThrow(/is not a preset name/);
    expect(() => loadPreset('Demo', d)).toThrow(/is not a preset name/);
  });

  it('lists summaries; one broken file fails the listing instead of hiding', () => {
    const d = dirWith({ 'demo.yaml': TWO_RULES });
    expect(listPresets(d)).toEqual([{ name: 'demo', version: 2, description: 'Two rules.', rules: 2 }]);
    fs.writeFileSync(path.join(d, 'broken.yaml'), 'name: broken\nversion: 1\ndescription: x\nrules: [{name: a}]\n');
    expect(() => listPresets(d)).toThrow(/broken\.yaml/);
  });

  it('the shipped presets all load strictly', () => {
    const shipped = listPresets();
    expect(shipped.map((p) => p.name)).toEqual(['github']);
    for (const p of shipped) expect(p.version).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(presetsDir(), 'github.yaml'))).toBe(true);
  });
});

describe('presetUpdateOptions', () => {
  it('one add-rule-shaped options object per rule and port, named after the rule', () => {
    expect(presetUpdateOptions(parsePreset(TWO_RULES, 'demo'))).toEqual([
      {
        rule: 'demo_api',
        options: { addEndpoint: ['api.example.com:443'], binary: ['/usr/local/bin/node'], ruleName: 'demo_api' },
      },
      {
        rule: 'demo_git',
        options: {
          addEndpoint: ['git.example.com:443'],
          binary: ['/usr/bin/git', '/usr/local/bin/bun'],
          ruleName: 'demo_git',
        },
      },
      {
        rule: 'demo_git',
        options: {
          addEndpoint: ['git.example.com:8443'],
          binary: ['/usr/bin/git', '/usr/local/bin/bun'],
          ruleName: 'demo_git',
        },
      },
    ]);
  });

  it('every expansion is a valid policyUpdateArgs call (one --add-endpoint per --rule-name, as OpenShell requires)', () => {
    for (const { options } of presetUpdateOptions(loadPreset('github'))) {
      const argv = policyUpdateArgs('ncl-abc', options);
      expect(argv.filter((a) => a === '--add-endpoint')).toHaveLength(1);
      expect(argv).toContain('--rule-name');
    }
  });
});
