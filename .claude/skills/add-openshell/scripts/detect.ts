import fs from 'node:fs';
import path from 'node:path';

/**
 * Installation identity comes from config: a copy configured to run its
 * sessions on the OpenShell driver is an OpenShell-gateway copy.
 */
export function detectInstalledOpenShell(root = process.cwd()): boolean {
  try {
    const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const value = env.match(/^\s*(?:export\s+)?NANOCLAW_RUNTIME_DRIVER\s*=\s*(.+)$/m)?.[1]?.trim();
    return value?.replace(/^(['"])(.*)\1$/, '$2').toLowerCase() === 'openshell';
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  console.log(detectInstalledOpenShell() ? 'installed' : 'absent');
}
