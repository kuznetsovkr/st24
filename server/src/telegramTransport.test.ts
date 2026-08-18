import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpCircuitOpenError, HttpTimeoutError } from './httpClient';
import {
  TelegramDeliveryError,
  classifyTelegramTransportFailure,
  createTelegramRuntimeState,
  parseTelegramDeliveryResponse,
  reduceTelegramRuntimeState,
  resolveTelegramRuntimeConfig
} from './telegramTransport';

test('transport failures are normalized without exposing the original message', () => {
  const timeout = classifyTelegramTransportFailure('main', new HttpTimeoutError(5000));
  const circuit = classifyTelegramTransportFailure(
    'orders',
    new HttpCircuitOpenError('secret-circuit', 2200)
  );
  const network = classifyTelegramTransportFailure(
    'b2b',
    new Error('token and chat must never escape')
  );

  assert.equal(timeout.code, 'timeout');
  assert.equal(circuit.code, 'circuit_open');
  assert.equal(circuit.retryAfterSeconds, 3);
  assert.equal(network.code, 'network_error');
  assert.equal(network.message.includes('token'), false);
  assert.equal(network.message.includes('chat'), false);
});

test('parseTelegramDeliveryResponse accepts a complete Telegram success contract', () => {
  assert.deepEqual(
    parseTelegramDeliveryResponse({
      botKind: 'orders',
      httpStatus: 200,
      payload: {
        ok: true,
        result: { message_id: 42, chat: { id: -100123 } }
      }
    }),
    { botKind: 'orders', messageId: 42, chatId: '-100123' }
  );
});

test('parseTelegramDeliveryResponse rejects malformed HTTP 200 responses safely', () => {
  assert.throws(
    () =>
      parseTelegramDeliveryResponse({
        botKind: 'main',
        httpStatus: 200,
        payload: { ok: true, result: { message_id: 42 } }
      }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.kind, 'invalid_response');
      assert.equal(error.code, 'invalid_response');
      assert.equal(error.permanent, false);
      assert.equal(error.message.includes('42'), false);
      return true;
    }
  );
});

test('parseTelegramDeliveryResponse classifies permanent Telegram API failures', () => {
  assert.throws(
    () =>
      parseTelegramDeliveryResponse({
        botKind: 'b2b',
        httpStatus: 200,
        payload: { ok: false, error_code: 403, description: 'sensitive upstream text' }
      }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.kind, 'telegram_api');
      assert.equal(error.code, 403);
      assert.equal(error.permanent, true);
      assert.equal(error.message.includes('sensitive'), false);
      return true;
    }
  );
});

test('parseTelegramDeliveryResponse exposes retry_after only for rate limiting', () => {
  assert.throws(
    () =>
      parseTelegramDeliveryResponse({
        botKind: 'main',
        httpStatus: 429,
        retryAfterHeader: '3',
        payload: { ok: false, error_code: 429, parameters: { retry_after: 17 } }
      }),
    (error: unknown) => {
      assert.ok(error instanceof TelegramDeliveryError);
      assert.equal(error.code, 429);
      assert.equal(error.permanent, false);
      assert.equal(error.retryAfterSeconds, 17);
      return true;
    }
  );
});

test('resolveTelegramRuntimeConfig supports legacy polling and inferred webhook mode', () => {
  const result = resolveTelegramRuntimeConfig({
    TELEGRAM_BOT_TOKEN: 'main-token',
    TELEGRAM_POLLING: 'true',
    TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '1001',
    TELEGRAM_ORDERS_BOT_TOKEN: 'orders-token',
    TELEGRAM_ORDERS_WEBHOOK_SECRET: 'orders-secret',
    TELEGRAM_ORDERS_WEBHOOK_URL: 'https://example.test/api/telegram/orders-webhook',
    TELEGRAM_ORDERS_ALLOWED_CHAT_IDS: '1002'
  });

  assert.deepEqual(
    result.map(({ kind, mode }) => ({ kind, mode })),
    [
      { kind: 'main', mode: 'polling' },
      { kind: 'orders', mode: 'webhook' },
      { kind: 'b2b', mode: 'disabled' }
    ]
  );
});

test('resolveTelegramRuntimeConfig rejects conflicting legacy settings', () => {
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_BOT_TOKEN: 'main-token',
        TELEGRAM_MAIN_MODE: 'webhook',
        TELEGRAM_POLLING: 'true',
        TELEGRAM_WEBHOOK_SECRET: 'secret'
      }),
    /conflicts/
  );
});

test('resolveTelegramRuntimeConfig requires secrets and unique active tokens', () => {
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_BOT_TOKEN: 'same-token',
        TELEGRAM_MAIN_MODE: 'polling',
        TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '1001',
        TELEGRAM_ORDERS_BOT_TOKEN: 'same-token',
        TELEGRAM_ORDERS_MODE: 'polling',
        TELEGRAM_ORDERS_ALLOWED_CHAT_IDS: '1002'
      }),
    /unique/
  );
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_B2B_BOT_TOKEN: 'b2b-token',
        TELEGRAM_B2B_MODE: 'webhook',
        TELEGRAM_B2B_ALLOWED_CHAT_IDS: '1003'
      }),
    /TELEGRAM_B2B_WEBHOOK_SECRET/
  );
});

test('resolveTelegramRuntimeConfig requires an explicit recipient allowlist and strict mode boundaries', () => {
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_BOT_TOKEN: 'main-token',
        TELEGRAM_MAIN_MODE: 'polling'
      }),
    /TELEGRAM_MAIN_ALLOWED_CHAT_IDS/
  );
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_BOT_TOKEN: 'main-token',
        TELEGRAM_MAIN_MODE: 'disabled',
        TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '1001',
        TELEGRAM_WEBHOOK_SECRET: 'stale-secret'
      }),
    /only allowed in webhook mode/
  );
  assert.throws(
    () =>
      resolveTelegramRuntimeConfig({
        TELEGRAM_BOT_TOKEN: 'main-token',
        TELEGRAM_MAIN_MODE: 'polling',
        TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '01001'
      }),
    /canonical safe Telegram chat IDs/
  );

  for (const webhookUrl of [
    'https://example.test/api/health/live',
    'https://example.test/api/telegram/webhook/',
    'https://example.test/api/telegram/webhook?source=telegram'
  ]) {
    assert.throws(
      () =>
        resolveTelegramRuntimeConfig({
          TELEGRAM_BOT_TOKEN: 'main-token',
          TELEGRAM_MAIN_MODE: 'webhook',
          TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '1001',
          TELEGRAM_WEBHOOK_SECRET: 'secret',
          TELEGRAM_MAIN_WEBHOOK_URL: webhookUrl
        }),
      /TELEGRAM_MAIN_WEBHOOK_URL/
    );
  }

  assert.doesNotThrow(() =>
    resolveTelegramRuntimeConfig({
      TELEGRAM_BOT_TOKEN: 'main-token',
      TELEGRAM_MAIN_MODE: 'webhook',
      TELEGRAM_MAIN_ALLOWED_CHAT_IDS: '1001',
      TELEGRAM_WEBHOOK_SECRET: 'secret',
      TELEGRAM_MAIN_WEBHOOK_URL: 'https://example.test/api/telegram/webhook'
    })
  );
});

test('runtime reducer tracks attempts, recovery and safe error codes', () => {
  const initial = createTelegramRuntimeState({
    kind: 'main',
    mode: 'polling',
    tokenConfigured: true,
    webhookSecretConfigured: false,
    expectedWebhookUrl: null,
    allowedChatIds: ['1001']
  });
  const started = reduceTelegramRuntimeState(initial, { type: 'started' });
  const attempted = reduceTelegramRuntimeState(started, {
    type: 'attempt',
    at: '2026-08-09T00:00:00.000Z'
  });
  const failed = reduceTelegramRuntimeState(attempted, {
    type: 'failure',
    at: '2026-08-09T00:00:01.000Z',
    errorCode: 'telegram_api_429'
  });
  const recovered = reduceTelegramRuntimeState(failed, {
    type: 'success',
    at: '2026-08-09T00:00:02.000Z'
  });

  assert.equal(failed.running, true);
  assert.equal(failed.lastAttemptAt, '2026-08-09T00:00:00.000Z');
  assert.equal(failed.consecutiveFailures, 1);
  assert.equal(failed.lastErrorCode, 'telegram_api_429');
  assert.equal(recovered.lastSuccessAt, '2026-08-09T00:00:02.000Z');
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.lastErrorCode, null);
});
