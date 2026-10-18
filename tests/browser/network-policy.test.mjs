import assert from 'node:assert/strict';
import test from 'node:test';
import {requestTarget} from './network-policy.mjs';
import {apiOrigin, browserOrigin, clientConfig} from './settings.mjs';

test('only the fixed loopback preview may receive static network traffic', () => {
  for (const path of ['/', '/catalog', '/assets/index-test.js']) {
    assert.equal(requestTarget(browserOrigin + path, 'GET'), 'local-static');
  }
  for (const address of ['https://shop.example.com/', 'http://127.0.0.1:4000/', 'http://localhost:4178/', 'http://127.0.0.1:4178.evil.invalid/', 'not a URL']) {
    assert.equal(requestTarget(address, 'GET'), 'blocked');
  }
});

test('synthetic API is mocked, while live or local API origins are blocked', () => {
  assert.equal(clientConfig.VITE_API_URL, apiOrigin);
  assert.equal(requestTarget(apiOrigin + '/api/products', 'GET'), 'mock-api');
  assert.equal(requestTarget(apiOrigin + '/api/products', 'OPTIONS'), 'mock-api');
  for (const address of [browserOrigin + '/api/orders', 'https://api.example.com/api/products', 'https://api.browser.test.evil.invalid/api/products', apiOrigin + '/assets/index.js']) {
    assert.equal(requestTarget(address, 'GET'), 'blocked');
  }
});

test('mutations and embedded credentials are blocked even on approved origins', () => {
  for (const origin of [apiOrigin, browserOrigin]) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'TRACE']) {
      assert.equal(requestTarget(origin + '/api/orders', method), 'blocked');
      assert.equal(requestTarget(origin + '/catalog', method), 'blocked');
    }
    const address = new URL(origin + '/api/products');
    address.username = 'synthetic-user';
    address.password = 'synthetic-password';
    assert.equal(requestTarget(address.href, 'GET'), 'blocked');
  }
});

test('known font/widget assets are mocked; no font binaries or other providers are allowed', () => {
  assert.equal(requestTarget('https://fonts.googleapis.com/css2?family=Inter', 'GET'), 'mock-font');
  assert.equal(requestTarget('https://cdn.jsdelivr.net/npm/@cdek-it/widget@3', 'GET'), 'mock-widget');
  for (const address of ['https://cdn.jsdelivr.net/npm/@cdek-it/widget@4', 'https://fonts.gstatic.com/font.woff2', 'https://api.telegram.org/getMe', 'https://payments.example.invalid/charge']) {
    assert.equal(requestTarget(address, 'GET'), 'blocked');
  }
});
