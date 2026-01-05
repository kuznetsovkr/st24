import { query } from '../db';

export type TelegramSubscriberRow = {
  chat_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  language_code: string | null;
  chat_type: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TelegramSubscriberInput = {
  chatId: string;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  languageCode?: string | null;
  chatType?: string | null;
};

export const upsertTelegramSubscriber = async (
  input: TelegramSubscriberInput
): Promise<TelegramSubscriberRow> => {
  const result = await query(
    `
      INSERT INTO telegram_subscribers (chat_id, username, first_name, last_name, language_code, chat_type, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE)
      ON CONFLICT (chat_id) DO UPDATE
        SET username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            language_code = EXCLUDED.language_code,
            chat_type = EXCLUDED.chat_type,
            is_active = TRUE,
            updated_at = NOW()
      RETURNING chat_id, username, first_name, last_name, language_code, chat_type, is_active, created_at, updated_at;
    `,
    [
      input.chatId,
      input.username ?? null,
      input.firstName ?? null,
      input.lastName ?? null,
      input.languageCode ?? null,
      input.chatType ?? null
    ]
  );

  return result.rows[0] as TelegramSubscriberRow;
};

export const listTelegramSubscribers = async (): Promise<TelegramSubscriberRow[]> => {
  const result = await query(
    `
      SELECT chat_id, username, first_name, last_name, language_code, chat_type, is_active, created_at, updated_at
      FROM telegram_subscribers
      WHERE is_active = TRUE;
    `
  );

  return result.rows as TelegramSubscriberRow[];
};

export const deactivateTelegramSubscriber = async (chatId: string) => {
  await query(
    `
      UPDATE telegram_subscribers
      SET is_active = FALSE,
          updated_at = NOW()
      WHERE chat_id = $1;
    `,
    [chatId]
  );
};
