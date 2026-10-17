import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read one value without executing a shell file or loading application code as
// root. DATABASE_URL is deliberately restricted to a single literal line.
export const parseBackupDatabaseUrl = (contents) => {
  let value;
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const raw = match[1];
    if (raw.startsWith('"') || raw.startsWith("'")) {
      const end = raw.indexOf(raw[0], 1);
      if (end < 0 || !/^\s*(?:#.*)?$/.test(raw.slice(end + 1))) {
        throw new Error('DATABASE_URL must be a single literal URL');
      }
      value = raw.slice(1, end);
    } else {
      value = raw.split('#', 1)[0].trim();
    }
  }
  try {
    if (!value || /[\r\n\0\s]/.test(value)) throw new Error();
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname ||
        !parsed.username || parsed.pathname.length < 2 || parsed.hash) throw new Error();
    return value;
  } catch {
    throw new Error('A valid literal DATABASE_URL is required');
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error();
    process.stdout.write(parseBackupDatabaseUrl(readFileSync(process.argv[2], 'utf8')));
  } catch {
    process.stderr.write('backup: cannot read a valid DATABASE_URL\n');
    process.exitCode = 1;
  }
}
