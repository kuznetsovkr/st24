import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  formatMonitorConfigCheckError,
  runMonitorConfigCheck
} from './configCheck';
import { loadMonitorConfiguration } from './config';
import { assertSupportedNodeVersion } from './config';

type Environment = Record<string, string | undefined>;

const validEnvironment = (): Record<string, string> => ({
  MONITOR_SITE_URL: 'https://shop.example.test',
  MONITOR_HOMEPAGE_MARKER: 'Expected shop title',
  MONITOR_HEARTBEAT_URL: 'https://heartbeat.example.test/monitor-secret',
  TELEGRAM_OUTBOUND_PROXY_URL:
    'socks5://proxy-user:proxy-password@proxy.example.test:1080',
  TELEGRAM_BOT_TOKEN: 'main-secret-token',
  TELEGRAM_ORDERS_BOT_TOKEN: 'orders-secret-token',
  TELEGRAM_B2B_BOT_TOKEN: 'b2b-secret-token',
  MONITOR_TELEGRAM_MAIN_MODE: 'polling',
  MONITOR_TELEGRAM_ORDERS_MODE: 'polling',
  MONITOR_TELEGRAM_B2B_MODE: 'polling',
  MONITOR_TELEGRAM_MAIN_USERNAME: 'main_bot',
  MONITOR_TELEGRAM_ORDERS_USERNAME: 'orders_bot',
  MONITOR_TELEGRAM_B2B_USERNAME: 'b2b_bot',
  MONITOR_TELEGRAM_CANARY_CHAT_ID: '-100456',
  MONITOR_TELEGRAM_BOT_TOKEN: 'monitor-secret-token',
  MONITOR_TELEGRAM_BOT_USERNAME: 'monitor_bot',
  MONITOR_TELEGRAM_CHAT_ID: '-100123'
});

const serializeEnvironment = (environment: Record<string, string>) =>
  `${Object.entries(environment)
    .map(([name, value]) => `${name}=${value}`)
    .join('\n')}\n`;

const operatingSystemEnvironment = (): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'Path',
    'HOME',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LD_LIBRARY_PATH'
  ]) {
    if (process.env[name] !== undefined) result[name] = process.env[name];
  }
  return result;
};

test('preflight rejects runtimes outside the workspace Node.js range', () => {
  for (const version of ['20.19.0', '22.13.0', '24.0.0']) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
  for (const version of ['18.20.0', '20.18.1', '22.12.0', '23.9.0']) {
    assert.throws(() => assertSupportedNodeVersion(version), /Node\.js/);
  }
});

test('loads and validates the same env file without network or state writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-config-'));
  const envFile = join(directory, '.env');
  try {
    await writeFile(envFile, serializeEnvironment(validEnvironment()), {
      encoding: 'utf8',
      mode: 0o600
    });
    const environment: Environment = {};
    const config = loadMonitorConfiguration(environment, {
      defaultEnvFile: envFile,
      cwd: directory
    });

    assert.equal(config.siteUrl.href, 'https://shop.example.test/');
    assert.equal(config.notifier.expectedUsername, 'monitor_bot');
    assert.deepEqual(await readdir(directory), ['.env']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('MONITOR_ENV_FILE is used by both monitor runtime loading and preflight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-env-'));
  const defaultEnvFile = join(directory, 'default.env');
  const selectedEnvFile = join(directory, 'selected.env');
  try {
    await writeFile(
      defaultEnvFile,
      'MONITOR_SITE_URL=https://wrong.example.test\n',
      'utf8'
    );
    await writeFile(selectedEnvFile, serializeEnvironment(validEnvironment()), 'utf8');
    const environment: Environment = { MONITOR_ENV_FILE: selectedEnvFile };

    const config = loadMonitorConfiguration(environment, {
      defaultEnvFile,
      cwd: directory
    });
    assert.equal(config.siteUrl.hostname, 'shop.example.test');

    let stdout = '';
    let stderr = '';
    assert.equal(
      runMonitorConfigCheck(
        { MONITOR_ENV_FILE: selectedEnvFile },
        { write: (value) => (stdout += value) },
        { write: (value) => (stderr += value) },
        { defaultEnvFile, cwd: directory, nodeVersion: '22.13.1' }
      ),
      0
    );
    assert.equal(stdout, 'Monitor configuration is valid.\n');
    assert.equal(stderr, '');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preflight exits nonzero and redacts secret values from diagnostics', () => {
  const secret = 'never-print-monitor-secret';
  const environment: Environment = {
    ...validEnvironment(),
    MONITOR_TELEGRAM_BOT_TOKEN: secret
  };
  delete environment.MONITOR_HOMEPAGE_MARKER;
  let stdout = '';
  let stderr = '';

  const exitCode = runMonitorConfigCheck(
    environment,
    { write: (value) => (stdout += value) },
    { write: (value) => (stderr += value) },
    {
      defaultEnvFile: resolve(__dirname, 'missing-monitor.env'),
      nodeVersion: '22.13.1'
    }
  );
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Monitor configuration is invalid:.*MONITOR_HOMEPAGE_MARKER/);
  assert.doesNotMatch(stderr, new RegExp(secret));
  assert.equal(
    formatMonitorConfigCheckError(new Error(`bad ${secret}`), {
      MONITOR_TELEGRAM_BOT_TOKEN: secret
    }),
    'bad [redacted]'
  );
});

test('preflight requires the Telegram canary chat for configured production bots', () => {
  const environment: Environment = validEnvironment();
  delete environment.MONITOR_TELEGRAM_CANARY_CHAT_ID;
  let stderr = '';

  assert.equal(
    runMonitorConfigCheck(
      environment,
      { write: () => undefined },
      { write: (value) => (stderr += value) },
      {
        defaultEnvFile: resolve(__dirname, 'missing-monitor.env'),
        mode: 'summary',
        nodeVersion: '22.13.1'
      }
    ),
    1
  );
  assert.match(stderr, /MONITOR_TELEGRAM_CANARY_CHAT_ID/);

  assert.equal(
    runMonitorConfigCheck(
      environment,
      { write: () => undefined },
      { write: () => undefined },
      {
        defaultEnvFile: resolve(__dirname, 'missing-monitor.env'),
        mode: 'check',
        nodeVersion: '22.13.1'
      }
    ),
    1
  );
});

test('compiled config check CLI only validates and returns the correct status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-cli-'));
  const validEnvFile = join(directory, 'valid.env');
  const invalidEnvFile = join(directory, 'invalid.env');
  const cliPath = resolve(__dirname, 'configCheck.js');
  const secret = 'cli-monitor-secret-token';
  try {
    await writeFile(validEnvFile, serializeEnvironment(validEnvironment()), 'utf8');
    const invalidEnvironment = validEnvironment();
    invalidEnvironment.MONITOR_TELEGRAM_BOT_TOKEN = secret;
    delete invalidEnvironment.MONITOR_HOMEPAGE_MARKER;
    await writeFile(invalidEnvFile, serializeEnvironment(invalidEnvironment), 'utf8');

    const valid = spawnSync(process.execPath, [cliPath], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...operatingSystemEnvironment(),
        MONITOR_ENV_FILE: validEnvFile
      },
      encoding: 'utf8',
      timeout: 10_000
    });
    const currentNodeSupported = (() => {
      try {
        assertSupportedNodeVersion(process.versions.node);
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(valid.status, currentNodeSupported ? 0 : 1, valid.stderr);
    if (currentNodeSupported) {
      assert.equal(valid.stdout, 'Monitor configuration is valid.\n');
    } else {
      assert.match(valid.stderr, /Node\.js/);
    }

    const invalid = spawnSync(process.execPath, [cliPath], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...operatingSystemEnvironment(),
        MONITOR_ENV_FILE: invalidEnvFile
      },
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(invalid.status, 1);
    assert.match(
      invalid.stderr,
      currentNodeSupported
        ? /Monitor configuration is invalid:.*MONITOR_HOMEPAGE_MARKER/
        : /Monitor configuration is invalid:.*Node\.js/
    );
    assert.doesNotMatch(invalid.stderr, new RegExp(secret));
    assert.deepEqual((await readdir(directory)).sort(), ['invalid.env', 'valid.env']);

    const summaryEnvironment = validEnvironment();
    delete summaryEnvironment.MONITOR_TELEGRAM_CANARY_CHAT_ID;
    const summaryEnvFile = join(directory, 'summary.env');
    await writeFile(summaryEnvFile, serializeEnvironment(summaryEnvironment), 'utf8');
    const invalidSummary = spawnSync(process.execPath, [cliPath, 'summary'], {
      cwd: resolve(__dirname, '..'),
      env: {
        ...operatingSystemEnvironment(),
        MONITOR_ENV_FILE: summaryEnvFile
      },
      encoding: 'utf8',
      timeout: 10_000
    });
    assert.equal(invalidSummary.status, 1);
    assert.match(
      invalidSummary.stderr,
      currentNodeSupported ? /MONITOR_TELEGRAM_CANARY_CHAT_ID/ : /Node\.js/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
