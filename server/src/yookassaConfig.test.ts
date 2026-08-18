import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { validateYooKassaStartupConfig } from './yookassa';

const ENV_KEYS = [
  'NODE_ENV',
  'YOOKASSA_SHOP_ID',
  'YOOKASSA_SECRET_KEY',
  'YOOKASSA_API_BASE_URL',
  'YOOKASSA_RETURN_BASE_URL',
  'YOOKASSA_USE_ORDER_TOTAL'
] as const;
const originalEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  originalEnv.clear();
});

const configureProductionYooKassa = () => {
  process.env.NODE_ENV = 'production';
  process.env.YOOKASSA_SHOP_ID = 'shop';
  process.env.YOOKASSA_SECRET_KEY = 'secret';
  process.env.YOOKASSA_USE_ORDER_TOTAL = 'true';
};

test('requires YooKassa credentials as a pair', () => {
  process.env.YOOKASSA_SHOP_ID = 'shop';
  assert.throws(
    () => validateYooKassaStartupConfig(),
    /must be configured together/
  );
});

test('requires a canonical HTTPS return origin for production YooKassa', () => {
  configureProductionYooKassa();
  assert.throws(
    () => validateYooKassaStartupConfig(),
    /RETURN_BASE_URL is required/
  );

  for (const value of [
    'http://shop.example',
    'https://user:password@shop.example',
    'https://shop.example/checkout',
    'https://shop.example?source=test'
  ]) {
    process.env.YOOKASSA_RETURN_BASE_URL = value;
    assert.throws(
      () => validateYooKassaStartupConfig(),
      /valid HTTPS origin/
    );
  }
});

test('production credentials can only be sent to the official YooKassa API', () => {
  configureProductionYooKassa();
  process.env.YOOKASSA_RETURN_BASE_URL = 'https://shop.example';

  for (const value of [
    'http://api.yookassa.ru/v3',
    'https://api.yookassa.ru.evil.example/v3',
    'https://user:password@api.yookassa.ru/v3',
    'https://api.yookassa.ru/v2',
    'https://api.yookassa.ru/v3//',
    'https://api.yookassa.ru/v3?target=test'
  ]) {
    process.env.YOOKASSA_API_BASE_URL = value;
    assert.throws(
      () => validateYooKassaStartupConfig(),
      /official YooKassa production endpoint/
    );
  }

  process.env.YOOKASSA_API_BASE_URL = 'https://api.yookassa.ru/v3/';
  assert.doesNotThrow(() => validateYooKassaStartupConfig());
});

test('requires the real order total for production YooKassa', () => {
  configureProductionYooKassa();
  process.env.YOOKASSA_RETURN_BASE_URL = 'https://shop.example';
  process.env.YOOKASSA_USE_ORDER_TOTAL = 'false';
  assert.throws(
    () => validateYooKassaStartupConfig(),
    /USE_ORDER_TOTAL must be true/
  );
});

test('accepts a complete fail-closed production YooKassa configuration', () => {
  configureProductionYooKassa();
  process.env.YOOKASSA_RETURN_BASE_URL = 'https://shop.example/';
  assert.doesNotThrow(() => validateYooKassaStartupConfig());
});
