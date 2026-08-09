import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTelegramBot, checkTelegramProxy, sendTelegramNotification } from './telegram';
import type { HttpClient, HttpResponseData, TelegramBotConfig } from './types';

const bot: TelegramBotConfig = {
  id: 'telegram-main',
  label: 'Telegram main bot',
  token: 'secret-token',
  expectedUsername: 'expected_bot'
};

const fakeClient = (
  response: HttpResponseData,
  onRequest?: (url: URL) => void
): HttpClient => ({
  request: async (url) => {
    onRequest?.(url);
    return response;
  },
  close: async () => undefined
});

test('proxy probe treats a tokenless Telegram 4xx as end-to-end reachability', async () => {
  let requestedUrl = '';
  const reachable = await checkTelegramProxy(
    fakeClient({
      statusCode: 401,
      body: JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' })
    }, (url) => {
      requestedUrl = url.href;
    }),
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

test('getMe accepts a valid pinned bot identity', async () => {
  const result = await checkTelegramBot(
    bot,
    fakeClient({
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        result: { id: 123456, is_bot: true, username: 'Expected_Bot' }
      })
    }),
    10_000
  );

  assert.equal(result.status, 'ok');
  assert.match(result.detail, /@Expected_Bot/);
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

test('notifier only accepts Telegram ok:true', async () => {
  await assert.rejects(
    sendTelegramNotification(
      'notifier-token',
      '-100123',
      'test',
      fakeClient({ statusCode: 200, body: JSON.stringify({ ok: false }) })
    ),
    { message: 'Notifier rejected sendMessage' }
  );
});
