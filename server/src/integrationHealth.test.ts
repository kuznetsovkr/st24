import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from './app';
import { createFullIntegrationHealthChecker } from './integrationHealthRuntime';
import {
  createIntegrationHealthChecker, pingIntegrationRedis,
  type IntegrationDependencies, type IntegrationEnvironment, type IntegrationHealthReport
} from './integrationHealth';
import type { ReadinessReport } from './health';
import type { NotificationHealthReport } from './notificationHealth';

const ENV: IntegrationEnvironment = {
  NODE_ENV: 'production', YOOKASSA_SHOP_ID: '123', YOOKASSA_SECRET_KEY: 'fake-yoo-secret',
  SMS_RU_API_ID: 'fake-sms-secret', PHONE_VERIFICATION_MODE: 'sms_only',
  TELEGRAM_GATEWAY_TOKEN: 'fake-gateway-secret', CDEK_CLIENT_ID: 'fake-client', CDEK_CLIENT_SECRET: 'fake-cdek-secret',
  DELLIN_APP_KEY: 'fake-dellin-secret', RUSSIAN_POST_ACCESS_TOKEN: 'fake-post-token',
  RUSSIAN_POST_USER_KEY: 'fake-post-key', TURNSTILE_SECRET_KEY: 'fake-captcha-secret',
  RATE_LIMIT_REDIS_URL: 'redis://:fake-redis-secret@127.0.0.1:6379'
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' }
});
const responses = (url: string): Response => {
  if (url.endsWith('/v3/me')) return json({ account_id: '123', test: false, status: 'enabled', payment_methods: ['bank_card'], name: 'PRIVATE_NAME' });
  if (url.endsWith('/my/balance')) return json({ status: 'OK', status_code: 100, balance: 12345.67 });
  if (url.endsWith('/oauth/token')) return json({ access_token: 'fake-access-token', expires_in: 3600 });
  if (url.includes('/location/cities?')) return json([{ code: 44, city: 'Synthetic city' }]);
  if (url.endsWith('/v3/public/terminals.json')) return json({ hash: 'a'.repeat(64), url: 'http://api.dellin.ru/catalog/terminals.json?sk=SIGNED_SECRET' });
  if (url.endsWith('/1.0/user-shipping-points')) return json([{ address: 'PRIVATE_ADDRESS' }]);
  if (url.endsWith('/turnstile/v0/siteverify')) return json({ success: false, 'error-codes': ['missing-input-secret'] }, 400);
  throw new Error('Unexpected URL; tests must not reach a real provider');
};
const fixture = (overrides: Partial<IntegrationDependencies> = {}) => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let time = Date.parse('2026-10-25T06:00:00Z');
  let environment = { ...ENV };
  const check = createIntegrationHealthChecker({
    environment: () => environment, shippingModes: async () => ({ cdek: true, dellin: true, russian_post: true }),
    now: () => time, monotonicNow: () => time, redisPing: async () => 'PONG',
    fetch: async (url, init) => { calls.push({ url, init }); return responses(url); },
    ...overrides
  });
  return { check, calls, advance: (ms: number) => { time += ms; }, env: (next: IntegrationEnvironment) => { environment = next; } };
};

test('integration report distinguishes verified reads, disabled Gateway and unverified browser services', async () => {
  const f = fixture(); const report = await f.check();
  assert.equal(report.status, 'partial'); assert.equal(report.availability, 'ok');
  for (const id of ['yookassa', 'sms_ru', 'cdek', 'dellin', 'russian_post', 'redis']) assert.equal(report.checks[id].status, 'ok');
  assert.equal(report.checks.telegram_gateway.status, 'disabled');
  assert.deepEqual(report.coverage.unverified, ['turnstile', 'yandex_maps']);
  assert.equal(report.coverage.complete, false);
  const output = JSON.stringify(report);
  for (const privateValue of [...Object.values(ENV).filter((v) => v?.includes('fake-')), '12345.67', 'PRIVATE_NAME', 'PRIVATE_ADDRESS', 'SIGNED_SECRET']) {
    assert.ok(!output.includes(privateValue!), privateValue);
  }
});

test('transport only uses fixed read-only operations and never follows redirects or sends CAPTCHA secrets', async () => {
  const f = fixture(); await f.check();
  assert.equal(f.calls.length, 7);
  for (const { url, init } of f.calls) {
    assert.equal(init.redirect, 'error'); assert.ok(init.signal);
    assert.equal(new URL(url).protocol, 'https:');
    assert.ok(!/\/payments|\/refunds|\/orders|\/sms\/send|\/callcheck\/add|sendMessage|sendVerificationMessage/.test(url));
    assert.ok(!url.includes('fake-'));
  }
  const captcha = f.calls.find((call) => call.url.includes('cloudflare'))!;
  assert.equal(captcha.init.body, '{}');
  assert.equal(f.calls.filter((call) => call.url.includes('gateway')).length, 0);
  assert.ok(!f.calls.some((call) => call.url.includes('SIGNED_SECRET')));
});

test('HTTP failures including 401, 403, 429 and 500 are never healthy or exposed raw', async () => {
  for (const status of [401, 403, 429, 500]) {
    const f = fixture({ fetch: async () => json({ error: ENV.SMS_RU_API_ID }, status) });
    const report = await f.check(); assert.equal(report.availability, 'error');
    assert.equal(report.checks.sms_ru.status, 'error');
    assert.ok(!JSON.stringify(report).includes(ENV.SMS_RU_API_ID!));
  }
});

test('HTTP 200 with a provider rejection, malformed body, or blank JSON does not pass', async () => {
  for (const body of [{ status: 'ERROR', status_code: 200 }, { status: 'OK', status_code: 100, balance: '1000' }, null]) {
    const report = await fixture({ fetch: async (url) => url.includes('sms.ru') ? json(body) : responses(url) }).check();
    assert.equal(report.checks.sms_ru.status, 'error');
  }
  const report = await fixture({ fetch: async () => new Response('not json') }).check();
  assert.equal(report.checks.yookassa.code, 'invalid_response');
});

test('SMS warns only below ten rubles, while zero or negative balance fails without leaking the amount', async () => {
  for (const [balance, status, code] of [[0, 'error', 'balance_empty'], [-1, 'error', 'balance_empty'],
    [5.57, 'warning', 'balance_low'], [9.99, 'warning', 'balance_low'], [10, 'ok', 'balance_sufficient'],
    [25.57, 'ok', 'balance_sufficient'], [99.99, 'ok', 'balance_sufficient']] as const) {
    const report = await fixture({ fetch: async (url) => url.includes('sms.ru')
      ? json({ status: 'OK', status_code: 100, balance }) : responses(url) }).check();
    assert.equal(report.checks.sms_ru.status, status); assert.equal(report.checks.sms_ru.code, code);
    assert.ok(!JSON.stringify(report).includes('5.57'));
  }
});

test('SMS threshold remains configurable but zero balance always fails', async () => {
  for (const [threshold, balance, status] of [['50', 25, 'warning'], ['0', 0.01, 'ok'],
    ['0', 0, 'error'], ['100', 0, 'error'], ['invalid', 25, 'ok']] as const) {
    const report = await fixture({ environment: () => ({ ...ENV, INTEGRATION_HEALTH_SMS_MIN_BALANCE_RUB: threshold }),
      fetch: async (url) => url.includes('sms.ru') ? json({ status: 'OK', status_code: 100, balance }) : responses(url) }).check();
    assert.equal(report.checks.sms_ru.status, status);
  }
});

test('YooKassa validates identity, active status, real mode and enabled payment methods', async () => {
  for (const change of [{ account_id: 'different' }, { status: 'disabled' }, { payment_methods: [] }, { test: 'false' }]) {
    const report = await fixture({ fetch: async (url) => url.endsWith('/me')
      ? json({ account_id: '123', status: 'enabled', test: false, payment_methods: ['bank_card'], ...change }) : responses(url) }).check();
    assert.equal(report.checks.yookassa.status, 'error');
  }
  const report = await fixture({ fetch: async (url) => url.endsWith('/me')
    ? json({ account_id: '123', status: 'enabled', test: true, payment_methods: ['bank_card'] }) : responses(url) }).check();
  assert.equal(report.checks.yookassa.status, 'warning'); assert.equal(report.checks.yookassa.code, 'test_environment');
});

test('unsafe configured endpoints fail before credentials can leave for another host', async () => {
  for (const field of ['YOOKASSA_API_BASE_URL', 'CDEK_API_BASE_URL', 'DELLIN_API_BASE_URL', 'RUSSIAN_POST_API_BASE_URL']) {
    for (const base of ['https://attacker.invalid', 'http://api.yookassa.ru/v3', 'https://user:password@api.yookassa.ru/v3']) {
      const f = fixture({ environment: () => ({ ...ENV, [field]: base }) });
      const report = await f.check(); assert.equal(report.availability, 'error');
      assert.ok(!f.calls.some((call) => call.url.includes('attacker') || call.url.startsWith('http:') || call.url.includes('password@')));
    }
  }
});

test('disabled shipping providers do not use stale credentials or make requests', async () => {
  const f = fixture({ shippingModes: async () => ({ cdek: false, dellin: false, russian_post: false }) });
  const report = await f.check();
  for (const id of ['cdek', 'dellin', 'russian_post']) assert.equal(report.checks[id].status, 'disabled');
  assert.ok(!f.calls.some((call) => /cdek|dellin|pochta/.test(call.url)));
});

test('missing shipping flags and enabled providers with missing credentials fail closed', async () => {
  const report = await fixture({ shippingModes: async () => { throw new Error('PRIVATE_DB_ERROR'); } }).check();
  for (const id of ['cdek', 'dellin', 'russian_post']) assert.equal(report.checks[id].code, 'shipping_state_unavailable');
  const missing = await fixture({ environment: () => ({ NODE_ENV: 'production', RATE_LIMIT_REDIS_ENABLED: 'false' }) }).check();
  for (const id of ['cdek', 'dellin', 'russian_post']) assert.equal(missing.checks[id].status, 'error');
  assert.equal(missing.checks.sms_ru.status, 'error');
  assert.equal(missing.checks.turnstile.status, 'error');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_DB_ERROR'));
});

test('malformed CDEK directory, Russian Post body and Dellin signed URL do not pass', async () => {
  for (const [match, body, id] of [['/location/cities', [], 'cdek'], ['user-shipping-points', {}, 'russian_post'],
    ['terminals.json', { hash: 'a'.repeat(64), url: 'https://attacker.invalid/catalog' }, 'dellin']] as const) {
    const report = await fixture({ fetch: async (url) => url.includes(match) ? json(body) : responses(url) }).check();
    assert.equal(report.checks[id].status, 'error');
  }
});

test('cache coalesces concurrent calls, preserves actual timestamps and expires before a five minute schedule', async () => {
  let modesCalls = 0;
  const f = fixture({ shippingModes: async () => { modesCalls++; return { cdek: true, dellin: true, russian_post: true }; } });
  const [a, b, c] = await Promise.all([f.check(), f.check(), f.check()]);
  assert.strictEqual(a, b); assert.strictEqual(b, c); assert.equal(modesCalls, 1);
  assert.equal(f.calls.length, 7);
  f.advance(120_000); assert.strictEqual(await f.check(), a); assert.equal(f.calls.length, 7);
  f.advance(121_000); const next = await f.check();
  assert.notEqual(next.checkedAt, a.checkedAt); assert.equal(modesCalls, 2);
  assert.equal(f.calls.length, 13); // Cached CDEK access token is not requested again.
});

test('changed environment invalidates cached health', async () => {
  const f = fixture(); const firstReport = await f.check();
  f.env({ ...ENV, SMS_RU_API_ID: undefined });
  const report = await f.check(); assert.notStrictEqual(report, firstReport);
  assert.equal(report.checks.sms_ru.status, 'error');
});

test('CDEK authentication failure invalidates its cached token and next sample reauthorizes', async () => {
  let rejectCities = false;
  let tokenCalls = 0;
  const f = fixture({ fetch: async (url) => {
    if (url.endsWith('/oauth/token')) tokenCalls++;
    if (rejectCities && url.includes('/location/cities?')) return json({}, 401);
    return responses(url);
  } });
  await f.check(); assert.equal(tokenCalls, 1);
  rejectCities = true; f.advance(241_000);
  assert.equal((await f.check()).checks.cdek.code, 'authentication_failed');
  assert.equal(tokenCalls, 1);
  rejectCities = false; f.advance(241_000);
  assert.equal((await f.check()).checks.cdek.status, 'ok');
  assert.equal(tokenCalls, 2);
});

test('environment changed during an in-flight probe cannot reuse the previous credentials report', async () => {
  const f = fixture();
  const before = f.check();
  f.env({ ...ENV, SMS_RU_API_ID: undefined });
  const after = f.check();
  assert.equal((await before).checks.sms_ru.status, 'ok');
  assert.equal((await after).checks.sms_ru.code, 'not_configured');
});

test('optional unconfigured Redis uses memory fallback, required Redis fails closed', async () => {
  const environment = { ...ENV, RATE_LIMIT_REDIS_URL: undefined };
  const optional = await fixture({ environment: () => environment }).check();
  assert.equal(optional.checks.redis.status, 'disabled');
  assert.equal(optional.checks.redis.code, 'optional_memory_fallback');
  const required = await fixture({ environment: () => ({ ...environment, RATE_LIMIT_REDIS_REQUIRED: 'true' }) }).check();
  assert.equal(required.checks.redis.status, 'error');
});

test('Dellin rejects unexpected nonempty errors even when directory metadata looks valid', async () => {
  const report = await fixture({ fetch: async (url) => url.includes('terminals.json')
    ? json({ hash: 'a'.repeat(64), url: 'https://api.dellin.ru/catalog', errors: 'authentication failed' }) : responses(url) }).check();
  assert.equal(report.checks.dellin.status, 'error');
});

test('timeout aborts provider requests, returns safe errors and does not leak rejection text', async () => {
  const report = await fixture({ timeoutMs: 20, fetch: async (_url, init) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(new Error('PRIVATE_NETWORK_URL')), { once: true });
  }) }).check();
  assert.equal(report.checks.yookassa.code, 'timeout'); assert.equal(report.availability, 'error');
  assert.ok(!JSON.stringify(report).includes('PRIVATE_NETWORK_URL'));
});

test('oversized response is stopped and cannot become healthy', async () => {
  const report = await fixture({ fetch: async (url) => url.endsWith('/me') ? json({ value: 'x'.repeat(200_000) }) : responses(url) }).check();
  assert.equal(report.checks.yookassa.code, 'response_too_large');
});

test('active Gateway without a safe positive probe remains explicitly unverified', async () => {
  const report = await fixture({ environment: () => ({ ...ENV, PHONE_VERIFICATION_MODE: 'telegram_then_sms' }) }).check();
  assert.equal(report.checks.telegram_gateway.status, 'unverified');
});

test('Redis rejects non-Redis connection schemes without connecting', async () => {
  await assert.rejects(pingIntegrationRedis('https://attacker.invalid', new AbortController().signal), /invalid_configuration/);
  const report = await fixture({ redisPing: async () => { throw new Error(ENV.RATE_LIMIT_REDIS_URL); } }).check();
  assert.equal(report.checks.redis.status, 'error');
  assert.ok(!JSON.stringify(report).includes('fake-redis-secret'));
});

const READY: ReadinessReport = { status: 'ok', checkedAt: '2026-10-25T06:00:00Z', durationMs: 1,
  checks: { postgres: { status: 'ok', latencyMs: 1 }, uploads: { status: 'ok', latencyMs: 1 } } };
const NOTIFICATIONS = { status: 'ok', checkedAt: '2026-10-25T06:00:00Z' } as NotificationHealthReport;

test('unified report includes existing DB/uploads/Telegram health without exposing raw dependency reports', async () => {
  const provider = await fixture().check();
  const collect = createFullIntegrationHealthChecker({ providers: async () => provider,
    readiness: async () => READY, notifications: async () => NOTIFICATIONS });
  const report = await collect(); assert.equal(report.availability, 'ok');
  for (const id of ['postgres', 'uploads', 'telegram']) assert.equal(report.checks[id].status, 'ok');
  const failure = await createFullIntegrationHealthChecker({ providers: async () => provider,
    readiness: async () => { throw new Error('PRIVATE_DB_SECRET'); }, notifications: async () => ({ ...NOTIFICATIONS, status: 'error' }) })();
  assert.equal(failure.availability, 'error'); assert.equal(failure.checks.telegram.status, 'error');
  assert.ok(!JSON.stringify(failure).includes('PRIVATE_DB_SECRET'));
});

test('core health timeout is bounded independently of slow business queries', async () => {
  const provider = await fixture().check();
  const report = await createFullIntegrationHealthChecker({ providers: async () => provider,
    readiness: () => new Promise(() => undefined), notifications: async () => NOTIFICATIONS, coreTimeoutMs: 10 })();
  assert.equal(report.checks.postgres.status, 'error'); assert.equal(report.checks.telegram.status, 'ok');
});

test('public integration route is no-store, failure-aware and separate from readiness', async () => {
  let report: IntegrationHealthReport = await fixture().check();
  let reject = false;
  const server = createApp({ integrationHealthCheck: async () => {
    if (reject) throw new Error('PRIVATE_PROVIDER_SECRET');
    return report;
  }, readinessCheck: async () => READY }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) => new Promise<{ status: number; cache: string | undefined; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (response) => {
      let body = ''; response.setEncoding('utf8'); response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode!, cache: response.headers['cache-control'], body }));
    }).on('error', reject);
  });
  try {
    const first = await get('/api/health/integrations'); assert.equal(first.status, 200); assert.equal(first.cache, 'no-store');
    report = { ...report, availability: 'warning', status: 'warning' };
    assert.equal((await get('/api/health/integrations')).status, 200);
    report = { ...report, availability: 'error', status: 'error' };
    assert.equal((await get('/api/health/integrations')).status, 503);
    assert.equal((await get('/api/health/ready')).status, 200);
    reject = true;
    const failed = await get('/api/health/integrations');
    assert.equal(failed.status, 503); assert.equal(failed.cache, 'no-store');
    assert.ok(!failed.body.includes('PRIVATE_PROVIDER_SECRET'));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
