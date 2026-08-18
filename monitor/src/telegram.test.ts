import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkTelegramBot,
  checkTelegramCanary,
  checkTelegramNotifier,
  checkTelegramProxy,
  sendTelegramNotification
} from './telegram';
import type {
  HttpClient,
  HttpRequestOptions,
  HttpResponseData,
  TelegramBotConfig
} from './types';

const bot: TelegramBotConfig = {
  id: 'telegram-main',
  label: 'Telegram main bot',
  token: 'secret-token',
  expectedUsername: 'expected_bot',
  mode: 'polling'
};

const getMeResponse: HttpResponseData = {
  statusCode: 200,
  body: JSON.stringify({
    ok: true,
    result: { id: 123456, is_bot: true, username: 'Expected_Bot' }
  })
};

const webhookInfoResponse = (overrides: Record<string, unknown> = {}): HttpResponseData => ({
  statusCode: 200,
  body: JSON.stringify({
    ok: true,
    result: { url: '', pending_update_count: 0, ...overrides }
  })
});

const fakeClient = (
  responses: HttpResponseData | HttpResponseData[],
  onRequest?: (url: URL, options?: HttpRequestOptions) => void
): HttpClient => {
  const queue = Array.isArray(responses) ? responses : [responses];
  let index = 0;
  return {
    request: async (url, options) => {
      onRequest?.(url, options);
      const response = queue[index];
      index += 1;
      assert.ok(response, 'unexpected extra HTTP request');
      return response;
    },
    close: async () => undefined
  };
};

test('proxy probe treats a tokenless Telegram 4xx as end-to-end reachability', async () => {
  let requestedUrl = '';
  const reachable = await checkTelegramProxy(
    fakeClient(
      {
        statusCode: 401,
        body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })
      },
      (url) => {
        requestedUrl = url.href;
      }
    ),
    10_000
  );
  assert.equal(reachable.status, 'ok');
  assert.match(reachable.detail, /through proxy/);
  assert.doesNotMatch(requestedUrl, /secret-token|notifier-token/);

  const spoofed = await checkTelegramProxy(
    fakeClient({ statusCode: 401, body: '{}' }),
    10_000
  );
  assert.equal(spoofed.status, 'failed');
});

test('getMe and polling webhook contract accept a valid pinned bot identity', async () => {
  const requestedMethods: string[] = [];
  const result = await checkTelegramBot(
    bot,
    fakeClient([getMeResponse, webhookInfoResponse()], (url) => {
      requestedMethods.push(url.pathname.split('/').at(-1) ?? '');
    }),
    10_000
  );

  assert.equal(result.status, 'ok');
  assert.match(result.detail, /@Expected_Bot/);
  assert.match(result.detail, /polling contract is valid/);
  assert.deepEqual(requestedMethods, ['getMe', 'getWebhookInfo']);
  assert.doesNotMatch(result.detail, /secret-token/);
});

test('getMe rejects malformed and unexpected bot identities', async () => {
  const malformed = await checkTelegramBot(
    bot,
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({ ok: true, result: { id: 123456, is_bot: false } })
    }),
    10_000
  );
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.detail, 'Bot API returned an invalid bot identity');

  const unexpected = await checkTelegramBot(
    bot,
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        result: { id: 123456, is_bot: true, username: 'other_bot' }
      })
    }),
    10_000
  );
  assert.equal(unexpected.status, 'failed');
  assert.equal(unexpected.detail, 'Bot API returned an unexpected bot identity');
});

test('getWebhookInfo enforces polling and webhook mode contracts', async () => {
  const pollingWithWebhook = await checkTelegramBot(
    bot,
    fakeClient([
      getMeResponse,
      webhookInfoResponse({ url: 'https://shop.example.test/hook' })
    ]),
    10_000
  );
  assert.equal(pollingWithWebhook.status, 'failed');
  assert.match(pollingWithWebhook.detail, /unexpectedly has a webhook/);

  const webhookBot: TelegramBotConfig = {
    ...bot,
    mode: 'webhook',
    expectedWebhookUrl: 'https://shop.example.test/hook'
  };
  const webhook = await checkTelegramBot(
    webhookBot,
    fakeClient([
      getMeResponse,
      webhookInfoResponse({ url: 'https://shop.example.test/hook' })
    ]),
    10_000
  );
  assert.equal(webhook.status, 'ok');

  const wrongWebhook = await checkTelegramBot(
    webhookBot,
    fakeClient([
      getMeResponse,
      webhookInfoResponse({ url: 'https://shop.example.test/other' })
    ]),
    10_000
  );
  assert.equal(wrongWebhook.status, 'failed');
  assert.doesNotMatch(wrongWebhook.detail, /shop\.example|\/other/);
});

test('getWebhookInfo fails on pending updates or a reported Telegram error', async () => {
  const pending = await checkTelegramBot(
    bot,
    fakeClient([getMeResponse, webhookInfoResponse({ pending_update_count: 2 })]),
    10_000,
    600_000,
    1
  );
  assert.equal(pending.status, 'failed');
  assert.match(pending.detail, /backlog/);

  const webhookBot: TelegramBotConfig = {
    ...bot,
    mode: 'webhook',
    expectedWebhookUrl: 'https://shop.example.test/hook'
  };

  const lastError = await checkTelegramBot(
    webhookBot,
    fakeClient([
      getMeResponse,
      webhookInfoResponse({
        url: 'https://shop.example.test/hook',
        last_error_date: Math.floor(Date.now() / 1_000)
      })
    ]),
    10_000
  );
  assert.equal(lastError.status, 'failed');
  assert.match(lastError.detail, /delivery error/);

  const historicalError = await checkTelegramBot(
    webhookBot,
    fakeClient([
      getMeResponse,
      webhookInfoResponse({
        url: 'https://shop.example.test/hook',
        last_error_date: Math.floor(Date.now() / 1_000) - 86_400
      })
    ]),
    10_000
  );
  assert.equal(historicalError.status, 'ok');
});

test('disabled bot verifies identity and confirms that no webhook remains registered', async () => {
  let requests = 0;
  const disabled = await checkTelegramBot(
    { ...bot, mode: 'disabled' },
    fakeClient([getMeResponse, webhookInfoResponse()], () => {
      requests += 1;
    }),
    10_000
  );
  assert.equal(disabled.status, 'ok');
  assert.equal(requests, 2);
  assert.match(disabled.detail, /disabled contract is valid/);

  const staleWebhook = await checkTelegramBot(
    { ...bot, mode: 'disabled' },
    fakeClient([
      getMeResponse,
      webhookInfoResponse({ url: 'https://shop.example.test/old-hook' })
    ]),
    10_000
  );
  assert.equal(staleWebhook.status, 'failed');
});

test('notifier getMe validates and optionally pins a safe identity', async () => {
  let requestedUrl = '';
  const healthy = await checkTelegramNotifier(
    'notifier-secret-token',
    'expected_bot',
    fakeClient(getMeResponse, (url) => {
      requestedUrl = url.href;
    }),
    10_000
  );
  assert.equal(healthy.id, 'telegram-notifier');
  assert.equal(healthy.status, 'ok');
  assert.match(healthy.detail, /@Expected_Bot/);
  assert.doesNotMatch(healthy.detail, /notifier-secret-token/);
  assert.match(requestedUrl, /notifier-secret-token/);

  const unpinned = await checkTelegramNotifier(
    'notifier-secret-token',
    undefined,
    fakeClient(getMeResponse),
    10_000
  );
  assert.equal(unpinned.status, 'ok');

  const unexpected = await checkTelegramNotifier(
    'notifier-secret-token',
    'other_bot',
    fakeClient(getMeResponse),
    10_000
  );
  assert.equal(unexpected.status, 'failed');
  assert.equal(unexpected.detail, 'Bot API returned an unexpected notifier identity');
  assert.doesNotMatch(unexpected.detail, /Expected_Bot|other_bot|notifier-secret-token/);
});

test('notifier getMe rejects malformed identity without exposing response data', async () => {
  const malformed = await checkTelegramNotifier(
    'notifier-secret-token',
    undefined,
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        result: { id: 0, is_bot: false, username: 'sensitive_name' }
      })
    }),
    10_000
  );
  assert.equal(malformed.status, 'failed');
  assert.equal(malformed.detail, 'Bot API returned an invalid notifier identity');
  assert.doesNotMatch(malformed.detail, /sensitive_name|notifier-secret-token/);
});

test('sendMessage canary requires a receipt for the configured chat', async () => {
  let requestBody: Record<string, unknown> = {};
  let requestCount = 0;
  const delivered = await checkTelegramCanary(
    bot,
    '-100123',
    fakeClient(
      {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          result: { message_id: 42, chat: { id: -100123 } }
        })
      },
      (_url, options) => {
        requestCount += 1;
        requestBody = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      }
    ),
    10_000
  );
  assert.equal(delivered.status, 'ok');
  assert.equal(requestCount, 1);
  assert.equal(requestBody.chat_id, '-100123');
  assert.equal(requestBody.disable_notification, true);

  const stringChatReceipt = await checkTelegramCanary(
    bot,
    '-100123',
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        result: { message_id: 44, chat: { id: '-100123' } }
      })
    }),
    10_000
  );
  assert.equal(stringChatReceipt.status, 'ok');

  const wrongChat = await checkTelegramCanary(
    bot,
    '-100123',
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 43, chat: { id: -100999 } } })
    }),
    10_000
  );
  assert.equal(wrongChat.status, 'failed');
  assert.doesNotMatch(wrongChat.detail, /100123|100999|secret-token/);
});

test('notifier requires a complete receipt for the configured chat', async () => {
  await assert.rejects(
    sendTelegramNotification(
      'notifier-token',
      '-100123',
      'test',
      fakeClient({ statusCode: 200, body: JSON.stringify({ ok: false }) })
    ),
    { message: 'Notifier returned an invalid delivery receipt' }
  );
});
