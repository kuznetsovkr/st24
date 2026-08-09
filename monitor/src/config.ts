import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { MonitorConfig, MonitorMode } from './types';

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

  const mainBotToken = required(env, 'TELEGRAM_BOT_TOKEN');
  const ordersBotToken = required(env, 'TELEGRAM_ORDERS_BOT_TOKEN');
  const b2bBotToken = required(env, 'TELEGRAM_B2B_BOT_TOKEN');
  const notifierToken = required(env, 'MONITOR_TELEGRAM_BOT_TOKEN');
  if (new Set([mainBotToken, ordersBotToken, b2bBotToken]).size !== 3) {
    throw new Error('Production Telegram bot tokens must be unique');
  }
  if ([mainBotToken, ordersBotToken, b2bBotToken].includes(notifierToken)) {
    throw new Error('MONITOR_TELEGRAM_BOT_TOKEN must not match a production bot token');
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
    telegramBots: [
      {
        id: 'telegram-main',
        label: 'Telegram main bot',
        token: mainBotToken,
        expectedUsername: optionalBotUsername(env, 'MONITOR_TELEGRAM_MAIN_USERNAME')
      },
      {
        id: 'telegram-orders',
        label: 'Telegram orders bot',
        token: ordersBotToken,
        expectedUsername: optionalBotUsername(env, 'MONITOR_TELEGRAM_ORDERS_USERNAME')
      },
      {
        id: 'telegram-b2b',
        label: 'Telegram B2B bot',
        token: b2bBotToken,
        expectedUsername: optionalBotUsername(env, 'MONITOR_TELEGRAM_B2B_USERNAME')
      }
    ],
    notifier: {
      token: notifierToken,
      chatId: required(env, 'MONITOR_TELEGRAM_CHAT_ID'),
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
