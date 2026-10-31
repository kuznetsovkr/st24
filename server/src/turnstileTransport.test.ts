import assert from 'node:assert/strict';
import test from 'node:test';
import tls from 'node:tls';
import { MockAgent } from 'undici';
import { createTurnstileTransport, TURNSTILE_CONNECT_OPTIONS, TURNSTILE_SITEVERIFY_URL } from './turnstileTransport';

test('Turnstile TLS policy retains certificate verification, TLS 1.3 and forward secrecy without changing globals', () => {
  const defaults = tls.DEFAULT_ECDH_CURVE;
  assert.equal(TURNSTILE_CONNECT_OPTIONS.rejectUnauthorized, true);
  assert.equal(TURNSTILE_CONNECT_OPTIONS.minVersion, 'TLSv1.2');
  assert.equal(TURNSTILE_CONNECT_OPTIONS.ecdhCurve, 'X25519:P-256');
  assert.ok(!('maxVersion' in TURNSTILE_CONNECT_OPTIONS));
  assert.doesNotThrow(() => tls.createSecureContext(TURNSTILE_CONNECT_OPTIONS));
  assert.equal(tls.DEFAULT_ECDH_CURVE, defaults);
  assert.ok(Object.isFrozen(TURNSTILE_CONNECT_OPTIONS));
});

test('Turnstile pools are lazy, isolated, reused and permanently fenced during shutdown', async () => {
  const created: string[] = [];
  const transport = createTurnstileTransport((kind) => {
    created.push(kind); const agent = new MockAgent(); agent.disableNetConnect(); return agent;
  });
  assert.deepEqual(created, []);
  const business = transport.dispatcher('business');
  assert.strictEqual(transport.dispatcher('business'), business);
  assert.notStrictEqual(transport.dispatcher('probe'), business);
  assert.deepEqual(created, ['business', 'probe']);
  const closing = transport.close(); assert.strictEqual(transport.close(), closing);
  assert.throws(() => transport.dispatcher('business'), /shutting down/);
  await assert.rejects(transport.probe({}), /shutting down/);
  await closing;
});

test('synthetic transport pins Siteverify and refuses redirects even when a caller asks to follow them', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const pool = agent.get(new URL(TURNSTILE_SITEVERIFY_URL).origin);
  pool.intercept({ path: '/turnstile/v0/siteverify', method: 'POST', body: '{}' })
    .reply(400, { success: false, 'error-codes': ['missing-input-secret'] });
  const transport = createTurnstileTransport(() => agent);
  try {
    const r = await transport.probe({ method: 'POST', body: '{}' });
    assert.equal(r.status, 400); assert.equal((await r.json()).success, false);
    pool.intercept({ path: '/turnstile/v0/siteverify', method: 'POST' })
      .reply(302, '', { headers: { Location: 'https://attacker.invalid/' } });
    await assert.rejects(transport.probe({ method: 'POST', redirect: 'follow' }));
    agent.assertNoPendingInterceptors();
  } finally { await transport.close(); }
});
