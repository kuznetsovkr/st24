import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseTrustProxy,
  validateTrustProxyStartupConfig
} from './runtimeConfig';

test('parses only a complete positive integer as a hop count', () => {
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('2foo'), '2foo');
});

test('rejects blanket and hop-count proxy trust in production', () => {
  for (const value of ['true', '1', '2']) {
    assert.throws(
      () =>
        validateTrustProxyStartupConfig({
          NODE_ENV: 'production',
          TRUST_PROXY: value
        }),
      /explicit proxy IP addresses/
    );
  }
});

test('accepts disabled or explicit proxy networks in production', () => {
  assert.equal(
    validateTrustProxyStartupConfig({
      NODE_ENV: 'production',
      TRUST_PROXY: 'false'
    }),
    false
  );
  assert.equal(
    validateTrustProxyStartupConfig({
      NODE_ENV: 'production',
      TRUST_PROXY: '10.0.0.10, 2001:db8::/64'
    }),
    '10.0.0.10, 2001:db8::/64'
  );
});

test('rejects symbolic, invalid and trust-all networks in production', () => {
  for (const value of ['loopback', '10.0.0.0/99', '0.0.0.0/0', '::/0']) {
    assert.throws(
      () =>
        validateTrustProxyStartupConfig({
          NODE_ENV: 'production',
          TRUST_PROXY: value
        }),
      /explicit proxy IP addresses/
    );
  }
});
