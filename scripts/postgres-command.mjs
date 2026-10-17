import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const CONNECTION_FLAG = Object.freeze({
  psql: '--dbname', pg_dump: '--dbname', pg_restore: '--dbname',
  createdb: '--maintenance-db', dropdb: '--maintenance-db'
});

export const preparePostgresCommand = (tool, args, databaseUrl) => {
  const flag = CONNECTION_FLAG[tool];
  if (!flag) throw new Error('unsupported PostgreSQL command');
  if (args.some((arg) => /^(?:--(?:dbname|maintenance-db)(?:=|$)|-d)/.test(arg))) {
    throw new Error('PostgreSQL connection override is forbidden');
  }
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('invalid PostgreSQL connection');
  }
  const password = parsed.searchParams.get('password') ?? decodeURIComponent(parsed.password);
  parsed.password = '';
  parsed.searchParams.delete('password');
  // Do not place other password parameters (e.g. SSL key passphrases) in argv.
  if ([...parsed.searchParams.keys()].some((key) => /password/i.test(key))) {
    throw new Error('unsupported password connection parameter');
  }
  return { tool, args: [`${flag}=${parsed.toString()}`, ...args], password };
};

export const runPostgresCommand = (tool, args, databaseUrl, options = {}) => {
  const command = preparePostgresCommand(tool, args, databaseUrl);
  const environment = { ...process.env, PGPASSWORD: command.password, PGCONNECT_TIMEOUT: '10' };
  delete environment.DEPLOY_DATABASE_URL;
  const result = spawnSync(command.tool, command.args, {
    env: environment, stdio: options.stdio ?? ['inherit', 'inherit', 'pipe'],
    encoding: 'utf8', timeout: options.timeoutMs ?? 900_000, killSignal: 'SIGKILL', shell: false
  });
  if (result.error || result.status !== 0) throw new Error('PostgreSQL command failed');
  return result.stdout;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPostgresCommand(process.argv[2], process.argv.slice(3), process.env.DEPLOY_DATABASE_URL);
  } catch {
    // Connection strings and driver/command errors must never reach deploy logs.
    process.stderr.write('[deploy] PostgreSQL command failed\n');
    process.exitCode = 1;
  }
}
