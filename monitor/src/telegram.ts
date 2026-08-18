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

interface TelegramWebhookInfoResponse {
  ok?: unknown;
  result?: {
    url?: unknown;
    pending_update_count?: unknown;
    last_error_date?: unknown;
    last_synchronization_error_date?: unknown;
  };
}

interface TelegramSendMessageResponse {
  ok?: unknown;
  result?: {
    message_id?: unknown;
    chat?: {
      id?: unknown;
    };
  };
}

interface TelegramBotIdentity {
  id: number;
  username: string;
}

const elapsedMs = (startedAt: number): number => Math.round(performance.now() - startedAt);

const parseTelegramBotIdentity = (payload: unknown): TelegramBotIdentity | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const root = payload as TelegramGetMeResponse;
  const botId = root.result?.id;
  const username = root.result?.username;
  if (
    root.ok !== true ||
    typeof botId !== 'number' ||
    !Number.isSafeInteger(botId) ||
    botId <= 0 ||
    root.result?.is_bot !== true ||
    typeof username !== 'string' ||
    !/^[A-Za-z0-9_]{5,32}$/.test(username)
  ) {
    return undefined;
  }
  return { id: botId, username };
};

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
  maxResponseMs: number,
  webhookErrorMaxAgeMs = 600_000,
  maxPendingUpdates = 100
): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    if (!bot.token) {
      return {
        id: bot.id,
        label: bot.label,
        status: bot.mode === 'disabled' ? 'ok' : 'failed',
        critical: true,
        detail:
          bot.mode === 'disabled'
            ? 'bot is disabled and has no outbound token'
            : 'production bot token is missing',
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    const endpoint = new URL(`https://api.telegram.org/bot${bot.token}/getMe`);
    const response = await client.request(endpoint, { followRedirects: false });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: `Bot API returned HTTP ${response.statusCode}`,
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      payload = undefined;
    }
    const identity = parseTelegramBotIdentity(payload);
    if (!identity) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an invalid bot identity',
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    const { username } = identity;
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
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    const webhookEndpoint = new URL(
      `https://api.telegram.org/bot${bot.token}/getWebhookInfo`
    );
    const webhookResponse = await client.request(webhookEndpoint, { followRedirects: false });
    if (webhookResponse.statusCode < 200 || webhookResponse.statusCode >= 300) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: `getWebhookInfo returned HTTP ${webhookResponse.statusCode}`,
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    let webhookPayload: TelegramWebhookInfoResponse;
    try {
      webhookPayload = JSON.parse(webhookResponse.body) as TelegramWebhookInfoResponse;
    } catch {
      webhookPayload = {};
    }
    const webhookUrl = webhookPayload.result?.url;
    const pendingUpdateCount = webhookPayload.result?.pending_update_count;
    if (
      webhookPayload.ok !== true ||
      typeof webhookUrl !== 'string' ||
      typeof pendingUpdateCount !== 'number' ||
      !Number.isSafeInteger(pendingUpdateCount) ||
      pendingUpdateCount < 0
    ) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned invalid webhook information',
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    if (bot.mode !== 'disabled' && pendingUpdateCount > maxPendingUpdates) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Telegram bot update backlog exceeds the configured threshold',
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    const lastErrorDate = webhookPayload.result?.last_error_date;
    if (bot.mode === 'webhook' && lastErrorDate !== undefined) {
      if (
        typeof lastErrorDate !== 'number' ||
        !Number.isSafeInteger(lastErrorDate) ||
        lastErrorDate <= 0
      ) {
        return {
          id: bot.id,
          label: bot.label,
          status: 'failed',
          critical: true,
          detail: 'Bot API returned invalid webhook information',
          latencyMs: elapsedMs(startedAt),
          checkedAt: new Date().toISOString()
        };
      }
      const lastErrorAtMs = lastErrorDate * 1_000;
      const freshErrorWindowMs = Math.max(webhookErrorMaxAgeMs, 600_000);
      const errorAgeMs = Date.now() - lastErrorAtMs;
      if (errorAgeMs >= 0 && errorAgeMs <= freshErrorWindowMs) {
        return {
          id: bot.id,
          label: bot.label,
          status: 'failed',
          critical: true,
          detail: 'Telegram reports a recent webhook delivery error',
          latencyMs: elapsedMs(startedAt),
          checkedAt: new Date().toISOString()
        };
      }
    }
    const lastSynchronizationErrorDate =
      webhookPayload.result?.last_synchronization_error_date;
    if (bot.mode !== 'disabled' && lastSynchronizationErrorDate !== undefined) {
      if (
        typeof lastSynchronizationErrorDate !== 'number' ||
        !Number.isSafeInteger(lastSynchronizationErrorDate) ||
        lastSynchronizationErrorDate <= 0
      ) {
        return {
          id: bot.id,
          label: bot.label,
          status: 'failed',
          critical: true,
          detail: 'Bot API returned invalid webhook information',
          latencyMs: elapsedMs(startedAt),
          checkedAt: new Date().toISOString()
        };
      }
      const ageMs = Date.now() - lastSynchronizationErrorDate * 1_000;
      if (ageMs >= 0 && ageMs <= webhookErrorMaxAgeMs) {
        return {
          id: bot.id,
          label: bot.label,
          status: 'failed',
          critical: true,
          detail: 'Telegram reports a recent update synchronization error',
          latencyMs: elapsedMs(startedAt),
          checkedAt: new Date().toISOString()
        };
      }
    }
    if ((bot.mode === 'polling' || bot.mode === 'disabled') && webhookUrl !== '') {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: `${bot.mode} bot unexpectedly has a webhook configured`,
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }
    if (
      bot.mode === 'webhook' &&
      (!bot.expectedWebhookUrl || webhookUrl !== bot.expectedWebhookUrl)
    ) {
      return {
        id: bot.id,
        label: bot.label,
        status: 'failed',
        critical: true,
        detail: 'Webhook bot has an unexpected webhook configuration',
        latencyMs: elapsedMs(startedAt),
        checkedAt: new Date().toISOString()
      };
    }

    const latencyMs = elapsedMs(startedAt);
    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return {
      id: bot.id,
      label: bot.label,
      status,
      critical: true,
      detail:
        status === 'warning'
          ? `getMe and getWebhookInfo succeeded for @${username}; ${bot.mode} contract is valid; response is slow`
          : `getMe and getWebhookInfo succeeded for @${username}; ${bot.mode} contract is valid`,
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

export const checkTelegramNotifier = async (
  token: string,
  expectedUsername: string | undefined,
  client: HttpClient,
  maxResponseMs: number
): Promise<CheckResult> => {
  const startedAt = performance.now();
  const id = 'telegram-notifier';
  const label = 'Telegram monitor notifier';
  try {
    const endpoint = new URL(`https://api.telegram.org/bot${token}/getMe`);
    const response = await client.request(endpoint, { followRedirects: false });
    const latencyMs = elapsedMs(startedAt);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        id,
        label,
        status: 'failed',
        critical: true,
        detail: `Bot API returned HTTP ${response.statusCode}`,
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      payload = undefined;
    }
    const identity = parseTelegramBotIdentity(payload);
    if (!identity) {
      return {
        id,
        label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an invalid notifier identity',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    if (
      expectedUsername &&
      identity.username.toLocaleLowerCase('en-US') !==
        expectedUsername.toLocaleLowerCase('en-US')
    ) {
      return {
        id,
        label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an unexpected notifier identity',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }

    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return {
      id,
      label,
      status,
      critical: true,
      detail:
        status === 'warning'
          ? `getMe succeeded for @${identity.username}; response is slow`
          : `getMe succeeded for @${identity.username}`,
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      id,
      label,
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt),
      checkedAt: new Date().toISOString()
    };
  }
};

export const checkTelegramCanary = async (
  bot: TelegramBotConfig,
  chatId: string,
  client: HttpClient,
  maxResponseMs: number
): Promise<CheckResult> => {
  const startedAt = performance.now();
  const checkId = `${bot.id}-canary`;
  const label = `${bot.label} send canary`;
  try {
    if (!bot.token) throw new Error('Configured bot has no outbound token');
    const endpoint = new URL(`https://api.telegram.org/bot${bot.token}/sendMessage`);
    const response = await client.request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `HER monitor canary | ${bot.id} | ${new Date().toISOString()}`,
        disable_notification: true
      }),
      followRedirects: false
    });
    const latencyMs = elapsedMs(startedAt);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return {
        id: checkId,
        label,
        status: 'failed',
        critical: true,
        detail: `sendMessage canary returned HTTP ${response.statusCode}`,
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    let payload: TelegramSendMessageResponse;
    try {
      payload = JSON.parse(response.body) as TelegramSendMessageResponse;
    } catch {
      payload = {};
    }
    const messageId = payload.result?.message_id;
    const returnedChatId = payload.result?.chat?.id;
    const returnedChatIdString =
      typeof returnedChatId === 'number' && Number.isSafeInteger(returnedChatId)
        ? String(returnedChatId)
        : typeof returnedChatId === 'string' &&
            /^(?:0|-?[1-9]\d*)$/.test(returnedChatId) &&
            Number.isSafeInteger(Number(returnedChatId))
          ? returnedChatId
          : undefined;
    if (
      payload.ok !== true ||
      typeof messageId !== 'number' ||
      !Number.isFinite(messageId) ||
      returnedChatIdString !== chatId
    ) {
      return {
        id: checkId,
        label,
        status: 'failed',
        critical: true,
        detail: 'Bot API returned an invalid canary delivery receipt',
        latencyMs,
        checkedAt: new Date().toISOString()
      };
    }
    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return {
      id: checkId,
      label,
      status,
      critical: true,
      detail:
        status === 'warning'
          ? 'sendMessage canary succeeded; response is slow'
          : 'sendMessage canary succeeded',
      latencyMs,
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      id: checkId,
      label,
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
      link_preview_options: { is_disabled: true }
    }),
    followRedirects: false
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Notifier returned HTTP ${response.statusCode}`);
  }
  let payload: TelegramSendMessageResponse;
  try {
    payload = JSON.parse(response.body) as TelegramSendMessageResponse;
  } catch {
    throw new Error('Notifier returned invalid JSON');
  }
  const messageId = payload.result?.message_id;
  const returnedChatId = payload.result?.chat?.id;
  const returnedChatIdString =
    typeof returnedChatId === 'number' && Number.isSafeInteger(returnedChatId)
      ? String(returnedChatId)
      : typeof returnedChatId === 'string' &&
          /^-?[1-9]\d*$/.test(returnedChatId) &&
          Number.isSafeInteger(Number(returnedChatId))
        ? returnedChatId
        : undefined;
  if (
    payload.ok !== true ||
    typeof messageId !== 'number' ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0 ||
    returnedChatIdString !== chatId
  ) {
    throw new Error('Notifier returned an invalid delivery receipt');
  }
};
