import { performance } from 'node:perf_hooks';
import type { CheckResult, HttpClient, TelegramBotConfig } from './types';
import { safeErrorDetail } from './http';

interface TelegramGetMeResponse {
  ok?: boolean;
  result?: {
    id?: unknown;
    is_bot?: unknown;
    username?: unknown;
  };
}

const elapsedMs = (startedAt: number): number => Math.round(performance.now() - startedAt);

export const checkTelegramProxy = async (
  client: HttpClient,
  maxResponseMs: number
): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    const endpoint = new URL('https://api.telegram.org/bot0:monitor-proxy-probe/getMe');
    const response = await client.request(endpoint, { followRedirects: false });
    const latencyMs = elapsedMs(startedAt);
    let payload: { ok?: unknown; error_code?: unknown } = {};
    try {
      const parsed = JSON.parse(response.body) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as { ok?: unknown; error_code?: unknown };
      }
    } catch {
      // The expected invalid-token response is JSON; any other body is not Telegram's contract.
    }
    if (
      ![401, 404].includes(response.statusCode) ||
      payload.ok !== false ||
      payload.error_code !== response.statusCode
    ) {
      return {
        id: 'telegram-proxy',
        label: 'Telegram production proxy',
        status: 'failed',
        critical: true,
        detail: 'Telegram API returned an unexpected proxy probe response',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return {
      id: 'telegram-proxy',
      label: 'Telegram production proxy',
      status,
      critical: true,
      detail:
        status === 'warning'
          ? `Telegram API reached through proxy (HTTP ${response.statusCode}); response is slow`
          : `Telegram API reached through proxy (HTTP ${response.statusCode})`,
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      id: 'telegram-proxy',
      label: 'Telegram production proxy',
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt),
      checkedAt: new Date().toISOString()
    };
  }
};

export const checkTelegramBot = async (
  bot: TelegramBotConfig,
  client: HttpClient,
  maxResponseMs: number
): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    const endpoint = new URL(`https://api.telegram.org/bot${bot.token}/getMe`);
    const response = await client.request(endpoint);
    const latencyMs = elapsedMs(startedAt);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: `Bot API returned HTTP ${response.statusCode}`,
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    let payload: TelegramGetMeResponse;
    try {
      payload = JSON.parse(response.body) as TelegramGetMeResponse;
    } catch {
      payload = {};
    }
    const botId = payload.result?.id;
    const username = typeof payload.result?.username === 'string' ? payload.result.username : undefined;
    if (
      payload.ok !== true ||
      typeof botId !== 'number' ||
      !Number.isSafeInteger(botId) ||
      payload.result?.is_bot !== true ||
      !username
    ) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an invalid bot identity',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    if (
      bot.expectedUsername &&
      username.toLocaleLowerCase('en-US') !== bot.expectedUsername.toLocaleLowerCase('en-US')
    ) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an unexpected bot identity',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return {
      id: bot.id,
      label: bot.label,
      status,
      critical: true,
      detail:
        status === 'warning'
          ? `getMe succeeded${username ? ` for @${username}` : ''}; response is slow`
          : `getMe succeeded${username ? ` for @${username}` : ''}`,
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      id: bot.id,
      label: bot.label,
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt),
      checkedAt: new Date().toISOString()
    };
  }
};

export const sendTelegramNotification = async (
  token: string,
  chatId: string,
  text: string,
  client: HttpClient
): Promise<void> => {
  const endpoint = new URL(`https://api.telegram.org/bot${token}/sendMessage`);
  const response = await client.request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Notifier returned HTTP ${response.statusCode}`);
  }
  let payload: { ok?: unknown };
  try {
    payload = JSON.parse(response.body) as { ok?: unknown };
  } catch {
    throw new Error('Notifier returned invalid JSON');
  }
  if (payload.ok !== true) {
    throw new Error('Notifier rejected sendMessage');
  }
};
