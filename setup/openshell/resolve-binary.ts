import fs from 'node:fs';
import path from 'node:path';

/**
 * Absolute path of an executable: `bin` itself when it contains a slash,
 * else the first match on `envPath`. Undefined when nothing executable is
 * found. Used where a setting must survive the service's fixed PATH.
 */
export function resolveBinary(bin: string, envPath = process.env.PATH ?? ''): string | undefined {
  const isExec = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (bin.includes('/')) return isExec(bin) ? path.resolve(bin) : undefined;
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, bin);
    if (isExec(candidate)) return candidate;
  }
  return undefined;
}
