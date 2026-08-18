import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MonitorConfig, MonitorMode, TelegramBotMode } from './types';

type Environment = Record<string, string | undefined>;

const trimToUndefined = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const required = (env: Environment, name: string): string => {
  const value = trimToUndefined(env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

const parseInteger = (
  env: Environment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number
): number => {
  const raw = trimToUndefined(env[name]);
  if (!raw) {
    return defaultValue;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const parseBoolean = (env: Environment, name: string, defaultValue: boolean): boolean => {
  const raw = trimToUndefined(env[name]);
  if (!raw) {
    return defaultValue;
  }
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`${name} must be true or false`);
  }
  return raw === 'true';
};

const parseHttpUrl = (raw: string, name: string, base?: URL): URL => {
  let value: URL;
  try {
    value = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (value.protocol !== 'http:' && value.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  if (value.username || value.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  return value;
};

export const parseProxyUrl = (raw: string, name: string): string => {
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid proxy URL`);
  }
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(value.protocol)) {
    throw new Error(`${name} must use http, https, socks or socks5`);
  }
  return value.toString();
};

const optionalProxy = (env: Environment, name: string): string | undefined => {
  const raw = trimToUndefined(env[name]);
  return raw ? parseProxyUrl(raw, name) : undefined;
};

const optionalBotUsername = (env: Environment, name: string): string | undefined => {
  const raw = trimToUndefined(env[name]);
  if (!raw) {
    return undefined;
  }
  const username = raw.startsWith('@') ? raw.slice(1) : raw;
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) {
    throw new Error(`${name} must be a valid Telegram username`);
  }
  return username;
};

const parseBotMode = (env: Environment, name: string): TelegramBotMode => {
  const mode = required(env, name);
  if (mode !== 'polling' && mode !== 'webhook' && mode !== 'disabled') {
    throw new Error(`${name} must be polling, webhook or disabled`);
  }
  return mode;
};

const expectedWebhookUrl = (
  env: Environment,
  mode: TelegramBotMode,
  name: string
): string | undefined => {
  const raw = trimToUndefined(env[name]);
  if (mode !== 'webhook') {
    if (raw) {
      throw new Error(`${name} must be empty unless the bot mode is webhook`);
    }
    return undefined;
  }
  const value = parseHttpUrl(required(env, name), name);
  if (value.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
  return value.href;
};

const parseTelegramChatId = (
  env: Environment,
  name: string,
  requiredValue = true
): string | undefined => {
  const value = trimToUndefined(env[name]);
  if (!value) {
    if (requiredValue) throw new Error(`Missing required environment variable: ${name}`);
    return undefined;
  }
  if (!/^-?[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a canonical safe integer`);
  }
  return value;
};

export const parseConfig = (env: Environment, cwd = process.cwd()): MonitorConfig => {
  const siteUrl = parseHttpUrl(required(env, 'MONITOR_SITE_URL'), 'MONITOR_SITE_URL');
  const dnsHost = trimToUndefined(env.MONITOR_DNS_HOST) ?? siteUrl.hostname;
  const tlsHost = trimToUndefined(env.MONITOR_TLS_HOST) ?? siteUrl.hostname;
  const tlsPortDefault = siteUrl.protocol === 'https:' && siteUrl.port ? Number(siteUrl.port) : 443;
  const telegramProxyUrl = parseProxyUrl(
    required(env, 'TELEGRAM_OUTBOUND_PROXY_URL'),
    'TELEGRAM_OUTBOUND_PROXY_URL'
  );

  if (/[/\\\s]/.test(dnsHost) || /[/\\\s]/.test(tlsHost)) {
    throw new Error('MONITOR_DNS_HOST and MONITOR_TLS_HOST must be hostnames');
  }

  const tlsWarnDays = parseInteger(env, 'MONITOR_TLS_WARN_DAYS', 30, 1, 3650);
  const tlsCriticalDays = parseInteger(env, 'MONITOR_TLS_CRITICAL_DAYS', 7, 0, 3650);
  if (tlsCriticalDays >= tlsWarnDays) {
    throw new Error('MONITOR_TLS_CRITICAL_DAYS must be less than MONITOR_TLS_WARN_DAYS');
  }

  const mainBotMode = parseBotMode(env, 'MONITOR_TELEGRAM_MAIN_MODE');
  const ordersBotMode = parseBotMode(env, 'MONITOR_TELEGRAM_ORDERS_MODE');
  const b2bBotMode = parseBotMode(env, 'MONITOR_TELEGRAM_B2B_MODE');
  const parseProductionToken = (name: string, mode: TelegramBotMode) => {
    const token = trimToUndefined(env[name]);
    if (!token && mode !== 'disabled') {
      throw new Error(`Missing required environment variable: ${name}`);
    }
    return token;
  };
  const mainBotToken = parseProductionToken('TELEGRAM_BOT_TOKEN', mainBotMode);
  const ordersBotToken = parseProductionToken('TELEGRAM_ORDERS_BOT_TOKEN', ordersBotMode);
  const b2bBotToken = parseProductionToken('TELEGRAM_B2B_BOT_TOKEN', b2bBotMode);
  const notifierToken = required(env, 'MONITOR_TELEGRAM_BOT_TOKEN');
  const productionTokens = [mainBotToken, ordersBotToken, b2bBotToken].filter(
    (token): token is string => Boolean(token)
  );
  if (new Set(productionTokens).size !== productionTokens.length) {
    throw new Error('Production Telegram bot tokens must be unique');
  }
  if (productionTokens.includes(notifierToken)) {
    throw new Error('MONITOR_TELEGRAM_BOT_TOKEN must not match a production bot token');
  }
  const mainBotUsername = optionalBotUsername(env, 'MONITOR_TELEGRAM_MAIN_USERNAME');
  const ordersBotUsername = optionalBotUsername(env, 'MONITOR_TELEGRAM_ORDERS_USERNAME');
  const b2bBotUsername = optionalBotUsername(env, 'MONITOR_TELEGRAM_B2B_USERNAME');
  if (mainBotToken && !mainBotUsername) {
    throw new Error('MONITOR_TELEGRAM_MAIN_USERNAME is required for a configured bot');
  }
  if (ordersBotToken && !ordersBotUsername) {
    throw new Error('MONITOR_TELEGRAM_ORDERS_USERNAME is required for a configured bot');
  }
  if (b2bBotToken && !b2bBotUsername) {
    throw new Error('MONITOR_TELEGRAM_B2B_USERNAME is required for a configured bot');
  }

  const heartbeatRaw = trimToUndefined(env.MONITOR_HEARTBEAT_URL);
  const allowNoHeartbeat = parseBoolean(env, 'MONITOR_ALLOW_NO_HEARTBEAT', false);
  if (!heartbeatRaw && !allowNoHeartbeat) {
    throw new Error('Missing required environment variable: MONITOR_HEARTBEAT_URL');
  }
  const heartbeatUrl = heartbeatRaw
    ? parseHttpUrl(heartbeatRaw, 'MONITOR_HEARTBEAT_URL')
    : undefined;
  if (heartbeatUrl && heartbeatUrl.protocol !== 'https:') {
    throw new Error('MONITOR_HEARTBEAT_URL must use https');
  }
  const notifierProxyUrl = optionalProxy(env, 'MONITOR_TELEGRAM_PROXY_URL');
  if (notifierProxyUrl === telegramProxyUrl) {
    throw new Error('MONITOR_TELEGRAM_PROXY_URL must differ from TELEGRAM_OUTBOUND_PROXY_URL');
  }
  const notifierUsername = optionalBotUsername(env, 'MONITOR_TELEGRAM_BOT_USERNAME');

  return {
    siteUrl,
    dnsHost,
    tlsHost,
    tlsPort: parseInteger(env, 'MONITOR_TLS_PORT', tlsPortDefault, 1, 65535),
    liveUrl: parseHttpUrl(
      trimToUndefined(env.MONITOR_LIVE_URL) ?? '/api/health/live',
      'MONITOR_LIVE_URL',
      siteUrl
    ),
    readyUrl: parseHttpUrl(
      trimToUndefined(env.MONITOR_READY_URL) ?? '/api/health/ready',
      'MONITOR_READY_URL',
      siteUrl
    ),
    notificationsUrl: parseHttpUrl(
      trimToUndefined(env.MONITOR_NOTIFICATIONS_URL) ?? '/api/health/notifications',
      'MONITOR_NOTIFICATIONS_URL',
      siteUrl
    ),
    catalogUrl: parseHttpUrl(
      trimToUndefined(env.MONITOR_CATALOG_URL) ?? '/api/categories',
      'MONITOR_CATALOG_URL',
      siteUrl
    ),
    catalogMinItems: parseInteger(env, 'MONITOR_CATALOG_MIN_ITEMS', 1, 0, 1_000_000),
    homepageMarker: required(env, 'MONITOR_HOMEPAGE_MARKER'),
    catalogMarker: trimToUndefined(env.MONITOR_CATALOG_MARKER),
    healthMaxAgeMs: parseInteger(env, 'MONITOR_HEALTH_MAX_AGE_MS', 60_000, 1_000, 3_600_000),
    timeoutMs: parseInteger(env, 'MONITOR_TIMEOUT_MS', 10_000, 250, 120_000),
    maxResponseMs: parseInteger(env, 'MONITOR_MAX_RESPONSE_MS', 3_000, 1, 120_000),
    maxBodyBytes: parseInteger(env, 'MONITOR_MAX_BODY_BYTES', 1_048_576, 1024, 10_485_760),
    tlsWarnDays,
    tlsCriticalDays,
    failureThreshold: parseInteger(env, 'MONITOR_FAILURE_THRESHOLD', 2, 1, 100),
    recoveryThreshold: parseInteger(env, 'MONITOR_RECOVERY_THRESHOLD', 1, 1, 100),
    telegramProxyUrl,
    telegramMaxPendingUpdates: parseInteger(
      env,
      'MONITOR_TELEGRAM_MAX_PENDING_UPDATES',
      100,
      0,
      1_000_000
    ),
    telegramBots: [
      {
        id: 'telegram-main',
        label: 'Telegram main bot',
        token: mainBotToken,
        expectedUsername: mainBotUsername,
        mode: mainBotMode,
        expectedWebhookUrl: expectedWebhookUrl(
          env,
          mainBotMode,
          'MONITOR_TELEGRAM_MAIN_WEBHOOK_URL'
        )
      },
      {
        id: 'telegram-orders',
        label: 'Telegram orders bot',
        token: ordersBotToken,
        expectedUsername: ordersBotUsername,
        mode: ordersBotMode,
        expectedWebhookUrl: expectedWebhookUrl(
          env,
          ordersBotMode,
          'MONITOR_TELEGRAM_ORDERS_WEBHOOK_URL'
        )
      },
      {
        id: 'telegram-b2b',
        label: 'Telegram B2B bot',
        token: b2bBotToken,
        expectedUsername: b2bBotUsername,
        mode: b2bBotMode,
        expectedWebhookUrl: expectedWebhookUrl(
          env,
          b2bBotMode,
          'MONITOR_TELEGRAM_B2B_WEBHOOK_URL'
        )
      }
    ],
    telegramCanaryChatId: parseTelegramChatId(
      env,
      'MONITOR_TELEGRAM_CANARY_CHAT_ID',
      false
    ),
    notifier: {
      token: notifierToken,
      chatId: required(env, 'MONITOR_TELEGRAM_CHAT_ID'),
      expectedUsername: notifierUsername,
      proxyUrl: notifierProxyUrl
    },
    heartbeatUrl,
    stateFile: resolve(cwd, trimToUndefined(env.MONITOR_STATE_FILE) ?? '.monitor-state.json')
  };
};

const unquote = (raw: string): string => {
  if (raw.length < 2) {
    return raw;
  }
  const quote = raw[0];
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote) {
    return raw;
  }
  const value = raw.slice(1, -1);
  return quote === '"'
    ? value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    : value;
};

export const loadEnvFile = (filePath: string, env: Environment = process.env): void => {
  if (!existsSync(filePath)) {
    return;
  }
  const lines = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    const name = match[1];
    const rawValue = match[2];
    if (name && rawValue !== undefined && env[name] === undefined) {
      env[name] = unquote(rawValue);
    }
  }
};

export const parseMode = (args: string[]): MonitorMode => {
  const mode = args[0] ?? 'check';
  if (mode !== 'check' && mode !== 'summary') {
    throw new Error('Usage: monitor <check|summary>');
  }
  return mode;
};
