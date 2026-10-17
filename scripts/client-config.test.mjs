import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSanitizedEnvironment,
  ClientConfigError,
  loadClientConfig,
  validateClientConfig
} from './client-config.mjs';

const VALID_CONFIG = Object.freeze({
  VITE_API_URL: 'https://api.shop.example',
  VITE_SITE_URL: 'https://shop.example',
  VITE_TURNSTILE_SITE_KEY: 'turnstile-public-key',
  VITE_YANDEX_MAPS_API_KEY: 'yandex-public-key',
  VITE_CDEK_FROM_CODE: '123456',
  VITE_CDEK_FROM_LOCATION: 'Krasnoyarsk, Kalinina 1',
  VITE_CDEK_DEFAULT_LOCATION: 'Krasnoyarsk'
});

test('validates a complete production client configuration', () => {
  const result = validateClientConfig(VALID_CONFIG, {
    expectedApiUrl: VALID_CONFIG.VITE_API_URL
  });
  assert.deepEqual(result, VALID_CONFIG);
  assert.equal(Object.isFrozen(result), true);
});

test('accepts a CDEK address when an origin code is unavailable', () => {
  const { VITE_CDEK_FROM_CODE: _omitted, ...withAddressOnly } = VALID_CONFIG;
  assert.equal(
    validateClientConfig(withAddressOnly).VITE_CDEK_FROM_LOCATION,
    VALID_CONFIG.VITE_CDEK_FROM_LOCATION
  );
});

test('rejects missing values, non-public origins and invalid CDEK settings', () => {
  assert.throws(
    () => validateClientConfig({ ...VALID_CONFIG, VITE_TURNSTILE_SITE_KEY: '' }),
    /VITE_TURNSTILE_SITE_KEY is required/
  );
  assert.throws(
    () =>
      validateClientConfig({
        ...VALID_CONFIG,
        VITE_TURNSTILE_SITE_KEY: 'replace-with-public-site-key'
      }),
    /non-placeholder public key/
  );
  assert.throws(
    () => validateClientConfig({ ...VALID_CONFIG, VITE_SITE_URL: 'http:\/\/localhost:5173' }),
    /canonical HTTPS origin/
  );
  assert.throws(
    () =>
      validateClientConfig({
        ...VALID_CONFIG,
        VITE_CDEK_FROM_CODE: '',
        VITE_CDEK_FROM_LOCATION: ''
      }),
    /VITE_CDEK_FROM_CODE or VITE_CDEK_FROM_LOCATION is required/
  );
  assert.throws(
    () => validateClientConfig({ ...VALID_CONFIG, VITE_CDEK_FROM_CODE: '-1' }),
    /positive integer/
  );
});

test('requires the configured API URL to match the deploy target exactly', () => {
  assert.throws(
    () => validateClientConfig(VALID_CONFIG, { expectedApiUrl: 'https://other.example' }),
    /does not exactly match/
  );
});

test('passes only allowlisted VITE values to a managed build', () => {
  const sanitized = buildSanitizedEnvironment(
    {
      PATH: '/usr/bin',
      NODE_ENV: 'test',
      VITE_API_URL: 'https://inherited.example',
      VITE_ACCIDENTAL_SECRET: 'must-not-survive'
    },
    validateClientConfig(VALID_CONFIG)
  );
  assert.equal(sanitized.PATH, '/usr/bin');
  assert.equal(sanitized.VITE_API_URL, VALID_CONFIG.VITE_API_URL);
  assert.equal(sanitized.VITE_ACCIDENTAL_SECRET, undefined);
  assert.equal(sanitized.NODE_ENV, 'production');
  assert.equal(sanitized.CLIENT_CONFIG_MANAGED_BUILD, '1');
});

test('loads only the requested CLIENT_ENV_FILE through dotenv', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'her-client-config-'));
  const envPath = path.join(directory, 'client.env');
  try {
    writeFileSync(
      envPath,
      `${Object.entries(VALID_CONFIG)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n')}\nVITE_UNUSED_VALUE=ignored\n`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const loaded = loadClientConfig({
      environment: { CLIENT_ENV_FILE: envPath },
      repositoryRoot: path.resolve('.')
    });
    assert.deepEqual(loaded.config, VALID_CONFIG);
    assert.equal(loaded.envPath, envPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('errors never include configured public key values', () => {
  const value = 'sensitive-looking-public-value';
  let caught;
  try {
    validateClientConfig({ ...VALID_CONFIG, VITE_YANDEX_MAPS_API_KEY: value }, {
      expectedApiUrl: 'https://wrong.example'
    });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ClientConfigError);
  assert.doesNotMatch(caught.message, new RegExp(value));
});
