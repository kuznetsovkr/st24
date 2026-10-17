import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import test from 'node:test';
import { formatConfigCheckError, runBackendConfigCheck } from './configCheck';
import {
  assertSupportedNodeVersion,
  validateServerStartupConfig
} from './startupConfig';

type Environment = Record<string, string | undefined>;

const developmentEnvironment = (): Environment => ({
  NODE_ENV: 'development',
  PORT: '4000',
  API_BIND_HOST: '127.0.0.1',
  DATABASE_URL: 'postgresql://her:local-password@127.0.0.1:5432/her',
  JWT_SECRET: 'development-only-secret',
  TELEGRAM_MAIN_MODE: 'disabled',
  TELEGRAM_ORDERS_MODE: 'disabled',
  TELEGRAM_B2B_MODE: 'disabled',
  TELEGRAM_POLLING: '',
  TELEGRAM_ORDERS_POLLING: '',
  TELEGRAM_B2B_POLLING: '',
  TRUST_PROXY: 'false'
});

const productionEnvironment = (): Environment => ({
  ...developmentEnvironment(),
  NODE_ENV: 'production',
  JWT_SECRET: 'fM3q9Lz7Vx2Cn8Wp4Rt6Yu1Ka5Hs0DeB',
  ADMIN_PHONE: '79991234567',
  ADMIN_AUTH_MODE: 'password',
  ADMIN_PASSWORD: 'Q7m!pL2#vN9$xR4',
  CLIENT_URL: 'https://shop.example.test',
  AUTH_COOKIE_SECURE: 'true',
  SMS_RU_API_ID: 'sms-api-id',
  TURNSTILE_SECRET_KEY: 'turnstile-secret'
});

test('validates a complete backend configuration without external I/O', () => {
  const config = validateServerStartupConfig(developmentEnvironment());
  assert.deepEqual(config, {
    nodeEnvironment: 'development',
    port: 4000,
    bindHost: '127.0.0.1',
    trustProxy: false
  });

  const productionConfig = validateServerStartupConfig(productionEnvironment());
  assert.equal(productionConfig.nodeEnvironment, 'production');
});

test('accepts only the Node.js versions supported by every workspace', () => {
  for (const version of ['20.19.0', '20.20.1', '22.13.0', '22.99.0', '24.0.0', '25.1.0']) {
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }
  for (const version of ['18.20.0', '20.18.1', '21.7.0', '22.12.0', '23.9.0', 'invalid']) {
    assert.throws(() => assertSupportedNodeVersion(version), /Node\.js/);
  }
});

test('requires an explicit supported NODE_ENV, port and bind host', () => {
  for (const value of [undefined, '', 'staging', 'Production', ' production ']) {
    assert.throws(
      () => validateServerStartupConfig({ ...developmentEnvironment(), NODE_ENV: value }),
      /NODE_ENV/
    );
  }
  for (const value of [undefined, '', '0', '65536', '4000x']) {
    assert.throws(
      () => validateServerStartupConfig({ ...developmentEnvironment(), PORT: value }),
      /PORT/
    );
  }
  for (const value of [undefined, '', 'https://127.0.0.1', 'bad host']) {
    assert.throws(
      () => validateServerStartupConfig({ ...developmentEnvironment(), API_BIND_HOST: value }),
      /API_BIND_HOST/
    );
  }
});

test('requires a syntactically valid PostgreSQL database URL', () => {
  for (const value of [
    undefined,
    'mysql://user:password@db.example.test/her',
    'postgresql://db.example.test',
    'not-a-url'
  ]) {
    assert.throws(
      () => validateServerStartupConfig({ ...developmentEnvironment(), DATABASE_URL: value }),
      /DATABASE_URL/
    );
  }
});

test('production rejects weak JWT secrets and insecure web configuration', () => {
  for (const value of [
    'short',
    'replace-with-a-long-random-secret',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ]) {
    assert.throws(
      () => validateServerStartupConfig({ ...productionEnvironment(), JWT_SECRET: value }),
      /JWT_SECRET/
    );
  }

  const noOrigins = productionEnvironment();
  delete noOrigins.CLIENT_URL;
  assert.throws(() => validateServerStartupConfig(noOrigins), /HTTPS.*origin/i);

  for (const value of [
    'http://shop.example.test',
    'https://shop.example.test/path',
    'https://shop.example.test/',
    'https://shop.example.test:443'
  ]) {
    assert.throws(
      () => validateServerStartupConfig({ ...productionEnvironment(), CLIENT_URL: value }),
      /CLIENT_URL/
    );
  }
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...productionEnvironment(),
        AUTH_COOKIE_SECURE: 'false'
      }),
    /AUTH_COOKIE_SECURE/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...productionEnvironment(),
        AUTH_COOKIE_SECURE: ''
      }),
    /AUTH_COOKIE_SECURE/
  );
  for (const value of ['invalid', 'Lax']) {
    assert.throws(
      () =>
        validateServerStartupConfig({
          ...productionEnvironment(),
          AUTH_COOKIE_SAMESITE: value
        }),
      /AUTH_COOKIE_SAMESITE/
    );
  }
});

test('production requires explicit safe privileged-access configuration', () => {
  for (const value of [undefined, '', 'not-a-phone', '69991234567']) {
    assert.throws(
      () => validateServerStartupConfig({ ...productionEnvironment(), ADMIN_PHONE: value }),
      /ADMIN_PHONE/
    );
  }
  for (const value of [undefined, '', 'legacy']) {
    assert.throws(
      () =>
        validateServerStartupConfig({
          ...productionEnvironment(),
          ADMIN_AUTH_MODE: value
        }),
      /ADMIN_AUTH_MODE/
    );
  }
  for (const value of [undefined, '', 'password', 'aaaaaaaaaaaa']) {
    assert.throws(
      () => validateServerStartupConfig({ ...productionEnvironment(), ADMIN_PASSWORD: value }),
      /ADMIN_PASSWORD/
    );
  }

  assert.doesNotThrow(() =>
    validateServerStartupConfig({
      ...productionEnvironment(),
      ADMIN_AUTH_MODE: 'code',
      ADMIN_PASSWORD: undefined
    })
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...productionEnvironment(),
        SUPER_ADMIN_PHONE: '78881234567'
      }),
    /SUPER_ADMIN_PASSWORD/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...productionEnvironment(),
        SUPER_ADMIN_PHONE: '79991234567',
        SUPER_ADMIN_PASSWORD: 'N4x!sK8#pT2$vM7'
      }),
    /SUPER_ADMIN_PHONE must differ/
  );
  assert.doesNotThrow(() =>
    validateServerStartupConfig({
      ...productionEnvironment(),
      SUPER_ADMIN_PHONE: '+78881234567',
      SUPER_ADMIN_PASSWORD: 'N4x!sK8#pT2$vM7'
    })
  );
});

test('required rate-limit Redis is enabled and uses a valid Redis URL', () => {
  for (const name of ['RATE_LIMIT_REDIS_ENABLED', 'RATE_LIMIT_REDIS_REQUIRED'] as const) {
    for (const value of ['', 'maybe', 'yes', 'no']) {
      assert.throws(
        () => validateServerStartupConfig({ ...developmentEnvironment(), [name]: value }),
        new RegExp(name)
      );
    }
  }

  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        RATE_LIMIT_REDIS_REQUIRED: 'true',
        RATE_LIMIT_REDIS_ENABLED: 'false'
      }),
    /RATE_LIMIT_REDIS_ENABLED/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        RATE_LIMIT_REDIS_REQUIRED: 'true'
      }),
    /RATE_LIMIT_REDIS_URL or REDIS_URL is required/
  );
  for (const value of [
    'http://redis.example.test',
    'redis://',
    'redis://redis.example.test/0#fragment'
  ]) {
    assert.throws(
      () =>
        validateServerStartupConfig({
          ...developmentEnvironment(),
          RATE_LIMIT_REDIS_REQUIRED: 'true',
          RATE_LIMIT_REDIS_URL: value
        }),
      /valid Redis URL/
    );
  }
  assert.doesNotThrow(() =>
    validateServerStartupConfig({
      ...developmentEnvironment(),
      RATE_LIMIT_REDIS_REQUIRED: 'true',
      RATE_LIMIT_REDIS_ENABLED: 'true',
      RATE_LIMIT_REDIS_URL: 'rediss://redis-user:redis-password@redis.example.test:6380/0'
    })
  );
});

test('runs the existing integration and runtime validators', () => {
  const missingSms = productionEnvironment();
  delete missingSms.SMS_RU_API_ID;
  assert.throws(() => validateServerStartupConfig(missingSms), /SMS_RU_API_ID/);

  const missingTurnstile = productionEnvironment();
  delete missingTurnstile.TURNSTILE_SECRET_KEY;
  assert.throws(() => validateServerStartupConfig(missingTurnstile), /TURNSTILE_SECRET_KEY/);

  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        TELEGRAM_MAIN_MODE: 'polling'
      }),
    /TELEGRAM_BOT_TOKEN/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        YOOKASSA_SHOP_ID: 'shop-without-secret'
      }),
    /must be configured together/
  );
  assert.throws(
    () => validateServerStartupConfig({ ...productionEnvironment(), TRUST_PROXY: 'true' }),
    /TRUST_PROXY/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        TELEGRAM_OUTBOUND_PROXY_URL: 'ftp://proxy.example.test'
      }),
    /TELEGRAM_OUTBOUND_PROXY_URL/
  );
  assert.throws(
    () =>
      validateServerStartupConfig({
        ...developmentEnvironment(),
        TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS: 'zero'
      }),
    /TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS/
  );
});

test('config check returns a nonzero result and never prints secret values', () => {
  const secret = 'do-not-print-this-token';
  let stdout = '';
  let stderr = '';
  const exitCode = runBackendConfigCheck(
    { ...developmentEnvironment(), JWT_SECRET: secret, PORT: 'invalid' },
    { write: (value) => (stdout += value) },
    { write: (value) => (stderr += value) },
    { nodeVersion: '22.13.1' }
  );

  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /Backend configuration is invalid: PORT/);
  assert.doesNotMatch(stderr, new RegExp(secret));
  assert.equal(
    formatConfigCheckError(new Error(`bad ${secret}`), { JWT_SECRET: secret }),
    'bad [redacted]'
  );
});

test('compiled config check CLI exits successfully or nonzero without connecting anywhere', () => {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    ...developmentEnvironment(),
    DOTENV_CONFIG_PATH: resolve(__dirname, 'missing-config-check.env'),
    DOTENV_CONFIG_QUIET: 'true',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_ORDERS_BOT_TOKEN: '',
    TELEGRAM_B2B_BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: '',
    TELEGRAM_ORDERS_WEBHOOK_SECRET: '',
    TELEGRAM_B2B_WEBHOOK_SECRET: '',
    TELEGRAM_MAIN_WEBHOOK_URL: '',
    TELEGRAM_ORDERS_WEBHOOK_URL: '',
    TELEGRAM_B2B_WEBHOOK_URL: '',
    YOOKASSA_SHOP_ID: '',
    YOOKASSA_SECRET_KEY: '',
    TELEGRAM_OUTBOUND_PROXY_URL: '',
    RATE_LIMIT_REDIS_ENABLED: 'true',
    RATE_LIMIT_REDIS_REQUIRED: 'false',
    RATE_LIMIT_REDIS_URL: '',
    REDIS_URL: ''
  };
  const cliPath = resolve(__dirname, 'configCheck.js');
  const valid = spawnSync(process.execPath, [cliPath], {
    cwd: resolve(__dirname, '..'),
    env: baseEnvironment,
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
    assert.equal(valid.stdout, 'Backend configuration is valid.\n');
  } else {
    assert.match(valid.stderr, /Node\.js/);
  }

  const secret = 'cli-database-password';
  const invalid = spawnSync(process.execPath, [cliPath], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...baseEnvironment,
      DATABASE_URL: `postgresql://user:${secret}@`
    },
    encoding: 'utf8',
    timeout: 10_000
  });
  assert.equal(invalid.status, 1);
  assert.match(
    invalid.stderr,
    currentNodeSupported
      ? /Backend configuration is invalid: DATABASE_URL/
      : /Backend configuration is invalid: Node\.js/
  );
  assert.doesNotMatch(invalid.stderr, new RegExp(secret));
});
