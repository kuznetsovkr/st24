import assert from 'node:assert/strict';
import test from 'node:test';
import { MockAgent } from 'undici';
import { createTurnstileVerifier } from './turnstile';
import { TURNSTILE_SITEVERIFY_URL } from './turnstileTransport';

test('business verification uses the pinned TLS pool, fail-closed validation and an idempotency key for retries', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  let calls = 0;
  const verify = createTurnstileVerifier({
    environment: () => ({ TURNSTILE_SECRET_KEY: 'fake-secret' }), dispatcher: () => agent,
    request: async (url, init, options) => {
      calls++; assert.equal(url, TURNSTILE_SITEVERIFY_URL); assert.equal(init.dispatcher, agent);
      assert.equal(init.redirect, 'error'); assert.equal(options.maxRetries, 2); assert.equal(options.timeoutMs, 8_000);
      assert.equal(options.circuitKey, 'turnstile:siteverify');
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('secret'), 'fake-secret'); assert.equal(body.get('response'), 'fake-user-token');
      assert.match(body.get('idempotency_key')!, /^[0-9a-f-]{36}$/);
      return new Response(JSON.stringify({ success: true, action: 'request_phone_code' }));
    }
  });
  try {
    await assert.rejects(verify('  '), /Подтвердите/); assert.equal(calls, 0);
    await verify(' fake-user-token ', undefined, 'request_phone_code'); assert.equal(calls, 1);
  } finally { await agent.close(); }
});

test('business verification rejects provider failures and mismatched actions without logging tokens or raw bodies', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  try {
    for (const body of [{ success: false, secret: 'PRIVATE_PROVIDER_BODY' }, { success: 'true' },
      { success: true, action: 'PRIVATE_WRONG_ACTION' }, null, 'invalid-json']) {
      const logs: unknown[] = [];
      const verify = createTurnstileVerifier({ environment: () => ({ TURNSTILE_SECRET_KEY: 'PRIVATE_SECRET' }),
        dispatcher: () => agent, log: (...args) => { logs.push(args); },
        request: async () => new Response(body === 'invalid-json' ? body : JSON.stringify(body)) });
      await assert.rejects(verify('PRIVATE_USER_TOKEN', undefined, 'request_phone_code'), /Не удалось подтвердить/);
      assert.equal(logs.length, 1); assert.ok(!JSON.stringify(logs).includes('PRIVATE_'));
    }
    const logs: unknown[] = [];
    const verify = createTurnstileVerifier({ environment: () => ({ TURNSTILE_SECRET_KEY: 'PRIVATE_SECRET' }),
      dispatcher: () => agent, log: (...args) => { logs.push(args); },
      request: async () => { throw new Error('PRIVATE_URL_WITH_SECRET'); } });
    await assert.rejects(verify('PRIVATE_TOKEN'), (error: unknown) => error instanceof Error && !error.message.includes('PRIVATE_'));
    assert.deepEqual(logs, [['request_failed']]);
  } finally { await agent.close(); }
});
