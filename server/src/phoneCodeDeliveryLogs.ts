import { randomUUID } from 'crypto';
import { withClient } from './db';

type PhoneCodeDeliveryStatus = 'sent' | 'failed';

type PhoneCodeDeliveryLogInput = {
  phone: string;
  channel: string;
  context: string;
  status: PhoneCodeDeliveryStatus;
  preferredChannel?: string | null;
  fallbackUsed?: boolean;
  providerRequestId?: string | null;
  providerMessageId?: string | null;
  error?: string | null;
  ip?: string | null;
};

const normalizePhone = (value: string) => value.replace(/\D/g, '');

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const trimToNull = (value?: string | null) => trimToUndefined(value) ?? null;

const normalizeStatus = (value: PhoneCodeDeliveryStatus) => (value === 'sent' ? 'sent' : 'failed');

const normalizeErrorText = (value?: string | null) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 3997)}...` : trimmed;
};

export const logPhoneCodeDeliveryEvent = async (input: PhoneCodeDeliveryLogInput) => {
  const phone = normalizePhone(input.phone);
  if (!phone) {
    return;
  }

  const channel = trimToUndefined(input.channel) ?? 'unknown';
  const context = trimToUndefined(input.context) ?? 'unknown';
  const status = normalizeStatus(input.status);
  const action = `${status}_${channel}`;
  const eventAt = new Date().toISOString();

  const telegramSentIncrement = status === 'sent' && channel === 'telegram_gateway' ? 1 : 0;
  const smsSentIncrement = status === 'sent' && channel === 'sms_ru' ? 1 : 0;

  try {
    await withClient(async (client) => {
      await client.query(
        `
          INSERT INTO phone_code_delivery_events (
            id,
            phone,
            channel,
            context,
            status,
            preferred_channel,
            fallback_used,
            provider_request_id,
            provider_message_id,
            error,
            ip,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz);
        `,
        [
          randomUUID(),
          phone,
          channel,
          context,
          status,
          trimToNull(input.preferredChannel),
          Boolean(input.fallbackUsed),
          trimToNull(input.providerRequestId),
          trimToNull(input.providerMessageId),
          normalizeErrorText(input.error),
          trimToNull(input.ip),
          eventAt
        ]
      );

      await client.query(
        `
          INSERT INTO phone_code_delivery_stats (
            phone,
            telegram_sent_count,
            sms_sent_count,
            last_action,
            last_channel,
            last_context,
            last_event_status,
            last_event_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, NOW(), NOW())
          ON CONFLICT (phone) DO UPDATE
            SET telegram_sent_count = phone_code_delivery_stats.telegram_sent_count + EXCLUDED.telegram_sent_count,
                sms_sent_count = phone_code_delivery_stats.sms_sent_count + EXCLUDED.sms_sent_count,
                last_action = EXCLUDED.last_action,
                last_channel = EXCLUDED.last_channel,
                last_context = EXCLUDED.last_context,
                last_event_status = EXCLUDED.last_event_status,
                last_event_at = EXCLUDED.last_event_at,
                updated_at = NOW();
        `,
        [
          phone,
          telegramSentIncrement,
          smsSentIncrement,
          action,
          channel,
          context,
          status,
          eventAt
        ]
      );
    });
  } catch (error) {
    console.error('Failed to write phone code delivery log', error);
  }
};
