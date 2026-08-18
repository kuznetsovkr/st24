import {
  deactivateTelegramB2BSubscriber,
  deactivateTelegramOrderSubscriber,
  deactivateTelegramSubscriber,
  listTelegramB2BSubscribers,
  listTelegramOrderSubscribers,
  listTelegramSubscribers,
  upsertTelegramB2BSubscriber,
  upsertTelegramOrderSubscriber,
  upsertTelegramSubscriber,
  type TelegramSubscriberInput
} from './db/telegram';
import { logIntegrationEvent } from './integrationEvents';
import { resilientFetch } from './httpClient';
import { getTelegramOutboundDispatcher } from './telegramProxy';
import {
  beginTelegramUpdateInbox,
  completeTelegramUpdateInbox,
  failTelegramUpdateInbox,
  loadTelegramUpdateCursor,
  resetTelegramUpdateOffset,
  saveTelegramUpdateOffset
} from './db/telegramOutbox';
import {
  TELEGRAM_BOT_KINDS,
  TelegramDeliveryError,
  createTelegramRuntimeState,
  getTelegramAllowedChatIds,
  getTelegramBotInstanceKey,
  isTelegramChatAllowed,
  reduceTelegramRuntimeState,
  resolveTelegramRuntimeConfig,
  sendTelegramPartToChat,
  type TelegramBotKind,
  type TelegramBotRuntimeConfig,
  type TelegramRuntimeState
} from './telegramTransport';

type TelegramDocumentInput = {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
};

type TelegramUpdatePayload = {
  message?: {
    text?: string;
    chat?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      last_name?: string;
      type?: string;
    };
    from?: {
      language_code?: string;
    };
  };
  edited_message?: {
    text?: string;
    chat?: {
      id?: number | string;
      username?: string;
      first_name?: string;
      last_name?: string;
      type?: string;
    };
    from?: {
      language_code?: string;
    };
  };
  my_chat_member?: {
    chat?: {
      id?: number | string;
      type?: string;
    };
    from?: {
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    new_chat_member?: {
      status?: string;
    };
  };
};

type TelegramConfig = {
  token: string;
};

type UpdateProcessorOptions = {
  botKind: TelegramBotKind;
  upsertSubscriber: (input: TelegramSubscriberInput) => Promise<unknown>;
  deactivateSubscriber: (chatId: string) => Promise<unknown>;
  sendWelcomeMessage: (chatId: string) => Promise<void>;
  sendStopMessage: (chatId: string) => Promise<void>;
};

const getTelegramConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram не настроен');
  }
  return { token };
};

const getTelegramOrdersConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_ORDERS_BOT_TOKEN;
  if (!token) {
    throw new Error('Бот Telegram для заказов не настроен');
  }
  return { token };
};

const getTelegramB2BConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_B2B_BOT_TOKEN;
  if (!token) {
    throw new Error('B2B-бот Telegram не настроен');
  }
  return { token };
};

const resolveBotKindForToken = (token: string): TelegramBotKind => {
  if (token === process.env.TELEGRAM_ORDERS_BOT_TOKEN) return 'orders';
  if (token === process.env.TELEGRAM_B2B_BOT_TOKEN) return 'b2b';
  return 'main';
};

async function sendToChat(token: string, chatId: string, text: string) {
  await sendTelegramPartToChat(resolveBotKindForToken(token), chatId, {
    type: 'text',
    text
  });
}

async function sendDocumentToChat(
  token: string,
  chatId: string,
  document: TelegramDocumentInput,
  caption?: string
) {
  await sendTelegramPartToChat(resolveBotKindForToken(token), chatId, {
    type: 'document',
    ...document,
    caption
  });
}

const sendWelcomeMessage = async (chatId: string) => {
  const { token } = getTelegramConfig();
  const text = [
    'Привет! Вы подписались на заявки "Нужна деталь".',
    'Сообщения будут приходить в этот чат.',
    'Чтобы отключить уведомления, отправьте /stop.'
  ].join('\n');

  await sendToChat(token, chatId, text);
};

const sendStopMessage = async (chatId: string) => {
  const { token } = getTelegramConfig();
  const text = ['Уведомления отключены.', 'Чтобы включить снова, отправьте /start.'].join(
    '\n'
  );

  await sendToChat(token, chatId, text);
};

const sendOrdersWelcomeMessage = async (chatId: string) => {
  const { token } = getTelegramOrdersConfig();
  const text = [
    'Привет! Вы подписались на уведомления о новых оплаченных заказах.',
    'Чтобы отключить уведомления, отправьте /stop.'
  ].join('\n');

  await sendToChat(token, chatId, text);
};

const sendOrdersStopMessage = async (chatId: string) => {
  const { token } = getTelegramOrdersConfig();
  const text = ['Уведомления о заказах отключены.', 'Чтобы включить снова, отправьте /start.'].join(
    '\n'
  );

  await sendToChat(token, chatId, text);
};

const sendB2BWelcomeMessage = async (chatId: string) => {
  const { token } = getTelegramB2BConfig();
  const text = [
    'Привет! Вы подписались на заявки от юридических лиц.',
    'Новые заявки будут приходить в этот чат.',
    'Чтобы отключить уведомления, отправьте /stop.'
  ].join('\n');

  await sendToChat(token, chatId, text);
};

const sendB2BStopMessage = async (chatId: string) => {
  const { token } = getTelegramB2BConfig();
  const text = [
    'Уведомления о B2B-заявках отключены.',
    'Чтобы включить снова, отправьте /start.'
  ].join('\n');

  await sendToChat(token, chatId, text);
};

const processTelegramUpdate = async (
  update: unknown,
  options: UpdateProcessorOptions
) => {
  const payload = (update ?? {}) as TelegramUpdatePayload;
  const message = payload.message ?? payload.edited_message;
  const chat = message?.chat;
  const text = typeof message?.text === 'string' ? message.text : '';

  if (chat?.id && text) {
    const chatId = String(chat.id);
    const username = typeof chat.username === 'string' ? chat.username : null;
    const firstName = typeof chat.first_name === 'string' ? chat.first_name : null;
    const lastName = typeof chat.last_name === 'string' ? chat.last_name : null;
    const chatType = typeof chat.type === 'string' ? chat.type : null;
    const languageCode =
      typeof message?.from?.language_code === 'string'
        ? message.from.language_code
        : null;

    if (text.startsWith('/start')) {
      if (!isTelegramChatAllowed(options.botKind, chatId)) {
        await options.deactivateSubscriber(chatId);
        return;
      }
      await options.upsertSubscriber({
        chatId,
        username,
        firstName,
        lastName,
        languageCode,
        chatType
      });
      try {
        await options.sendWelcomeMessage(chatId);
      } catch {
        // ignore welcome send errors
      }
    }

    if (text.startsWith('/stop')) {
      await options.deactivateSubscriber(chatId);
      try {
        await options.sendStopMessage(chatId);
      } catch {
        // ignore stop send errors
      }
    }
  }

  const membership = payload.my_chat_member;
  if (membership?.chat?.id) {
    const chatId = String(membership.chat.id);
    const status = membership.new_chat_member?.status;
    if (status === 'kicked' || status === 'left') {
      await options.deactivateSubscriber(chatId);
    } else if (status === 'member' || status === 'administrator' || status === 'creator') {
      if (!isTelegramChatAllowed(options.botKind, chatId)) {
        await options.deactivateSubscriber(chatId);
        return;
      }
      await options.upsertSubscriber({
        chatId,
        username:
          typeof membership.from?.username === 'string' ? membership.from.username : null,
        firstName:
          typeof membership.from?.first_name === 'string' ? membership.from.first_name : null,
        lastName:
          typeof membership.from?.last_name === 'string' ? membership.from.last_name : null,
        languageCode:
          typeof membership.from?.language_code === 'string'
            ? membership.from.language_code
            : null,
        chatType: typeof membership.chat?.type === 'string' ? membership.chat.type : null
      });
    }
  }
};

const telegramUpdateProcessors: Record<
  TelegramBotKind,
  (update: unknown) => Promise<void>
> = {
  main: (update) =>
    processTelegramUpdate(update, {
      botKind: 'main',
      upsertSubscriber: upsertTelegramSubscriber,
      deactivateSubscriber: deactivateTelegramSubscriber,
      sendWelcomeMessage,
      sendStopMessage
    }),
  orders: (update) =>
    processTelegramUpdate(update, {
      botKind: 'orders',
      upsertSubscriber: upsertTelegramOrderSubscriber,
      deactivateSubscriber: deactivateTelegramOrderSubscriber,
      sendWelcomeMessage: sendOrdersWelcomeMessage,
      sendStopMessage: sendOrdersStopMessage
    }),
  b2b: (update) =>
    processTelegramUpdate(update, {
      botKind: 'b2b',
      upsertSubscriber: upsertTelegramB2BSubscriber,
      deactivateSubscriber: deactivateTelegramB2BSubscriber,
      sendWelcomeMessage: sendB2BWelcomeMessage,
      sendStopMessage: sendB2BStopMessage
    })
};

class TelegramUpdateInboxError extends Error {
  constructor(code: 'invalid_update_id' | 'update_busy' | 'update_lease_lost') {
    super(code);
    this.name = 'TelegramUpdateInboxError';
  }
}

const getTelegramUpdateId = (update: unknown) => {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    throw new TelegramUpdateInboxError('invalid_update_id');
  }
  const updateId = (update as { update_id?: unknown }).update_id;
  if (typeof updateId !== 'number' || !Number.isSafeInteger(updateId) || updateId < 0) {
    throw new TelegramUpdateInboxError('invalid_update_id');
  }
  return updateId;
};

const processTelegramUpdateDurably = async (
  botKind: TelegramBotKind,
  update: unknown,
  nextOffset?: number
) => {
  const updateId = getTelegramUpdateId(update);
  const botInstanceKey = getTelegramBotInstanceKey(botKind);
  const inbox = await beginTelegramUpdateInbox(botKind, botInstanceKey, updateId);
  if (inbox.state === 'already_processed') {
    if (nextOffset !== undefined) {
      await saveTelegramUpdateOffset(botKind, botInstanceKey, nextOffset);
    }
    return;
  }
  if (inbox.state === 'busy') {
    throw new TelegramUpdateInboxError('update_busy');
  }

  try {
    await telegramUpdateProcessors[botKind](update);
    const completed = await completeTelegramUpdateInbox(
      botKind,
      botInstanceKey,
      updateId,
      inbox.attemptCount,
      nextOffset
    );
    if (!completed) throw new TelegramUpdateInboxError('update_lease_lost');
  } catch (error) {
    await failTelegramUpdateInbox(
      botKind,
      botInstanceKey,
      updateId,
      inbox.attemptCount,
      'unknown_error'
    ).catch(() => undefined);
    throw error;
  }
};

export const handleTelegramUpdate = async (update: unknown) => {
  await trackWebhookUpdate('main', () => processTelegramUpdateDurably('main', update));
};

export const handleTelegramOrderUpdate = async (update: unknown) => {
  await trackWebhookUpdate('orders', () =>
    processTelegramUpdateDurably('orders', update)
  );
};

export const handleTelegramB2BUpdate = async (update: unknown) => {
  await trackWebhookUpdate('b2b', () => processTelegramUpdateDurably('b2b', update));
};

export const listActiveTelegramChatIds = async (
  botKind: TelegramBotKind
): Promise<string[]> => {
  const subscribers =
    botKind === 'main'
      ? await listTelegramSubscribers()
      : botKind === 'orders'
        ? await listTelegramOrderSubscribers()
        : await listTelegramB2BSubscribers();
  const allowed = new Set(getTelegramAllowedChatIds(botKind));
  return subscribers
    .map((subscriber) => subscriber.chat_id)
    .filter((chatId) => allowed.has(chatId));
};

export const deactivateTelegramChat = async (
  botKind: TelegramBotKind,
  chatId: string
) => {
  if (botKind === 'main') {
    await deactivateTelegramSubscriber(chatId);
    return;
  }
  if (botKind === 'orders') {
    await deactivateTelegramOrderSubscriber(chatId);
    return;
  }
  await deactivateTelegramB2BSubscriber(chatId);
};

export const sendTelegramMessage = async (
  text: string,
  documents?: TelegramDocumentInput[]
) => {
  const { token } = getTelegramConfig();
  const subscribers = await listTelegramSubscribers();
  if (subscribers.length === 0) {
    throw new Error('Нет подписчиков Telegram. Нажмите /start в боте.');
  }

  let successCount = 0;
  const errors: Error[] = [];

  await Promise.all(
    subscribers.map(async (subscriber) => {
      try {
        await sendToChat(token, subscriber.chat_id, text);
        if (Array.isArray(documents) && documents.length > 0) {
          for (let index = 0; index < documents.length; index += 1) {
            const document = documents[index];
            const caption =
              documents.length > 1 ? `Фото ${index + 1}: ${document.fileName}` : document.fileName;
            await sendDocumentToChat(token, subscriber.chat_id, document, caption);
          }
        }
        successCount += 1;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Не удалось отправить');
        const errorCode = err instanceof TelegramDeliveryError ? err.code : null;
        if (errorCode === 403) {
          await deactivateTelegramSubscriber(subscriber.chat_id);
          return;
        }
        errors.push(err);
      }
    })
  );

  if (successCount === 0 && errors.length > 0) {
    throw errors[0];
  }
};

export const sendOrderTelegramMessage = async (text: string) => {
  const { token } = getTelegramOrdersConfig();
  const subscribers = await listTelegramOrderSubscribers();
  if (subscribers.length === 0) {
    throw new Error('Нет подписчиков Telegram заказов. Нажмите /start в боте заказов.');
  }

  let successCount = 0;
  const errors: Error[] = [];

  await Promise.all(
    subscribers.map(async (subscriber) => {
      try {
        await sendToChat(token, subscriber.chat_id, text);
        successCount += 1;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Не удалось отправить');
        const errorCode = err instanceof TelegramDeliveryError ? err.code : null;
        if (errorCode === 403) {
          await deactivateTelegramOrderSubscriber(subscriber.chat_id);
          return;
        }
        errors.push(err);
      }
    })
  );

  if (successCount === 0 && errors.length > 0) {
    throw errors[0];
  }
};

export const sendB2BTelegramMessage = async (
  text: string,
  document?: TelegramDocumentInput
) => {
  const { token } = getTelegramB2BConfig();
  const subscribers = await listTelegramB2BSubscribers();
  if (subscribers.length === 0) {
    throw new Error('Нет подписчиков Telegram B2B. Нажмите /start в B2B-боте.');
  }

  let successCount = 0;
  const errors: Error[] = [];
  const documentCaption = document
    ? `Карточка предприятия: ${document.fileName}`
    : null;

  await Promise.all(
    subscribers.map(async (subscriber) => {
      try {
        await sendToChat(token, subscriber.chat_id, text);
        if (document) {
          await sendDocumentToChat(token, subscriber.chat_id, document, documentCaption ?? undefined);
        }
        successCount += 1;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Не удалось отправить');
        const errorCode = err instanceof TelegramDeliveryError ? err.code : null;
        if (errorCode === 403) {
          await deactivateTelegramB2BSubscriber(subscriber.chat_id);
          return;
        }
        errors.push(err);
      }
    })
  );

  if (successCount === 0 && errors.length > 0) {
    throw errors[0];
  }
};

type TelegramPollingUpdate = {
  update_id: number;
} & Record<string, unknown>;

type TelegramPollingDefinition = {
  tokenEnvironmentKey: string;
  operation: string;
};

const TELEGRAM_POLLING_DEFINITIONS: Record<
  TelegramBotKind,
  TelegramPollingDefinition
> = {
  main: {
    tokenEnvironmentKey: 'TELEGRAM_BOT_TOKEN',
    operation: 'poll_updates'
  },
  orders: {
    tokenEnvironmentKey: 'TELEGRAM_ORDERS_BOT_TOKEN',
    operation: 'poll_updates_orders'
  },
  b2b: {
    tokenEnvironmentKey: 'TELEGRAM_B2B_BOT_TOKEN',
    operation: 'poll_updates_b2b'
  }
};

const createDisabledRuntimeConfig = (
  kind: TelegramBotKind
): TelegramBotRuntimeConfig => ({
  kind,
  mode: 'disabled',
  tokenConfigured: false,
  webhookSecretConfigured: false,
  expectedWebhookUrl: null,
  allowedChatIds: []
});

const telegramRuntimeStates = Object.fromEntries(
  TELEGRAM_BOT_KINDS.map((kind) => [
    kind,
    createTelegramRuntimeState(createDisabledRuntimeConfig(kind))
  ])
) as Record<TelegramBotKind, TelegramRuntimeState>;

async function trackWebhookUpdate(
  botKind: TelegramBotKind,
  operation: () => Promise<void>
) {
  if (telegramRuntimeStates[botKind].mode !== 'webhook') {
    throw new Error('telegram_webhook_mode_disabled');
  }

  const attemptedAt = new Date().toISOString();
  telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
    telegramRuntimeStates[botKind],
    { type: 'attempt', at: attemptedAt }
  );
  try {
    await operation();
    telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
      telegramRuntimeStates[botKind],
      { type: 'success', at: new Date().toISOString() }
    );
  } catch (error) {
    telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
      telegramRuntimeStates[botKind],
      {
        type: 'failure',
        at: new Date().toISOString(),
        errorCode: 'update_processing_error'
      }
    );
    throw error;
  }
}

const applyTelegramRuntimeConfigs = (configs: TelegramBotRuntimeConfig[]) => {
  for (const config of configs) {
    telegramRuntimeStates[config.kind] = reduceTelegramRuntimeState(
      telegramRuntimeStates[config.kind],
      { type: 'configured', config }
    );
  }
};

export const validateTelegramStartupConfig = (
  environment: Record<string, string | undefined> = process.env
) => {
  const configs = resolveTelegramRuntimeConfig(environment);
  applyTelegramRuntimeConfigs(configs);
  return configs;
};

export const getTelegramRuntimeSnapshot = (): Record<
  TelegramBotKind,
  TelegramRuntimeState
> => ({
  main: { ...telegramRuntimeStates.main },
  orders: { ...telegramRuntimeStates.orders },
  b2b: { ...telegramRuntimeStates.b2b }
});

class TelegramPollingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TelegramPollingError';
    this.code = code;
  }
}

const asPollingPayload = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export type TelegramBotProbeState = {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  botId: string | null;
  username: string | null;
};

const createTelegramBotProbeState = (): TelegramBotProbeState => ({
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastErrorCode: null,
  botId: null,
  username: null
});

const telegramBotProbeStates = Object.fromEntries(
  TELEGRAM_BOT_KINDS.map((kind) => [kind, createTelegramBotProbeState()])
) as Record<TelegramBotKind, TelegramBotProbeState>;

export const getTelegramBotProbeSnapshot = (): Record<
  TelegramBotKind,
  TelegramBotProbeState
> => ({
  main: { ...telegramBotProbeStates.main },
  orders: { ...telegramBotProbeStates.orders },
  b2b: { ...telegramBotProbeStates.b2b }
});

class TelegramBotProbeError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'TelegramBotProbeError';
    this.code = code;
  }
}

const parseProbeInteger = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const requestTelegramProbeMethod = async (
  botKind: TelegramBotKind,
  token: string,
  method: 'getMe' | 'getWebhookInfo'
) => {
  const response = await resilientFetch(
    `https://api.telegram.org/bot${token}/${method}`,
    { dispatcher: getTelegramOutboundDispatcher() },
    {
      circuitKey: `telegram:runtime_probe:${botKind}:${method}`,
      timeoutMs: 10_000,
      maxRetries: 1
    }
  );
  const payload = await response.json().catch(() => null);
  const root = asPollingPayload(payload);
  if (response.status < 200 || response.status >= 300 || root?.ok !== true) {
    const telegramCode =
      typeof root?.error_code === 'number' && Number.isInteger(root.error_code)
        ? root.error_code
        : response.status;
    throw new TelegramBotProbeError(`telegram_api_${telegramCode}`);
  }
  const result = asPollingPayload(root.result);
  if (!result) throw new TelegramBotProbeError('invalid_response');
  return result;
};

const probeTelegramBot = async (config: TelegramBotRuntimeConfig) => {
  const token = process.env[TELEGRAM_POLLING_DEFINITIONS[config.kind].tokenEnvironmentKey]?.trim();
  if (!token) throw new TelegramBotProbeError('config_missing');

  const identity = await requestTelegramProbeMethod(config.kind, token, 'getMe');
  const botId = identity.id;
  const username = identity.username;
  if (
    identity.is_bot !== true ||
    !(
      (typeof botId === 'number' && Number.isSafeInteger(botId) && botId > 0) ||
      (typeof botId === 'string' && /^[1-9]\d*$/.test(botId))
    ) ||
    typeof username !== 'string' ||
    !/^[A-Za-z0-9_]{5,32}$/.test(username)
  ) {
    throw new TelegramBotProbeError('invalid_identity');
  }

  const webhook = await requestTelegramProbeMethod(config.kind, token, 'getWebhookInfo');
  const webhookUrl = typeof webhook.url === 'string' ? webhook.url : null;
  const pending = webhook.pending_update_count;
  const maxPending = parseProbeInteger(
    process.env.TELEGRAM_MAX_PENDING_UPDATES,
    100,
    0,
    1_000_000
  );
  if (
    webhookUrl === null ||
    typeof pending !== 'number' ||
    !Number.isSafeInteger(pending) ||
    pending < 0
  ) {
    throw new TelegramBotProbeError('invalid_webhook_info');
  }
  if (config.mode !== 'disabled' && pending > maxPending) {
    throw new TelegramBotProbeError('updates_backlog');
  }
  if ((config.mode === 'polling' || config.mode === 'disabled') && webhookUrl !== '') {
    throw new TelegramBotProbeError('unexpected_webhook');
  }
  if (config.mode === 'webhook' && webhookUrl !== config.expectedWebhookUrl) {
    throw new TelegramBotProbeError('webhook_mismatch');
  }
  const recentErrorCutoffSeconds = Math.floor(Date.now() / 1_000) - 600;
  const lastErrorDate = webhook.last_error_date;
  if (
    config.mode === 'webhook' &&
    typeof lastErrorDate === 'number' &&
    Number.isSafeInteger(lastErrorDate) &&
    lastErrorDate >= recentErrorCutoffSeconds
  ) {
    throw new TelegramBotProbeError('webhook_delivery_error');
  }
  const lastSynchronizationErrorDate = webhook.last_synchronization_error_date;
  if (
    config.mode !== 'disabled' &&
    typeof lastSynchronizationErrorDate === 'number' &&
    Number.isSafeInteger(lastSynchronizationErrorDate) &&
    lastSynchronizationErrorDate >= recentErrorCutoffSeconds
  ) {
    throw new TelegramBotProbeError('updates_synchronization_error');
  }

  return { botId: String(botId), username };
};

let telegramBotSupervisionStarted = false;

export const startTelegramBotSupervision = () => {
  if (telegramBotSupervisionStarted) return;
  telegramBotSupervisionStarted = true;
  const intervalMs = parseProbeInteger(
    process.env.TELEGRAM_RUNTIME_PROBE_INTERVAL_MS,
    60_000,
    10_000,
    3_600_000
  );
  const configs = validateTelegramStartupConfig();

  for (const config of configs) {
    if (!config.tokenConfigured) continue;
    const state = telegramBotProbeStates[config.kind];
    state.running = true;
    const run = async () => {
      state.lastAttemptAt = new Date().toISOString();
      try {
        const identity = await probeTelegramBot(config);
        state.lastSuccessAt = new Date().toISOString();
        state.consecutiveFailures = 0;
        state.lastErrorCode = null;
        state.botId = identity.botId;
        state.username = identity.username;
      } catch (error) {
        state.consecutiveFailures += 1;
        state.lastErrorCode =
          error instanceof TelegramBotProbeError
            ? error.code
            : error instanceof TelegramDeliveryError
              ? `${error.kind}_${String(error.code)}`
              : 'runtime_probe_failed';
        void logIntegrationEvent({
          provider: 'telegram',
          operation: `runtime_probe_${config.kind}`,
          fallbackUsed: false,
          error: state.lastErrorCode
        });
      } finally {
        const timer = setTimeout(() => void run(), intervalMs);
        timer.unref?.();
      }
    };
    void run();
  }
};

const parsePollingResponse = (
  responseStatus: number,
  payload: unknown
): TelegramPollingUpdate[] => {
  const root = asPollingPayload(payload);
  if (
    responseStatus < 200 ||
    responseStatus >= 300 ||
    root?.ok !== true ||
    !Array.isArray(root.result)
  ) {
    const telegramCode =
      typeof root?.error_code === 'number' && Number.isInteger(root.error_code)
        ? root.error_code
        : null;
    throw new TelegramPollingError(
      telegramCode !== null
        ? `telegram_api_${telegramCode}`
        : responseStatus >= 400
          ? `http_${responseStatus}`
          : 'invalid_response'
    );
  }

  const updates: TelegramPollingUpdate[] = [];
  for (const value of root.result) {
    const update = asPollingPayload(value);
    if (
      !update ||
      typeof update.update_id !== 'number' ||
      !Number.isSafeInteger(update.update_id) ||
      update.update_id < 0
    ) {
      throw new TelegramPollingError('invalid_response');
    }
    updates.push(update as TelegramPollingUpdate);
  }
  return updates;
};

const safePollingErrorCode = (error: unknown) => {
  if (error instanceof TelegramPollingError) return error.code;
  if (error instanceof TelegramDeliveryError) {
    return `${error.kind}_${String(error.code)}`;
  }
  if (error instanceof Error && error.name === 'HttpTimeoutError') return 'timeout';
  if (error instanceof Error && error.name === 'HttpCircuitOpenError') return 'circuit_open';
  return 'polling_error';
};

const TELEGRAM_UPDATE_ID_RANDOMIZATION_IDLE_MS = 7 * 24 * 60 * 60_000;

export const shouldResetTelegramUpdateOffset = (
  offset: number,
  lastUpdateAt: string | null,
  now = Date.now()
) => {
  if (offset <= 0 || !lastUpdateAt) return false;
  const timestamp = Date.parse(lastUpdateAt);
  return Number.isFinite(timestamp) && now - timestamp >= TELEGRAM_UPDATE_ID_RANDOMIZATION_IDLE_MS;
};

const startTelegramPollingForBot = (botKind: TelegramBotKind) => {
  const configs = validateTelegramStartupConfig();
  const config = configs.find((candidate) => candidate.kind === botKind);
  if (!config || config.mode !== 'polling') return;
  if (telegramRuntimeStates[botKind].running) return;

  const definition = TELEGRAM_POLLING_DEFINITIONS[botKind];
  const token = process.env[definition.tokenEnvironmentKey]?.trim();
  if (!token) {
    throw new Error(`${definition.tokenEnvironmentKey} is required in polling mode`);
  }

  telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
    telegramRuntimeStates[botKind],
    { type: 'started' }
  );

  let offset: number | null = null;
  let lastUpdateAt: string | null = null;
  let attempt = 0;

  const poll = async () => {
    const currentAttempt = (attempt += 1);
    const startedAt = Date.now();
    const attemptedAt = new Date(startedAt).toISOString();
    let statusCode: number | null = null;
    telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
      telegramRuntimeStates[botKind],
      { type: 'attempt', at: attemptedAt }
    );

    try {
      const botInstanceKey = getTelegramBotInstanceKey(botKind);
      if (offset === null) {
        const cursor = await loadTelegramUpdateCursor(botKind, botInstanceKey);
        offset = cursor.offset;
        lastUpdateAt = cursor.lastUpdateAt;
      }
      if (shouldResetTelegramUpdateOffset(offset, lastUpdateAt)) {
        if (!(await resetTelegramUpdateOffset(botKind, botInstanceKey))) {
          throw new TelegramPollingError('offset_reset_failed');
        }
        offset = 0;
        lastUpdateAt = null;
      }
      const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`;
      const response = await resilientFetch(
        url,
        { dispatcher: getTelegramOutboundDispatcher() },
        {
          circuitKey: `telegram:poll_updates:${botKind}`,
          timeoutMs: 45_000,
          maxRetries: 1
        }
      );
      statusCode = response.status;
      const payload = await response.json().catch(() => null);
      const updates = parsePollingResponse(response.status, payload);

      for (const update of updates) {
        const nextOffset = Math.max(offset, update.update_id + 1);
        await processTelegramUpdateDurably(botKind, update, nextOffset);
        offset = nextOffset;
        lastUpdateAt = new Date().toISOString();
      }

      telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
        telegramRuntimeStates[botKind],
        { type: 'success', at: new Date().toISOString() }
      );
    } catch (error) {
      const errorCode = safePollingErrorCode(error);
      telegramRuntimeStates[botKind] = reduceTelegramRuntimeState(
        telegramRuntimeStates[botKind],
        { type: 'failure', at: new Date().toISOString(), errorCode }
      );
      void logIntegrationEvent({
        provider: 'telegram',
        operation: definition.operation,
        attempt: currentAttempt,
        statusCode,
        latencyMs: Date.now() - startedAt,
        fallbackUsed: false,
        error: errorCode
      });
    } finally {
      setTimeout(poll, 1000);
    }
  };

  void poll();
};

export const startTelegramPolling = () => startTelegramPollingForBot('main');

export const startTelegramOrderPolling = () => startTelegramPollingForBot('orders');

export const startTelegramB2BPolling = () => startTelegramPollingForBot('b2b');

export { TelegramDeliveryError, sendTelegramPartToChat };
export type { TelegramBotKind };
