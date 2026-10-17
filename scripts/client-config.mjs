#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLIENT_VITE_ALLOWLIST = Object.freeze([
  'VITE_API_URL',
  'VITE_SITE_URL',
  'VITE_TURNSTILE_SITE_KEY',
  'VITE_YANDEX_MAPS_API_KEY',
  'VITE_CDEK_FROM_CODE',
  'VITE_CDEK_FROM_LOCATION',
  'VITE_CDEK_DEFAULT_LOCATION'
]);

const REQUIRED_VALUES = Object.freeze([
  'VITE_API_URL',
  'VITE_SITE_URL',
  'VITE_TURNSTILE_SITE_KEY',
  'VITE_YANDEX_MAPS_API_KEY',
  'VITE_CDEK_DEFAULT_LOCATION'
]);

const MAX_ENV_FILE_BYTES = 64 * 1024;
const DEFAULT_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);

export class ClientConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClientConfigError';
  }
}

const requiredValue = (source, name) => {
  const value = String(source[name] ?? '').trim();
  if (!value) {
    throw new ClientConfigError(`${name} is required`);
  }
  if (/[\0\r\n]/.test(value)) {
    throw new ClientConfigError(`${name} must be a single-line value`);
  }
  return value;
};

const assertPublicHttpsOrigin = (name, value) => {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ClientConfigError(`${name} must be a valid HTTPS origin`);
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== value
  ) {
    throw new ClientConfigError(
      `${name} must be a canonical HTTPS origin without credentials, path, query or fragment`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  const ipVersion = isIP(hostname);
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    ipVersion !== 0
  ) {
    throw new ClientConfigError(`${name} must use a public DNS hostname`);
  }
};

const assertPublicKey = (name, value) => {
  if (value.length < 8 || value.length > 512 || /\s/.test(value)) {
    throw new ClientConfigError(`${name} must be a non-placeholder public key`);
  }
  if (/^(?:change|replace|example|todo|<)/i.test(value)) {
    throw new ClientConfigError(`${name} must be a non-placeholder public key`);
  }
};

const assertLocation = (name, value) => {
  if (value.length > 300) {
    throw new ClientConfigError(`${name} is too long`);
  }
};

export const validateClientConfig = (source, options = {}) => {
  const config = {};
  for (const name of REQUIRED_VALUES) {
    config[name] = requiredValue(source, name);
  }

  const fromCode = String(source.VITE_CDEK_FROM_CODE ?? '').trim();
  const fromLocation = String(source.VITE_CDEK_FROM_LOCATION ?? '').trim();
  if (!fromCode && !fromLocation) {
    throw new ClientConfigError(
      'VITE_CDEK_FROM_CODE or VITE_CDEK_FROM_LOCATION is required'
    );
  }
  if (fromCode && (!/^[1-9]\d*$/.test(fromCode) || fromCode.length > 10)) {
    throw new ClientConfigError('VITE_CDEK_FROM_CODE must be a positive integer');
  }
  if (fromLocation) {
    if (/[\0\r\n]/.test(fromLocation)) {
      throw new ClientConfigError('VITE_CDEK_FROM_LOCATION must be a single-line value');
    }
    assertLocation('VITE_CDEK_FROM_LOCATION', fromLocation);
  }

  assertPublicHttpsOrigin('VITE_API_URL', config.VITE_API_URL);
  assertPublicHttpsOrigin('VITE_SITE_URL', config.VITE_SITE_URL);
  assertPublicKey('VITE_TURNSTILE_SITE_KEY', config.VITE_TURNSTILE_SITE_KEY);
  assertPublicKey('VITE_YANDEX_MAPS_API_KEY', config.VITE_YANDEX_MAPS_API_KEY);
  assertLocation('VITE_CDEK_DEFAULT_LOCATION', config.VITE_CDEK_DEFAULT_LOCATION);

  const expectedApiUrl = String(options.expectedApiUrl ?? '').trim();
  if (expectedApiUrl && config.VITE_API_URL !== expectedApiUrl) {
    throw new ClientConfigError('VITE_API_URL does not exactly match EXPECTED_VITE_API_URL');
  }

  if (fromCode) config.VITE_CDEK_FROM_CODE = fromCode;
  if (fromLocation) config.VITE_CDEK_FROM_LOCATION = fromLocation;
  return Object.freeze(config);
};

const resolveRepositoryRoot = (environment) =>
  path.resolve(environment.CLIENT_CONFIG_ROOT || DEFAULT_REPOSITORY_ROOT);

const loadDotenv = (repositoryRoot) => {
  const requireFromServer = createRequire(path.join(repositoryRoot, 'server', 'package.json'));
  return requireFromServer('dotenv');
};

export const loadClientConfig = (options = {}) => {
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot(environment);
  const configuredPath = environment.CLIENT_ENV_FILE || path.join('client', '.env');
  const envPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(repositoryRoot, configuredPath);

  let stats;
  let contents;
  try {
    stats = statSync(envPath);
    if (!stats.isFile()) throw new Error('not a regular file');
    if (stats.size > MAX_ENV_FILE_BYTES) throw new Error('file is too large');
    contents = readFileSync(envPath, 'utf8');
  } catch {
    throw new ClientConfigError(`CLIENT_ENV_FILE is not a readable regular file: ${envPath}`);
  }

  let parsed;
  try {
    parsed = loadDotenv(repositoryRoot).parse(contents);
  } catch {
    throw new ClientConfigError('CLIENT_ENV_FILE could not be parsed');
  }

  return {
    config: validateClientConfig(parsed, {
      expectedApiUrl: environment.EXPECTED_VITE_API_URL
    }),
    envPath,
    repositoryRoot
  };
};

export const buildSanitizedEnvironment = (baseEnvironment, config) => {
  const result = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (!name.startsWith('VITE_')) result[name] = value;
  }
  for (const name of CLIENT_VITE_ALLOWLIST) {
    if (config[name] !== undefined) result[name] = config[name];
  }
  result.NODE_ENV = 'production';
  result.CLIENT_CONFIG_MANAGED_BUILD = '1';
  return result;
};

const runBuild = async ({ config, repositoryRoot }, environment) => {
  const requireFromClient = createRequire(path.join(repositoryRoot, 'client', 'package.json'));
  const typescriptCli = requireFromClient.resolve('typescript/bin/tsc');
  const sanitizedEnvironment = buildSanitizedEnvironment(environment, config);
  const result = spawnSync(process.execPath, [typescriptCli, '-p', 'client/tsconfig.json'], {
    cwd: repositoryRoot,
    env: sanitizedEnvironment,
    stdio: 'inherit',
    shell: false
  });
  if (result.error) {
    throw new ClientConfigError('could not start the client build');
  }
  if (result.status !== 0) {
    throw new ClientConfigError(
      `client typecheck failed with exit code ${result.status ?? 'unknown'}`
    );
  }

  const originalPublicEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith('VITE_'))
  );
  const originalManagedBuild = process.env.CLIENT_CONFIG_MANAGED_BUILD;
  const originalNodeEnvironment = process.env.NODE_ENV;
  for (const name of Object.keys(process.env)) {
    if (name.startsWith('VITE_')) delete process.env[name];
  }
  for (const name of CLIENT_VITE_ALLOWLIST) {
    if (config[name] !== undefined) process.env[name] = config[name];
  }
  process.env.NODE_ENV = 'production';
  process.env.CLIENT_CONFIG_MANAGED_BUILD = '1';

  try {
    const viteEntry = requireFromClient.resolve('vite');
    const { build } = await import(pathToFileURL(viteEntry).href);
    await build({
      root: path.join(repositoryRoot, 'client'),
      configFile: path.join(repositoryRoot, 'client', 'vite.config.ts'),
      // This inline setting wins over config defaults and also protects rollback
      // builds whose older vite.config.ts does not know about managed builds.
      envDir: false
    });
  } catch {
    throw new ClientConfigError('client build failed');
  } finally {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('VITE_')) delete process.env[name];
    }
    Object.assign(process.env, originalPublicEnvironment);
    if (originalManagedBuild === undefined) {
      delete process.env.CLIENT_CONFIG_MANAGED_BUILD;
    } else {
      process.env.CLIENT_CONFIG_MANAGED_BUILD = originalManagedBuild;
    }
    if (originalNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnvironment;
    }
  }
};

export const runCli = async (argv = process.argv.slice(2), environment = process.env) => {
  const command = argv[0];
  if (argv.length !== 1 || (command !== 'check' && command !== 'build')) {
    throw new ClientConfigError('usage: node scripts/client-config.mjs <check|build>');
  }

  const loaded = loadClientConfig({ environment });
  if (command === 'build') {
    await runBuild(loaded, environment);
  }
  process.stdout.write(`client config ${command}: ok\n`);
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    await runCli();
  } catch (error) {
    const message = error instanceof ClientConfigError ? error.message : 'unexpected failure';
    process.stderr.write(`client config: ERROR: ${message}\n`);
    process.exitCode = 1;
  }
}
