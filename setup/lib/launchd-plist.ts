/**
 * Minimal, byte-preserving edits to the NanoClaw LaunchAgent plist's
 * `EnvironmentVariables` dict — the macOS counterpart of the systemd
 * credential drop-in (setup/lib/openshell-credential.ts).
 *
 * Text edits, not parse-and-reserialize: everything outside the touched
 * `<key>…</key><string>…</string>` pairs stays byte-for-byte as
 * setup/service.ts (setupLaunchd) wrote it. That plist's EnvironmentVariables
 * dict holds only string values, so its first `</dict>` closes it.
 *
 * No imports, so setup/service.ts and the credential module can both use it
 * without importing each other.
 */

/** The model-relay credential variables (= Object.values(CREDENTIAL_ENV); a test keeps them equal). */
export const RELAY_CREDENTIAL_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const;

const ENV_DICT = /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)([ \t]*<\/dict>)/;
const PAIR = /<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g;

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The EnvironmentVariables dict as a map, or undefined when the plist has none. */
export function readPlistEnvironment(plist: string): Map<string, string> | undefined {
  const m = plist.match(ENV_DICT);
  if (!m) return undefined;
  const env = new Map<string, string>();
  for (const pair of m[2].matchAll(PAIR)) env.set(xmlUnescape(pair[1]), xmlUnescape(pair[2]));
  return env;
}

/**
 * Set `set` (replacing each key's value in place, or appending it at the end
 * of the dict) and remove `remove`; every other byte is unchanged. A plist
 * without an EnvironmentVariables dict gets one, appended to the top-level
 * dict.
 */
export function editPlistEnvironment(
  plist: string,
  set: Record<string, string>,
  remove: readonly string[] = [],
): string {
  const m = plist.match(ENV_DICT);
  if (!m) {
    const close = plist.lastIndexOf('</dict>');
    if (close < 0 || !/<\/plist>\s*$/.test(plist)) throw new Error('Not a property list this setup can edit');
    const entries = Object.entries(set)
      .map(([k, v]) => `        <key>${k}</key>\n        <string>${xmlEscape(v)}</string>\n`)
      .join('');
    const block = `    <key>EnvironmentVariables</key>\n    <dict>\n${entries}    </dict>\n`;
    return plist.slice(0, close) + block + plist.slice(close);
  }
  let body = m[2];
  for (const key of remove) {
    if (key in set) continue;
    body = body.replace(new RegExp(`\\s*<key>${escapeRegExp(key)}</key>\\s*<string>[^<]*</string>`, 'g'), '');
  }
  for (const [key, value] of Object.entries(set)) {
    const existing = new RegExp(`(<key>${escapeRegExp(key)}</key>\\s*<string>)[^<]*(</string>)`);
    if (existing.test(body)) {
      body = body.replace(existing, `$1${xmlEscape(value)}$2`);
    } else {
      // Same layout setupLaunchd uses: 8-space indent, appended after the last entry.
      const trimmed = body.replace(/\s*$/, '');
      const tail = body.slice(trimmed.length);
      body = `${trimmed}\n        <key>${key}</key>\n        <string>${xmlEscape(value)}</string>${tail}`;
    }
  }
  return plist.slice(0, m.index!) + m[1] + body + m[3] + plist.slice(m.index! + m[0].length);
}
