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

type TelegramConfig = {
  token: string;
};

type TelegramDocumentInput = {
  bytes: Uint8Array;
  fileName: string;
  mimeType?: string;
};

type TelegramError = {
  ok: boolean;
  error_code?: number;
  description?: string;
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

type UpdateProcessorOptions = {
  upsertSubscriber: (input: TelegramSubscriberInput) => Promise<unknown>;
  deactivateSubscriber: (chatId: string) => Promise<unknown>;
  sendWelcomeMessage: (chatId: string) => Promise<void>;
  sendStopMessage: (chatId: string) => Promise<void>;
};

const getTelegramConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram is not configured');
  }
  return { token };
};

const getTelegramOrdersConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_ORDERS_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram orders bot is not configured');
  }
  return { token };
};

const getTelegramB2BConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_B2B_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram B2B bot is not configured');
  }
  return { token };
};

async function sendToChat(token: string, chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as TelegramError | null;
    const description = payload?.description ?? 'Failed to send telegram message';
    const error = new Error(description);
    (error as Error & { errorCode?: number }).errorCode = payload?.error_code;
    throw error;
  }
}

async function sendDocumentToChat(
  token: string,
  chatId: string,
  document: TelegramDocumentInput,
  caption?: string
) {
  const payload = new FormData();
  payload.append('chat_id', chatId);
  const normalizedBytes = new Uint8Array(document.bytes.byteLength);
  normalizedBytes.set(document.bytes);
  payload.append(
    'document',
    new Blob([normalizedBytes], {
      type: document.mimeType ?? 'application/octet-stream'
    }),
    document.fileName
  );
  if (caption) {
    payload.append('caption', caption);
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: 'POST',
    body: payload
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as TelegramError | null;
    const description = data?.description ?? 'Failed to send telegram document';
    const error = new Error(description);
    (error as Error & { errorCode?: number }).errorCode = data?.error_code;
    throw error;
  }
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

export const handleTelegramUpdate = async (update: unknown) => {
  await processTelegramUpdate(update, {
    upsertSubscriber: upsertTelegramSubscriber,
    deactivateSubscriber: deactivateTelegramSubscriber,
    sendWelcomeMessage,
    sendStopMessage
  });
};

export const handleTelegramOrderUpdate = async (update: unknown) => {
  await processTelegramUpdate(update, {
    upsertSubscriber: upsertTelegramOrderSubscriber,
    deactivateSubscriber: deactivateTelegramOrderSubscriber,
    sendWelcomeMessage: sendOrdersWelcomeMessage,
    sendStopMessage: sendOrdersStopMessage
  });
};

export const handleTelegramB2BUpdate = async (update: unknown) => {
  await processTelegramUpdate(update, {
    upsertSubscriber: upsertTelegramB2BSubscriber,
    deactivateSubscriber: deactivateTelegramB2BSubscriber,
    sendWelcomeMessage: sendB2BWelcomeMessage,
    sendStopMessage: sendB2BStopMessage
  });
};

export const sendTelegramMessage = async (text: string) => {
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
        successCount += 1;
      } catch (error) {
        const err = error instanceof Error ? error : new Error('Failed to send');
        const errorCode = (err as Error & { errorCode?: number }).errorCode;
        if (errorCode === 403 || err.message.includes('blocked')) {
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
        const err = error instanceof Error ? error : new Error('Failed to send');
        const errorCode = (err as Error & { errorCode?: number }).errorCode;
        if (errorCode === 403 || err.message.includes('blocked')) {
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
        const err = error instanceof Error ? error : new Error('Failed to send');
        const errorCode = (err as Error & { errorCode?: number }).errorCode;
        if (errorCode === 403 || err.message.includes('blocked')) {
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

export const startTelegramPolling = () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return;
  }

  const pollingEnabled = process.env.TELEGRAM_POLLING === 'true';
  if (!pollingEnabled) {
    return;
  }

  let offset = 0;

  const poll = async () => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`
      );
      const data = (await response.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number } & Record<string, unknown>>;
      };

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          await handleTelegramUpdate(update);
        }
      }
    } catch {
      // ignore polling errors, retry on next tick
    } finally {
      setTimeout(poll, 1000);
    }
  };

  poll();
};

export const startTelegramOrderPolling = () => {
  const token = process.env.TELEGRAM_ORDERS_BOT_TOKEN;
  if (!token) {
    return;
  }

  const pollingEnabled = process.env.TELEGRAM_ORDERS_POLLING === 'true';
  if (!pollingEnabled) {
    return;
  }

  let offset = 0;

  const poll = async () => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`
      );
      const data = (await response.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number } & Record<string, unknown>>;
      };

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          await handleTelegramOrderUpdate(update);
        }
      }
    } catch {
      // ignore polling errors, retry on next tick
    } finally {
      setTimeout(poll, 1000);
    }
  };

  poll();
};

export const startTelegramB2BPolling = () => {
  const token = process.env.TELEGRAM_B2B_BOT_TOKEN;
  if (!token) {
    return;
  }

  const pollingEnabled = process.env.TELEGRAM_B2B_POLLING === 'true';
  if (!pollingEnabled) {
    return;
  }

  let offset = 0;

  const poll = async () => {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`
      );
      const data = (await response.json()) as {
        ok: boolean;
        result?: Array<{ update_id: number } & Record<string, unknown>>;
      };

      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          await handleTelegramB2BUpdate(update);
        }
      }
    } catch {
      // ignore polling errors, retry on next tick
    } finally {
      setTimeout(poll, 1000);
    }
  };

  poll();
};
