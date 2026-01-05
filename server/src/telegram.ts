import { deactivateTelegramSubscriber, listTelegramSubscribers, upsertTelegramSubscriber } from './db/telegram';

type TelegramConfig = {
  token: string;
};

type TelegramError = {
  ok: boolean;
  error_code?: number;
  description?: string;
};

const getTelegramConfig = (): TelegramConfig => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('Telegram is not configured');
  }
  return { token };
};

const sendWelcomeMessage = async (chatId: string) => {
  const { token } = getTelegramConfig();
  const text = [
    '👋 Привет! Вы подписались на заявки «Нужна деталь».',
    '✅ Сообщения будут приходить в этот чат.',
    '🛑 Чтобы отключить уведомления, отправьте /stop.'
  ].join('\n');
  await sendToChat(token, chatId, text);
};

const sendStopMessage = async (chatId: string) => {
  const { token } = getTelegramConfig();
  const text = ['🔕 Уведомления отключены.', '↩️ Чтобы включить снова, отправьте /start.'].join(
    '\n'
  );
  await sendToChat(token, chatId, text);
};

export const handleTelegramUpdate = async (update: unknown) => {
  const payload = (update ?? {}) as {
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
      await upsertTelegramSubscriber({
        chatId,
        username,
        firstName,
        lastName,
        languageCode,
        chatType
      });
      try {
        await sendWelcomeMessage(chatId);
      } catch {
        // ignore welcome send errors
      }
    }

    if (text.startsWith('/stop')) {
      await deactivateTelegramSubscriber(chatId);
      try {
        await sendStopMessage(chatId);
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
      await deactivateTelegramSubscriber(chatId);
    } else if (status === 'member' || status === 'administrator' || status === 'creator') {
      await upsertTelegramSubscriber({
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
