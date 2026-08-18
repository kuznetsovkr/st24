import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  checkHttpEndpoint,
  checkDns,
  classifyTlsExpiry,
  validateCatalogPayload,
  validateHealthPayload,
  validateNotificationsHealthPayload
} from './checks';
import type { DnsResolver } from './checks';
import type { HttpClient, HttpResponseData } from './types';
import { assertSafeRedirect, createHttpClient } from './http';
import { safeErrorDetail } from './http';

const fakeClient = (response: HttpResponseData): HttpClient => ({
  request: async () => response,
  close: async () => undefined
});

test('DNS succeeds with either address family and cancels work on timeout', async () => {
  const partialResolver: DnsResolver = {
    resolve4: async () => {
      throw Object.assign(new Error('no A records'), { code: 'ENODATA' });
    },
    resolve6: async () => ['2001:db8::1'],
    cancel: () => undefined
  };
  assert.equal((await checkDns('example.test', 100, partialResolver)).status, 'ok');

  let cancelledAfterSuccess = false;
  const halfStalledResolver: DnsResolver = {
    resolve4: async () => ['192.0.2.1'],
    resolve6: () => new Promise(() => undefined),
    cancel: () => {
      cancelledAfterSuccess = true;
    }
  };
  assert.equal((await checkDns('example.test', 100, halfStalledResolver)).status, 'ok');
  assert.equal(cancelledAfterSuccess, true);

  let cancelled = false;
  const stalledResolver: DnsResolver = {
    resolve4: () => new Promise(() => undefined),
    resolve6: () => new Promise(() => undefined),
    cancel: () => {
      cancelled = true;
    }
  };
  const timedOut = await checkDns('example.test', 5, stalledResolver);
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.detail, 'request timed out');
  assert.equal(cancelled, true);
});

test('TLS expiry is ok, warning or failed at configured thresholds', () => {
  const now = Date.parse('2026-08-08T00:00:00.000Z');
  assert.equal(
    classifyTlsExpiry('2026-11-08T00:00:00.000Z', 30, 7, now).status,
    'ok'
  );
  assert.equal(
    classifyTlsExpiry('2026-08-28T00:00:00.000Z', 30, 7, now).status,
    'warning'
  );
  assert.equal(
    classifyTlsExpiry('2026-08-10T00:00:00.000Z', 30, 7, now).status,
    'failed'
  );
});

test('HTTP check validates status, marker and JSON without exposing body', async () => {
  const result = await checkHttpEndpoint({
    id: 'catalog',
    label: 'Catalog',
    url: new URL('https://example.test/api/categories'),
    client: fakeClient({ statusCode: 200, body: '{"items":[],"secret":"do-not-print"}' }),
    maxResponseMs: 10_000,
    marker: '"items"',
    requireJson: true
  });

  assert.equal(result.status, 'ok');
  assert.doesNotMatch(result.detail, /do-not-print/);
});

test('HTTP check fails when a 2xx response is not JSON', async () => {
  const result = await checkHttpEndpoint({
    id: 'ready',
    label: 'Readiness',
    url: new URL('https://example.test/api/health/ready'),
    client: fakeClient({ statusCode: 200, body: '<html>proxy error</html>' }),
    maxResponseMs: 10_000,
    requireJson: true
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.detail, 'response is not valid JSON');
});

test('HTTP check reports status without copying response body', async () => {
  const result = await checkHttpEndpoint({
    id: 'homepage',
    label: 'Homepage',
    url: new URL('https://example.test'),
    client: fakeClient({ statusCode: 503, body: 'sensitive upstream diagnostic' }),
    maxResponseMs: 10_000
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.detail, 'HTTP 503');
  assert.doesNotMatch(result.detail, /sensitive/);
});

test('health validation rejects a syntactically valid false-green response', () => {
  const now = Date.parse('2026-08-08T00:00:00.000Z');
  const checkedAt = new Date(now).toISOString();
  assert.equal(validateHealthPayload({ status: 'error', checkedAt }, false, 60_000, now), 'health response status is not ok');
  assert.equal(
    validateHealthPayload(
      {
        status: 'ok',
        checkedAt,
        durationMs: 1,
        checks: {
          postgres: { status: 'error', latencyMs: 1 },
          uploads: { status: 'ok', latencyMs: 1 }
        }
      },
      true,
      60_000,
      now
    ),
    'PostgreSQL readiness check is not ok'
  );
  assert.equal(
    validateHealthPayload({ status: 'ok', checkedAt }, false, 60_000, now),
    'liveness response has no process check'
  );
  assert.equal(
    validateHealthPayload(
      { status: 'ok', checkedAt, checks: { process: { status: 'ok', latencyMs: 0 } } },
      false,
      60_000,
      now
    ),
    undefined
  );
  assert.equal(
    validateHealthPayload({ status: 'ok', checkedAt: '2026-08-07T23:00:00.000Z' }, false, 60_000, now),
    'health response checkedAt is outside the allowed window'
  );
  assert.equal(
    validateHealthPayload({ status: 'ok', checkedAt: 'not-a-date' }, false, 60_000, now),
    'health response has an invalid checkedAt'
  );
});

test('notification health validation enforces delivery invariants and runtime state', () => {
  const now = Date.parse('2026-08-08T00:00:00.000Z');
  const checkedAt = new Date(now).toISOString();
  const healthy = {
    status: 'ok',
    checkedAt,
    worker: { status: 'ok', lastSuccessAt: checkedAt },
    outbox: {
      pending: 2, retry: 1, dead: 0, acknowledgedDead: 1,
      oldestPendingAgeMs: 500
    },
    invariants: {
      paidWithoutOutbox: 0,
      overduePaidNotifications: 0,
      paymentStatusDrift: 0,
      stockReservationDrift: 0,
      notificationMarkerDrift: 0,
      failedLeadNotifications: 0,
      piiRetentionDrift: 0
    },
    bots: [
      {
        kind: 'main', mode: 'polling', outboundEnabled: true, activeTargets: 1,
        status: 'ok', botId: '101', username: 'main_bot', lastSuccessAt: checkedAt
      },
      {
        kind: 'orders', mode: 'webhook', outboundEnabled: true, activeTargets: 1,
        status: 'ok', botId: '102', username: 'orders_bot', lastSuccessAt: checkedAt
      },
      {
        kind: 'b2b', mode: 'disabled', outboundEnabled: false, activeTargets: 0,
        status: 'ok'
      }
    ]
  };

  assert.equal(validateNotificationsHealthPayload(healthy, 60_000, now), undefined);
  assert.equal(
    validateNotificationsHealthPayload(
      {
        ...healthy,
        outbox: { ...healthy.outbox, acknowledgedDead: 2 }
      },
      60_000,
      now
    ),
    undefined,
    'acknowledged dead letters are audit history, not active failures'
  );
  assert.match(
    validateNotificationsHealthPayload({ ...healthy, status: 'error' }, 60_000, now) ?? '',
    /status is not ok/
  );
  assert.match(
    validateNotificationsHealthPayload(
      { ...healthy, checkedAt: '2026-08-07T23:00:00.000Z' },
      60_000,
      now
    ) ?? '',
    /outside the allowed window/
  );
  assert.match(
    validateNotificationsHealthPayload(
      { ...healthy, worker: { ...healthy.worker, status: 'error' } },
      60_000,
      now
    ) ?? '',
    /worker is not ok/
  );
  assert.match(
    validateNotificationsHealthPayload(
      { ...healthy, outbox: { ...healthy.outbox, dead: 1 } },
      60_000,
      now
    ) ?? '',
    /dead messages/
  );

  for (const invariant of [
    'paidWithoutOutbox',
    'overduePaidNotifications',
    'paymentStatusDrift',
    'stockReservationDrift',
    'notificationMarkerDrift',
    'failedLeadNotifications',
    'piiRetentionDrift'
  ] as const) {
    const error = validateNotificationsHealthPayload(
      {
        ...healthy,
        invariants: { ...healthy.invariants, [invariant]: 1 }
      },
      60_000,
      now
    );
    assert.ok(error, `${invariant} must fail validation`);
  }

  assert.match(
    validateNotificationsHealthPayload(
      {
        ...healthy,
        invariants: { ...healthy.invariants, piiRetentionDrift: 1 }
      },
      60_000,
      now
    ) ?? '',
    /PII retention drift/
  );

  assert.match(
    validateNotificationsHealthPayload(
      {
        ...healthy,
        bots: healthy.bots.map((bot) =>
          bot.kind === 'orders' ? { ...bot, status: 'error' } : bot
        )
      },
      60_000,
      now
    ) ?? '',
    /runtime is not ok/
  );
  assert.match(
    validateNotificationsHealthPayload(
      { ...healthy, bots: healthy.bots.slice(0, 2) },
      60_000,
      now
    ) ?? '',
    /missing a bot state/
  );
});

test('catalog validation requires the expected schema and minimum data', () => {
  assert.equal(validateCatalogPayload({}, 1), 'catalog response has no items array');
  assert.equal(validateCatalogPayload({ items: [] }, 1), 'catalog contains fewer than 1 item(s)');
  assert.equal(validateCatalogPayload({ items: [{}] }, 1), 'catalog contains an invalid item');
  assert.equal(validateCatalogPayload({ items: [{ slug: 'parts', name: 'Parts' }] }, 1), undefined);
});

test('redirect validation only permits the same origin', () => {
  const current = new URL('https://example.test/start');
  assert.doesNotThrow(() => assertSafeRedirect(current, new URL('/next', current)));
  assert.throws(
    () => assertSafeRedirect(current, new URL('http://example.test/next')),
    /changed origin/
  );
  assert.throws(
    () => assertSafeRedirect(current, new URL('https://other.example.test/next')),
    /changed origin/
  );
});

test('unknown request errors cannot leak token-bearing URLs', () => {
  const error = new Error('fetch failed for https://api.telegram.org/botSECRET_TOKEN/getMe');
  assert.equal(safeErrorDetail(error), 'request failed');
  assert.doesNotMatch(safeErrorDetail(error), /SECRET_TOKEN/);
  assert.equal(
    safeErrorDetail(new Error('Another monitor process is already running')),
    'Another monitor process is already running'
  );
  assert.equal(
    safeErrorDetail(
      new Error('MONITOR_TELEGRAM_CANARY_CHAT_ID is required in summary mode')
    ),
    'MONITOR_TELEGRAM_CANARY_CHAT_ID is required in summary mode'
  );
  assert.equal(
    safeErrorDetail(new Error('Notifier returned an invalid delivery receipt')),
    'Notifier returned an invalid delivery receipt'
  );
});

test('proxy auth, abort and timeout diagnostics stay accurate and secret-free', () => {
  assert.equal(
    safeErrorDetail(new Error('Proxy response (407) !== 200 when HTTP Tunneling')),
    'proxy returned HTTP 407'
  );
  const aborted = Object.assign(new Error('request aborted for SECRET'), {
    name: 'AbortError',
    code: 'UND_ERR_ABORTED'
  });
  assert.equal(safeErrorDetail(aborted), 'request aborted');
  const timedOut = Object.assign(new Error('SECRET'), { name: 'TimeoutError' });
  assert.equal(safeErrorDetail(timedOut), 'request timed out');
});

test('HTTP client can refuse redirects for secret heartbeat URLs', async () => {
  let targetRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === '/start') {
      response.writeHead(302, { location: '/target' });
      response.end();
      return;
    }
    targetRequests += 1;
    response.end('ok');
  });
  await new Promise<void>((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const client = createHttpClient({ timeoutMs: 1_000, maxBodyBytes: 1_024 });
  try {
    const response = await client.request(
      new URL(`http://127.0.0.1:${address.port}/start`),
      { followRedirects: false }
    );
    assert.equal(response.statusCode, 302);
    assert.equal(targetRequests, 0);
  } finally {
    await client.close();
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise()))
    );
  }
});
