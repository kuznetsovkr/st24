import { createHash } from 'crypto';
import { HttpCircuitOpenError, HttpTimeoutError, resilientFetch } from './httpClient';
import { getTelegramOutboundDispatcher } from './telegramProxy';

export const TELEGRAM_BOT_KINDS = ['main', 'orders', 'b2b'] as const;

export type TelegramBotKind = (typeof TELEGRAM_BOT_KINDS)[number];
export type TelegramBotMode = 'disabled' | 'polling' | 'webhook';

export type TelegramTextPart = {
  type: 'text';
  text: string;
};

export type TelegramDocumentPart = {
  type: 'document';
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
  caption?: string;
};

export type TelegramOutboundPart = TelegramTextPart | TelegramDocumentPart;

export type TelegramDeliveryReceipt = {
  botKind: TelegramBotKind;
  messageId: number;
  chatId: string;
};

export type TelegramDeliveryErrorKind =
  | 'configuration'
  | 'transport'
  | 'telegram_api'
  | 'invalid_response';

export type TelegramDeliveryErrorCode =
  | number
  | 'missing_token'
  | 'circuit_open'
  | 'timeout'
  | 'network_error'
  | 'chat_not_found'
  | 'invalid_response';

export class TelegramDeliveryError extends Error {
  readonly botKind: TelegramBotKind;
  readonly kind: TelegramDeliveryErrorKind;
  readonly code: TelegramDeliveryErrorCode;
  readonly permanent: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(options: {
    botKind: TelegramBotKind;
    kind: TelegramDeliveryErrorKind;
    code: TelegramDeliveryErrorCode;
    permanent?: boolean;
    retryAfterSeconds?: number | null;
  }) {
    super(`Telegram delivery failed: ${options.kind}/${String(options.code)}`);
    this.name = 'TelegramDeliveryError';
    this.botKind = options.botKind;
    this.kind = options.kind;
    this.code = options.code;
    this.permanent = options.permanent ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

type TelegramEnvironment = Record<string, string | undefined>;

type TelegramBotEnvironmentKeys = {
  token: string;
  mode: string;
  legacyPolling: string;
  webhookSecret: string;
  webhookUrl: string;
  allowedChatIds: string;
};

const TELEGRAM_ENVIRONMENT_KEYS: Record<TelegramBotKind, TelegramBotEnvironmentKeys> = {
  main: {
    token: 'TELEGRAM_BOT_TOKEN',
    mode: 'TELEGRAM_MAIN_MODE',
    legacyPolling: 'TELEGRAM_POLLING',
    webhookSecret: 'TELEGRAM_WEBHOOK_SECRET',
    webhookUrl: 'TELEGRAM_MAIN_WEBHOOK_URL',
    allowedChatIds: 'TELEGRAM_MAIN_ALLOWED_CHAT_IDS'
  },
  orders: {
    token: 'TELEGRAM_ORDERS_BOT_TOKEN',
    mode: 'TELEGRAM_ORDERS_MODE',
    legacyPolling: 'TELEGRAM_ORDERS_POLLING',
    webhookSecret: 'TELEGRAM_ORDERS_WEBHOOK_SECRET',
    webhookUrl: 'TELEGRAM_ORDERS_WEBHOOK_URL',
    allowedChatIds: 'TELEGRAM_ORDERS_ALLOWED_CHAT_IDS'
  },
  b2b: {
    token: 'TELEGRAM_B2B_BOT_TOKEN',
    mode: 'TELEGRAM_B2B_MODE',
    legacyPolling: 'TELEGRAM_B2B_POLLING',
    webhookSecret: 'TELEGRAM_B2B_WEBHOOK_SECRET',
    webhookUrl: 'TELEGRAM_B2B_WEBHOOK_URL',
    allowedChatIds: 'TELEGRAM_B2B_ALLOWED_CHAT_IDS'
  }
};

export type TelegramBotRuntimeConfig = {
  kind: TelegramBotKind;
  mode: TelegramBotMode;
  tokenConfigured: boolean;
  webhookSecretConfigured: boolean;
  expectedWebhookUrl: string | null;
  allowedChatIds: string[];
};

export type TelegramRuntimeState = TelegramBotRuntimeConfig & {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
};

export type TelegramRuntimeEvent =
  | { type: 'configured'; config: TelegramBotRuntimeConfig }
  | { type: 'started' }
  | { type: 'attempt'; at: string }
  | { type: 'success'; at: string }
  | { type: 'failure'; at: string; errorCode: string };

const readNonEmpty = (value: string | undefined) => {
  const normalized = value?.trim();
  return normalized ? normalized : null;
};

const readLegacyPolling = (key: string, value: string | undefined) => {
  const normalized = readNonEmpty(value)?.toLowerCase();
  if (normalized === null || normalized === undefined) return null;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${key} must be true or false`);
};

const readExplicitMode = (key: string, value: string | undefined): TelegramBotMode | null => {
  const normalized = readNonEmpty(value)?.toLowerCase();
  if (normalized === null || normalized === undefined) return null;
  if (normalized === 'disabled' || normalized === 'polling' || normalized === 'webhook') {
    return normalized;
  }
  throw new Error(`${key} must be disabled, polling or webhook`);
};

const CHAT_ID_PATTERN = /^-?[1-9]\d*$/;

const TELEGRAM_WEBHOOK_PATHS: Record<TelegramBotKind, string> = {
  main: '/api/telegram/webhook',
  orders: '/api/telegram/orders-webhook',
  b2b: '/api/telegram/b2b-webhook'
};

const readAllowedChatIds = (key: string, value: string | undefined): string[] => {
  const raw = readNonEmpty(value);
  if (!raw) return [];
  const values = raw.split(',').map((candidate) => candidate.trim());
  if (
    values.some(
      (candidate) =>
        !CHAT_ID_PATTERN.test(candidate) || !Number.isSafeInteger(Number(candidate))
    )
  ) {
    throw new Error(`${key} must contain canonical safe Telegram chat IDs`);
  }
  return [...new Set(values)];
};

const readWebhookUrl = (
  key: string,
  value: string | undefined,
  expectedPath: string
): string | null => {
  const raw = readNonEmpty(value);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be a valid HTTPS URL`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    parsed.search ||
    parsed.pathname !== expectedPath
  ) {
    throw new Error(`${key} must be a valid HTTPS URL`);
  }
  return parsed.href;
};

export const getTelegramAllowedChatIds = (
  kind: TelegramBotKind,
  environment: TelegramEnvironment = process.env
): string[] => readAllowedChatIds(
  TELEGRAM_ENVIRONMENT_KEYS[kind].allowedChatIds,
  environment[TELEGRAM_ENVIRONMENT_KEYS[kind].allowedChatIds]
);

export const isTelegramChatAllowed = (
  kind: TelegramBotKind,
  chatId: string,
  environment: TelegramEnvironment = process.env
) => getTelegramAllowedChatIds(kind, environment).includes(chatId);

export const resolveTelegramRuntimeConfig = (
  environment: TelegramEnvironment
): TelegramBotRuntimeConfig[] => {
  const configs = TELEGRAM_BOT_KINDS.map((kind) => {
    const keys = TELEGRAM_ENVIRONMENT_KEYS[kind];
    const tokenConfigured = readNonEmpty(environment[keys.token]) !== null;
    const webhookSecretConfigured = readNonEmpty(environment[keys.webhookSecret]) !== null;
    const expectedWebhookUrl = readWebhookUrl(
      keys.webhookUrl,
      environment[keys.webhookUrl],
      TELEGRAM_WEBHOOK_PATHS[kind]
    );
    const allowedChatIds = readAllowedChatIds(keys.allowedChatIds, environment[keys.allowedChatIds]);
    const explicitMode = readExplicitMode(keys.mode, environment[keys.mode]);
    const legacyPolling = readLegacyPolling(keys.legacyPolling, environment[keys.legacyPolling]);

    if (
      explicitMode !== null &&
      legacyPolling !== null &&
      ((explicitMode === 'polling') !== legacyPolling)
    ) {
      throw new Error(`${keys.mode} conflicts with ${keys.legacyPolling}`);
    }

    const mode: TelegramBotMode =
      explicitMode ?? (legacyPolling === true ? 'polling' : webhookSecretConfigured ? 'webhook' : 'disabled');

    if (mode !== 'disabled' && !tokenConfigured) {
      throw new Error(`${keys.token} is required when ${keys.mode} is ${mode}`);
    }
    if (mode === 'webhook' && !webhookSecretConfigured) {
      throw new Error(`${keys.webhookSecret} is required in webhook mode`);
    }
    if (mode !== 'webhook' && webhookSecretConfigured) {
      throw new Error(`${keys.webhookSecret} is only allowed in webhook mode`);
    }
    if (mode === 'webhook' && !expectedWebhookUrl) {
      throw new Error(`${keys.webhookUrl} is required in webhook mode`);
    }
    if (mode !== 'webhook' && expectedWebhookUrl) {
      throw new Error(`${keys.webhookUrl} is only allowed in webhook mode`);
    }
    if (tokenConfigured && allowedChatIds.length === 0) {
      throw new Error(`${keys.allowedChatIds} is required when ${keys.token} is configured`);
    }

    return {
      kind,
      mode,
      tokenConfigured,
      webhookSecretConfigured,
      expectedWebhookUrl,
      allowedChatIds
    };
  });

  const activeTokens = new Map<string, TelegramBotKind>();
  for (const config of configs) {
    const token = readNonEmpty(environment[TELEGRAM_ENVIRONMENT_KEYS[config.kind].token]);
    if (!token) continue;
    const existingKind = activeTokens.get(token);
    if (existingKind) {
      throw new Error(`Active Telegram bot tokens must be unique (${existingKind}/${config.kind})`);
    }
    activeTokens.set(token, config.kind);
  }

  return configs;
};

export const createTelegramRuntimeState = (
  config: TelegramBotRuntimeConfig
): TelegramRuntimeState => ({
  ...config,
  running: config.mode === 'webhook',
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastErrorCode: null
});

export const reduceTelegramRuntimeState = (
  state: TelegramRuntimeState,
  event: TelegramRuntimeEvent
): TelegramRuntimeState => {
  if (event.type === 'configured') {
    return {
      ...state,
      ...event.config,
      running:
        event.config.mode === 'webhook'
          ? true
          : event.config.mode === 'disabled'
            ? false
            : state.mode === 'polling' && state.running
    };
  }
  if (event.type === 'started') {
    return { ...state, running: true };
  }
  if (event.type === 'attempt') {
    return { ...state, lastAttemptAt: event.at };
  }
  if (event.type === 'success') {
    return {
      ...state,
      lastSuccessAt: event.at,
      consecutiveFailures: 0,
      lastErrorCode: null
    };
  }
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
    lastErrorCode: event.errorCode
  };
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const parsePositiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;

const parseChatId = (value: unknown) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value !== 0) {
    return String(value);
  }
  if (typeof value === 'string' && /^-?[1-9]\d*$/.test(value)) {
    return value;
  }
  return null;
};

const parseRetryAfterHeader = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const parseTelegramDeliveryResponse = (options: {
  botKind: TelegramBotKind;
  httpStatus: number;
  payload: unknown;
  retryAfterHeader?: string | null;
}): TelegramDeliveryReceipt => {
  const root = asRecord(options.payload);
  const result = asRecord(root?.result);
  const chat = asRecord(result?.chat);
  const messageId = parsePositiveInteger(result?.message_id);
  const chatId = parseChatId(chat?.id);
  const httpOk = options.httpStatus >= 200 && options.httpStatus < 300;

  if (httpOk && root?.ok === true && messageId !== null && chatId !== null) {
    return { botKind: options.botKind, messageId, chatId };
  }

  const telegramCode = parsePositiveInteger(root?.error_code);
  const effectiveCode = telegramCode ?? (options.httpStatus >= 400 ? options.httpStatus : null);
  const apiRejected = root?.ok === false || effectiveCode !== null;

  if (apiRejected) {
    const parameters = asRecord(root?.parameters);
    const description =
      typeof root?.description === 'string' ? root.description.toLowerCase() : '';
    const code =
      effectiveCode === 400 && description.includes('chat not found')
        ? 'chat_not_found'
        : effectiveCode ?? 'invalid_response';
    const payloadRetryAfter = parsePositiveInteger(parameters?.retry_after);
    const retryAfterSeconds =
      effectiveCode === 429
        ? payloadRetryAfter ?? parseRetryAfterHeader(options.retryAfterHeader)
        : null;
    throw new TelegramDeliveryError({
      botKind: options.botKind,
      kind: 'telegram_api',
      code,
      permanent:
        code !== 'chat_not_found' &&
        (effectiveCode === 400 || effectiveCode === 401 || effectiveCode === 403),
      retryAfterSeconds
    });
  }

  throw new TelegramDeliveryError({
    botKind: options.botKind,
    kind: 'invalid_response',
    code: 'invalid_response'
  });
};

export const getTelegramBotToken = (botKind: TelegramBotKind) => {
  const token = readNonEmpty(process.env[TELEGRAM_ENVIRONMENT_KEYS[botKind].token]);
  if (!token) {
    throw new TelegramDeliveryError({
      botKind,
      kind: 'configuration',
      code: 'missing_token',
      permanent: true
    });
  }
  return token;
};

export const getTelegramBotInstanceKey = (botKind: TelegramBotKind) =>
  createHash('sha256')
    .update(getTelegramBotToken(botKind), 'utf8')
    .digest('hex')
    .slice(0, 32);

const createDocumentPayload = (chatId: string, part: TelegramDocumentPart) => {
  const payload = new FormData();
  payload.append('chat_id', chatId);
  const normalizedBytes = new Uint8Array(part.bytes.byteLength);
  normalizedBytes.set(part.bytes);
  payload.append(
    'document',
    new Blob([normalizedBytes], { type: part.mimeType ?? 'application/octet-stream' }),
    part.fileName
  );
  if (part.caption) payload.append('caption', part.caption);
  return payload;
};

export const classifyTelegramTransportFailure = (
  botKind: TelegramBotKind,
  error: unknown
): TelegramDeliveryError => {
  if (error instanceof TelegramDeliveryError) return error;
  if (error instanceof HttpCircuitOpenError) {
    return new TelegramDeliveryError({
      botKind,
      kind: 'transport',
      code: 'circuit_open',
      retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1000))
    });
  }
  if (error instanceof HttpTimeoutError) {
    return new TelegramDeliveryError({ botKind, kind: 'transport', code: 'timeout' });
  }
  return new TelegramDeliveryError({ botKind, kind: 'transport', code: 'network_error' });
};

export const sendTelegramPartToChat = async (
  botKind: TelegramBotKind,
  chatId: string,
  part: TelegramOutboundPart
): Promise<TelegramDeliveryReceipt> => {
  const token = getTelegramBotToken(botKind);
  const method = part.type === 'text' ? 'sendMessage' : 'sendDocument';
  const init: RequestInit & { dispatcher?: unknown } =
    part.type === 'text'
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: part.text }),
          dispatcher: getTelegramOutboundDispatcher()
        }
      : {
          method: 'POST',
          body: createDocumentPayload(chatId, part),
          dispatcher: getTelegramOutboundDispatcher()
        };

  try {
    const response = await resilientFetch(
      `https://api.telegram.org/bot${token}/${method}`,
      init,
      {
        circuitKey: `telegram:delivery:${botKind}:${method}`,
        timeoutMs: part.type === 'text' ? 10_000 : 15_000,
        maxRetries: 0
      }
    );
    const payload = await response.json().catch(() => null);
    return parseTelegramDeliveryResponse({
      botKind,
      httpStatus: response.status,
      payload,
      retryAfterHeader: response.headers.get('retry-after')
    });
  } catch (error) {
    throw classifyTelegramTransportFailure(botKind, error);
  }
};
