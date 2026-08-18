import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { queryWithTimeout, withClient } from '../db';
import { getTelegramAllowedChatIds } from '../telegramTransport';
import {
  getTelegramOutboxMaxRetryAgeDays,
  getTelegramOutboxRetentionDays
} from '../telegramOutboxConfig';

export type TelegramBotKind = 'main' | 'orders' | 'b2b';
export type TelegramOutboxEventType = 'order_paid' | 'lead_created';
export type TelegramOutboxAggregateType = 'order' | 'lead';
export type TelegramOutboxEventStatus =
  | 'pending'
  | 'processing'
  | 'retry'
  | 'sent'
  | 'dead';
export type TelegramOutboxDeliveryKind = 'text' | 'document';
export type TelegramOutboxDeliveryStatus =
  | 'pending'
  | 'sent'
  | 'skipped'
  | 'dead';

export const TELEGRAM_OUTBOX_ERROR_CODES = [
  'no_targets',
  'config_missing',
  'timeout',
  'network_error',
  'proxy_error',
  'telegram_api_error',
  'telegram_auth_error',
  'telegram_rate_limited',
  'telegram_chat_blocked',
  'telegram_chat_not_found',
  'subscriber_inactive',
  'invalid_payload',
  'attachment_missing',
  'retry_window_expired',
  'lease_lost',
  'max_attempts',
  'unknown_error'
] as const;

export type TelegramOutboxErrorCode =
  (typeof TELEGRAM_OUTBOX_ERROR_CODES)[number];

export type TelegramOutboxPayloadV1 = {
  version: 1;
  text: string;
};

export type TelegramOutboxEventRow = {
  id: string;
  event_key: string;
  event_type: TelegramOutboxEventType;
  bot_kind: TelegramBotKind;
  aggregate_type: TelegramOutboxAggregateType;
  aggregate_id: string;
  payload_version: number;
  payload: TelegramOutboxPayloadV1;
  payload_scrubbed_at: string | null;
  attachment_count: number;
  attachments_expired_at: string | null;
  retry_expires_at: string;
  deliveries_expired_at: string | null;
  terminal_delivery_count: number | null;
  terminal_sent_part_count: number | null;
  status: TelegramOutboxEventStatus;
  attempt_count: number;
  next_attempt_at: string;
  lease_owner: string | null;
  lease_until: string | null;
  target_count: number;
  last_error_code: TelegramOutboxErrorCode | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TelegramOutboxAttachmentRow = {
  id: string;
  event_id: string;
  part_no: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  bytes: Buffer;
  created_at: string;
};

export type TelegramOutboxDeliveryRow = {
  event_id: string;
  chat_id: string;
  part_no: number;
  delivery_kind: TelegramOutboxDeliveryKind;
  status: TelegramOutboxDeliveryStatus;
  attempt_count: number;
  next_attempt_at: string;
  telegram_message_id: string | null;
  last_error_code: TelegramOutboxErrorCode | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TelegramOutboxBundle = {
  event: TelegramOutboxEventRow;
  attachments: TelegramOutboxAttachmentRow[];
  deliveries: TelegramOutboxDeliveryRow[];
};

export type TelegramOutboxAttachmentInput = {
  bytes: Buffer | Uint8Array;
  fileName: string;
  mimeType?: string | null;
};

export type EnqueueTelegramOutboxEventInput = {
  eventKey: string;
  eventType: TelegramOutboxEventType;
  botKind: TelegramBotKind;
  aggregateType: TelegramOutboxAggregateType;
  aggregateId: string;
  payload: TelegramOutboxPayloadV1;
  attachments?: TelegramOutboxAttachmentInput[];
};

export type EnqueueTelegramOutboxEventResult = {
  event: TelegramOutboxEventRow;
  created: boolean;
};

const EVENT_SELECT_FIELDS = `
  id,
  event_key,
  event_type,
  bot_kind,
  aggregate_type,
  aggregate_id,
  payload_version,
  payload,
  payload_scrubbed_at,
  attachment_count,
  attachments_expired_at,
  retry_expires_at,
  deliveries_expired_at,
  terminal_delivery_count,
  terminal_sent_part_count,
  status,
  attempt_count,
  next_attempt_at,
  lease_owner,
  lease_until,
  target_count,
  last_error_code,
  sent_at,
  created_at,
  updated_at
`;

const ATTACHMENT_SELECT_FIELDS = `
  id,
  event_id,
  part_no,
  file_name,
  mime_type,
  size_bytes,
  bytes,
  created_at
`;

const DELIVERY_SELECT_FIELDS = `
  event_id,
  chat_id::text AS chat_id,
  part_no,
  delivery_kind,
  status,
  attempt_count,
  next_attempt_at,
  telegram_message_id::text AS telegram_message_id,
  last_error_code,
  sent_at,
  created_at,
  updated_at
`;

const subscriberTables: Record<TelegramBotKind, string> = {
  main: 'telegram_subscribers',
  orders: 'telegram_order_subscribers',
  b2b: 'telegram_b2b_subscribers'
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_KEY_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,159}$/;
const INTEGER_TEXT_PATTERN = /^\d+$/;
const POSITIVE_INTEGER_TEXT_PATTERN = /^[1-9]\d*$/;
const CHAT_ID_PATTERN = /^-?[1-9]\d*$/;

const assertUuid = (value: string, field: string) => {
  if (!UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
};

const assertEventShape = (input: EnqueueTelegramOutboxEventInput) => {
  if (!EVENT_KEY_PATTERN.test(input.eventKey)) {
    throw new Error('Invalid eventKey');
  }
  assertUuid(input.aggregateId, 'aggregateId');

  const isOrderEvent =
    input.eventType === 'order_paid' &&
    input.botKind === 'orders' &&
    input.aggregateType === 'order';
  const isLeadEvent =
    input.eventType === 'lead_created' &&
    (input.botKind === 'main' || input.botKind === 'b2b') &&
    input.aggregateType === 'lead';
  if (!isOrderEvent && !isLeadEvent) {
    throw new Error('Invalid outbox event routing');
  }

  if (
    input.payload.version !== 1 ||
    typeof input.payload.text !== 'string' ||
    input.payload.text.length === 0 ||
    input.payload.text.length > 1_000_000
  ) {
    throw new Error('Invalid outbox payload');
  }
};

const normalizeTelegramText = (value: string) =>
  value.length <= 4_096 ? value : `${value.slice(0, 4_095)}…`;

const normalizeFileName = (value: string, partNo: number) => {
  const rawBaseName = value.split(/[\\/]/).pop();
  const baseName = rawBaseName
    ? [...rawBaseName]
        .map((character) => {
          const code = character.charCodeAt(0);
          return code < 32 || code === 127 ? '_' : character;
        })
        .join('')
        .trim()
    : undefined;
  return (baseName || `attachment-${partNo}`).slice(0, 255);
};

const normalizeMimeType = (value?: string | null) => {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized &&
    normalized.length <= 127 &&
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
  ) {
    return normalized;
  }
  return 'application/octet-stream';
};

const assertWorkerOwner = (owner: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(owner)) {
    throw new Error('Invalid outbox worker owner');
  }
};

const assertDelay = (value: number, field: string, maximum: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`Invalid ${field}`);
  }
};

const assertBigIntText = (value: string, field: string) => {
  if (!INTEGER_TEXT_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
};

const assertPositiveBigIntText = (value: string, field: string) => {
  if (!POSITIVE_INTEGER_TEXT_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
};

const assertChatId = (value: string) => {
  if (!CHAT_ID_PATTERN.test(value)) {
    throw new Error('Invalid chatId');
  }
};

const seedDeliveries = async (
  client: PoolClient,
  eventId: string,
  botKind: TelegramBotKind
) => {
  const subscriberTable = subscriberTables[botKind];
  const allowedChatIds = getTelegramAllowedChatIds(botKind);
  const insertResult = await client.query(
    `
      INSERT INTO telegram_outbox_deliveries (
        event_id,
        chat_id,
        part_no,
        delivery_kind
      )
      SELECT $1,
             subscribers.chat_id,
             parts.part_no,
             parts.delivery_kind
      FROM ${subscriberTable} AS subscribers
      CROSS JOIN (
        SELECT 0 AS part_no, 'text'::text AS delivery_kind
        UNION ALL
        SELECT attachments.part_no, 'document'::text AS delivery_kind
        FROM telegram_outbox_attachments AS attachments
        WHERE attachments.event_id = $1
      ) AS parts
      WHERE subscribers.is_active = TRUE
        AND subscribers.chat_id = ANY($2::bigint[])
      ON CONFLICT (event_id, chat_id, part_no) DO NOTHING;
    `,
    [eventId, allowedChatIds]
  );

  const countResult = await client.query(
    `
      UPDATE telegram_outbox_events
      SET target_count = (
            SELECT COUNT(DISTINCT deliveries.chat_id)::int
            FROM telegram_outbox_deliveries AS deliveries
            WHERE deliveries.event_id = $1
          ),
          updated_at = NOW()
      WHERE id = $1
      RETURNING target_count;
    `,
    [eventId]
  );

  return {
    insertedDeliveryCount: insertResult.rowCount ?? 0,
    targetCount: Number(countResult.rows[0]?.target_count ?? 0)
  };
};

/**
 * The caller must pass a PoolClient whose surrounding business transaction
 * owns BEGIN/COMMIT. The event, recipient snapshot and aggregate marker are
 * then committed atomically with the business change.
 */
export const enqueueTelegramOutboxEvent = async (
  client: PoolClient,
  input: EnqueueTelegramOutboxEventInput
): Promise<EnqueueTelegramOutboxEventResult> => {
  assertEventShape(input);
  const normalizedPayload: TelegramOutboxPayloadV1 = {
    version: 1,
    text: normalizeTelegramText(input.payload.text)
  };

  const attachments = input.attachments ?? [];
  if (attachments.length > 3) {
    throw new Error('Too many outbox attachments');
  }
  let totalAttachmentBytes = 0;
  for (const attachment of attachments) {
    const size = attachment.bytes.byteLength;
    if (size > 15 * 1024 * 1024) {
      throw new Error('Outbox attachment is too large');
    }
    totalAttachmentBytes += size;
  }
  if (totalAttachmentBytes > 20 * 1024 * 1024) {
    throw new Error('Outbox attachments are too large');
  }

  const eventId = randomUUID();
  const insertResult = await client.query(
    `
      INSERT INTO telegram_outbox_events (
        id,
        event_key,
        event_type,
        bot_kind,
        aggregate_type,
        aggregate_id,
        payload_version,
        payload,
        attachment_count,
        retry_expires_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9,
        NOW() + ($10::int * INTERVAL '1 day')
      )
      ON CONFLICT (event_key) DO NOTHING
      RETURNING ${EVENT_SELECT_FIELDS};
    `,
    [
      eventId,
      input.eventKey,
      input.eventType,
      input.botKind,
      input.aggregateType,
      input.aggregateId,
      normalizedPayload.version,
      JSON.stringify(normalizedPayload),
      attachments.length,
      getTelegramOutboxMaxRetryAgeDays()
    ]
  );

  const createdEvent = insertResult.rows[0] as
    | TelegramOutboxEventRow
    | undefined;
  if (!createdEvent) {
    const existingResult = await client.query(
      `
        SELECT ${EVENT_SELECT_FIELDS}
        FROM telegram_outbox_events
        WHERE event_key = $1;
      `,
      [input.eventKey]
    );
    const existing = existingResult.rows[0] as
      | TelegramOutboxEventRow
      | undefined;
    if (
      !existing ||
      existing.event_type !== input.eventType ||
      existing.bot_kind !== input.botKind ||
      existing.aggregate_type !== input.aggregateType ||
      existing.aggregate_id !== input.aggregateId ||
      existing.attachment_count !== attachments.length
    ) {
      throw new Error('Outbox event key collision');
    }

    if (input.eventType === 'order_paid') {
      const markerResult = await client.query(
        `
          UPDATE orders
          SET telegram_notification_required_at =
                COALESCE(telegram_notification_required_at, NOW()),
              updated_at = NOW()
          WHERE id = $1;
        `,
        [input.aggregateId]
      );
      if ((markerResult.rowCount ?? 0) !== 1) {
        throw new Error('Outbox aggregate does not exist');
      }
    } else {
      const aggregateResult = await client.query(
        `SELECT 1 FROM lead_requests WHERE id = $1;`,
        [input.aggregateId]
      );
      if ((aggregateResult.rowCount ?? 0) !== 1) {
        throw new Error('Outbox aggregate does not exist');
      }
    }
    return { event: existing, created: false };
  }

  for (const [index, attachment] of attachments.entries()) {
    const partNo = index + 1;
    const bytes = Buffer.from(attachment.bytes);
    await client.query(
      `
        INSERT INTO telegram_outbox_attachments (
          id,
          event_id,
          part_no,
          file_name,
          mime_type,
          size_bytes,
          bytes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      [
        randomUUID(),
        eventId,
        partNo,
        normalizeFileName(attachment.fileName, partNo),
        normalizeMimeType(attachment.mimeType),
        bytes.byteLength,
        bytes
      ]
    );
  }

  await seedDeliveries(client, eventId, input.botKind);

  if (input.eventType === 'order_paid') {
    const markerResult = await client.query(
      `
        UPDATE orders
        SET telegram_notification_required_at =
              COALESCE(telegram_notification_required_at, NOW()),
            updated_at = NOW()
        WHERE id = $1;
      `,
      [input.aggregateId]
    );
    if ((markerResult.rowCount ?? 0) !== 1) {
      throw new Error('Outbox aggregate does not exist');
    }
  } else {
    const markerResult = await client.query(
      `
        UPDATE lead_requests
        SET telegram_status = 'pending',
            telegram_error = NULL,
            updated_at = NOW()
        WHERE id = $1;
      `,
      [input.aggregateId]
    );
    if ((markerResult.rowCount ?? 0) !== 1) {
      throw new Error('Outbox aggregate does not exist');
    }
  }

  const refreshedResult = await client.query(
    `
      SELECT ${EVENT_SELECT_FIELDS}
      FROM telegram_outbox_events
      WHERE id = $1;
    `,
    [eventId]
  );
  return {
    event: refreshedResult.rows[0] as TelegramOutboxEventRow,
    created: true
  };
};

export const claimNextTelegramOutboxEvent = async (
  owner: string,
  leaseMs: number
): Promise<TelegramOutboxEventRow | null> => {
  assertWorkerOwner(owner);
  assertDelay(leaseMs, 'leaseMs', 86_400_000);
  if (leaseMs === 0) {
    throw new Error('Invalid leaseMs');
  }

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          WITH candidate AS (
            SELECT id AS candidate_id
            FROM telegram_outbox_events
            WHERE (
                (
                  status IN ('pending', 'retry')
                  AND (
                    next_attempt_at <= NOW()
                    OR retry_expires_at <= NOW()
                  )
                )
                OR (
                  status = 'processing'
                  AND lease_until <= NOW()
                )
              )
              AND NOT EXISTS (
                SELECT 1
                FROM telegram_outbox_acknowledgements AS acknowledgements
                WHERE acknowledgements.event_id = telegram_outbox_events.id
              )
            ORDER BY
              CASE WHEN retry_expires_at <= NOW() THEN 0 ELSE 1 END ASC,
              CASE WHEN status = 'processing' THEN lease_until ELSE next_attempt_at END ASC,
              created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE telegram_outbox_events AS events
          SET status = 'processing',
              attempt_count = events.attempt_count + 1,
              lease_owner = $1,
              lease_until = NOW() + ($2::int * INTERVAL '1 millisecond'),
              updated_at = NOW()
          FROM candidate
          WHERE events.id = candidate.candidate_id
          RETURNING ${EVENT_SELECT_FIELDS};
        `,
        [owner, leaseMs]
      );
      await client.query('COMMIT');
      return (
        (result.rows[0] as TelegramOutboxEventRow | undefined) ?? null
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const extendTelegramOutboxLease = async (
  eventId: string,
  owner: string,
  leaseMs: number
): Promise<boolean> => {
  assertUuid(eventId, 'eventId');
  assertWorkerOwner(owner);
  assertDelay(leaseMs, 'leaseMs', 86_400_000);
  if (leaseMs === 0) {
    throw new Error('Invalid leaseMs');
  }

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_events
        SET lease_until = GREATEST(
              lease_until,
              NOW() + ($3::int * INTERVAL '1 millisecond')
            ),
            updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_until > NOW()
          AND retry_expires_at > NOW()
        RETURNING id;
      `,
      [eventId, owner, leaseMs]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const findTelegramOutboxEventById = async (
  eventId: string
): Promise<TelegramOutboxEventRow | null> => {
  assertUuid(eventId, 'eventId');
  return withClient(async (client) => {
    const result = await client.query(
      `
        SELECT ${EVENT_SELECT_FIELDS}
        FROM telegram_outbox_events
        WHERE id = $1;
      `,
      [eventId]
    );
    return (
      (result.rows[0] as TelegramOutboxEventRow | undefined) ?? null
    );
  });
};

export const listTelegramOutboxAttachments = async (
  eventId: string
): Promise<TelegramOutboxAttachmentRow[]> => {
  assertUuid(eventId, 'eventId');
  return withClient(async (client) => {
    const result = await client.query(
      `
        SELECT ${ATTACHMENT_SELECT_FIELDS}
        FROM telegram_outbox_attachments
        WHERE event_id = $1
        ORDER BY part_no ASC;
      `,
      [eventId]
    );
    return result.rows as TelegramOutboxAttachmentRow[];
  });
};

export const listTelegramOutboxDeliveries = async (
  eventId: string
): Promise<TelegramOutboxDeliveryRow[]> => {
  assertUuid(eventId, 'eventId');
  return withClient(async (client) => {
    const result = await client.query(
      `
        SELECT ${DELIVERY_SELECT_FIELDS}
        FROM telegram_outbox_deliveries
        WHERE event_id = $1
        ORDER BY chat_id ASC, part_no ASC;
      `,
      [eventId]
    );
    return result.rows as TelegramOutboxDeliveryRow[];
  });
};

export const loadTelegramOutboxEvent = async (
  eventId: string
): Promise<TelegramOutboxBundle | null> => {
  assertUuid(eventId, 'eventId');
  return withClient(async (client) => {
    const eventResult = await client.query(
      `
        SELECT ${EVENT_SELECT_FIELDS}
        FROM telegram_outbox_events
        WHERE id = $1;
      `,
      [eventId]
    );
    const event = eventResult.rows[0] as
      | TelegramOutboxEventRow
      | undefined;
    if (!event) {
      return null;
    }

    const attachmentResult = await client.query(
      `
        SELECT ${ATTACHMENT_SELECT_FIELDS}
        FROM telegram_outbox_attachments
        WHERE event_id = $1
        ORDER BY part_no ASC;
      `,
      [eventId]
    );
    const deliveryResult = await client.query(
      `
        SELECT ${DELIVERY_SELECT_FIELDS}
        FROM telegram_outbox_deliveries
        WHERE event_id = $1
        ORDER BY chat_id ASC, part_no ASC;
      `,
      [eventId]
    );

    return {
      event,
      attachments:
        attachmentResult.rows as TelegramOutboxAttachmentRow[],
      deliveries: deliveryResult.rows as TelegramOutboxDeliveryRow[]
    };
  });
};

type TelegramOutboxDeliveryMutationInput = {
  eventId: string;
  owner: string;
  chatId: string;
  partNo: number;
};

type TelegramOutboxDeliveryFailureInput =
  TelegramOutboxDeliveryMutationInput & {
    errorCode: TelegramOutboxErrorCode;
  };

const validateDeliveryMutation = (
  input: TelegramOutboxDeliveryMutationInput
) => {
  assertUuid(input.eventId, 'eventId');
  assertWorkerOwner(input.owner);
  assertChatId(input.chatId);
  if (!Number.isSafeInteger(input.partNo) || input.partNo < 0) {
    throw new Error('Invalid partNo');
  }
};

export const markTelegramOutboxDeliverySent = async (
  input: TelegramOutboxDeliveryMutationInput & {
    telegramMessageId: string | number;
  }
): Promise<boolean> => {
  validateDeliveryMutation(input);
  const telegramMessageId = String(input.telegramMessageId);
  assertPositiveBigIntText(telegramMessageId, 'telegramMessageId');

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_deliveries AS deliveries
        SET status = 'sent',
            attempt_count = deliveries.attempt_count + 1,
            telegram_message_id = $5::bigint,
            last_error_code = NULL,
            sent_at = NOW(),
            updated_at = NOW()
        FROM telegram_outbox_events AS events
        WHERE deliveries.event_id = $1
          AND deliveries.chat_id = $3::bigint
          AND deliveries.part_no = $4
          AND deliveries.status = 'pending'
          AND events.id = deliveries.event_id
          AND events.status = 'processing'
          AND events.lease_owner = $2
          AND events.lease_until > NOW()
        RETURNING deliveries.event_id;
      `,
      [
        input.eventId,
        input.owner,
        input.chatId,
        input.partNo,
        telegramMessageId
      ]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const markTelegramOutboxDeliverySkipped = async (
  input: TelegramOutboxDeliveryFailureInput
): Promise<boolean> => {
  validateDeliveryMutation(input);

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_deliveries AS deliveries
        SET status = 'skipped',
            attempt_count = deliveries.attempt_count + 1,
            telegram_message_id = NULL,
            last_error_code = $5,
            updated_at = NOW()
        FROM telegram_outbox_events AS events
        WHERE deliveries.event_id = $1
          AND deliveries.chat_id = $3::bigint
          AND deliveries.part_no = $4
          AND deliveries.status = 'pending'
          AND events.id = deliveries.event_id
          AND events.status = 'processing'
          AND events.lease_owner = $2
          AND events.lease_until > NOW()
        RETURNING deliveries.event_id;
      `,
      [
        input.eventId,
        input.owner,
        input.chatId,
        input.partNo,
        input.errorCode
      ]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const markTelegramOutboxDeliveryRetry = async (
  input: TelegramOutboxDeliveryFailureInput & { retryAfterMs: number }
): Promise<boolean> => {
  validateDeliveryMutation(input);
  assertDelay(input.retryAfterMs, 'retryAfterMs', 604_800_000);

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_deliveries AS deliveries
        SET status = 'pending',
            attempt_count = deliveries.attempt_count + 1,
            telegram_message_id = NULL,
            last_error_code = $5,
            next_attempt_at =
              NOW() + ($6::int * INTERVAL '1 millisecond'),
            updated_at = NOW()
        FROM telegram_outbox_events AS events
        WHERE deliveries.event_id = $1
          AND deliveries.chat_id = $3::bigint
          AND deliveries.part_no = $4
          AND deliveries.status = 'pending'
          AND events.id = deliveries.event_id
          AND events.status = 'processing'
          AND events.lease_owner = $2
          AND events.lease_until > NOW()
        RETURNING deliveries.event_id;
      `,
      [
        input.eventId,
        input.owner,
        input.chatId,
        input.partNo,
        input.errorCode,
        input.retryAfterMs
      ]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const markTelegramOutboxDeliveryDead = async (
  input: TelegramOutboxDeliveryFailureInput
): Promise<boolean> => {
  validateDeliveryMutation(input);

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_deliveries AS deliveries
        SET status = 'dead',
            attempt_count = deliveries.attempt_count + 1,
            telegram_message_id = NULL,
            last_error_code = $5,
            updated_at = NOW()
        FROM telegram_outbox_events AS events
        WHERE deliveries.event_id = $1
          AND deliveries.chat_id = $3::bigint
          AND deliveries.part_no = $4
          AND deliveries.status = 'pending'
          AND events.id = deliveries.event_id
          AND events.status = 'processing'
          AND events.lease_owner = $2
          AND events.lease_until > NOW()
        RETURNING deliveries.event_id;
      `,
      [
        input.eventId,
        input.owner,
        input.chatId,
        input.partNo,
        input.errorCode
      ]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

const updateAggregateAfterSent = async (
  client: PoolClient,
  event: TelegramOutboxEventRow
) => {
  if (event.aggregate_type === 'order') {
    await client.query(
      `
        UPDATE orders
        SET telegram_notified_at = COALESCE(telegram_notified_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
          AND telegram_notification_required_at IS NOT NULL;
      `,
      [event.aggregate_id]
    );
    return;
  }

  await client.query(
    `
      UPDATE lead_requests
      SET telegram_status = 'sent',
          telegram_error = NULL,
          telegram_sent_at = COALESCE(telegram_sent_at, NOW()),
          updated_at = NOW()
      WHERE id = $1;
    `,
    [event.aggregate_id]
  );
};

const updateAggregateAfterDead = async (
  client: PoolClient,
  event: TelegramOutboxEventRow,
  errorCode: TelegramOutboxErrorCode
) => {
  if (event.aggregate_type === 'order') {
    await client.query(
      `
        UPDATE orders
        SET telegram_notification_required_at =
              COALESCE(telegram_notification_required_at, NOW()),
            updated_at = NOW()
        WHERE id = $1;
      `,
      [event.aggregate_id]
    );
    return;
  }

  await client.query(
    `
      UPDATE lead_requests
      SET telegram_status = 'failed',
          telegram_error = $2,
          updated_at = NOW()
      WHERE id = $1;
    `,
    [event.aggregate_id, errorCode]
  );
};

const lockOwnedEvent = async (
  client: PoolClient,
  eventId: string,
  owner: string
) => {
  const result = await client.query(
    `
      SELECT ${EVENT_SELECT_FIELDS}
      FROM telegram_outbox_events
      WHERE id = $1
        AND status = 'processing'
        AND lease_owner = $2
        AND lease_until > NOW()
      FOR UPDATE;
    `,
    [eventId, owner]
  );
  return (
    (result.rows[0] as TelegramOutboxEventRow | undefined) ?? null
  );
};

export const finalizeTelegramOutboxEventSent = async (
  eventId: string,
  owner: string
): Promise<boolean> => {
  assertUuid(eventId, 'eventId');
  assertWorkerOwner(owner);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const event = await lockOwnedEvent(client, eventId, owner);
      if (!event) {
        await client.query('COMMIT');
        return false;
      }

      const deliveryStateResult = await client.query(
        `
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending')::int
              AS pending_count,
            COUNT(*) FILTER (WHERE status = 'dead')::int
              AS dead_count,
            (
              SELECT COUNT(*)::int
              FROM (
                SELECT chat_id
                FROM telegram_outbox_deliveries
                WHERE event_id = $1
                GROUP BY chat_id
                HAVING BOOL_AND(status = 'sent')
              ) AS fully_sent_targets
            ) AS fully_sent_target_count
          FROM telegram_outbox_deliveries
          WHERE event_id = $1;
        `,
        [eventId]
      );
      const deliveryState = deliveryStateResult.rows[0];
      const canFinalize =
        Number(deliveryState?.pending_count ?? 0) === 0 &&
        Number(deliveryState?.dead_count ?? 0) === 0 &&
        Number(deliveryState?.fully_sent_target_count ?? 0) > 0;
      if (!canFinalize) {
        await client.query('COMMIT');
        return false;
      }

      const result = await client.query(
        `
          UPDATE telegram_outbox_events
          SET status = 'sent',
              lease_owner = NULL,
              lease_until = NULL,
              last_error_code = NULL,
              attachments_expired_at = CASE
                WHEN attachment_count > 0
                  THEN COALESCE(attachments_expired_at, NOW())
                ELSE attachments_expired_at
              END,
              sent_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $2
          RETURNING ${EVENT_SELECT_FIELDS};
        `,
        [eventId, owner]
      );
      const finalized = result.rows[0] as
        | TelegramOutboxEventRow
        | undefined;
      if (!finalized) {
        await client.query('ROLLBACK');
        return false;
      }

      await updateAggregateAfterSent(client, finalized);
      await client.query(
        `
          DELETE FROM telegram_outbox_attachments
          WHERE event_id = $1;
        `,
        [eventId]
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const finalizeTelegramOutboxEventRetry = async (
  eventId: string,
  owner: string,
  errorCode: TelegramOutboxErrorCode,
  retryAfterMs: number
): Promise<boolean> => {
  assertUuid(eventId, 'eventId');
  assertWorkerOwner(owner);
  assertDelay(retryAfterMs, 'retryAfterMs', 604_800_000);

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_outbox_events
        SET status = 'retry',
            next_attempt_at =
              NOW() + ($4::int * INTERVAL '1 millisecond'),
            lease_owner = NULL,
            lease_until = NULL,
            last_error_code = $3,
            updated_at = NOW()
        WHERE id = $1
          AND status = 'processing'
          AND lease_owner = $2
          AND lease_until > NOW()
        RETURNING id;
      `,
      [eventId, owner, errorCode, retryAfterMs]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const finalizeTelegramOutboxEventDead = async (
  eventId: string,
  owner: string,
  errorCode: TelegramOutboxErrorCode
): Promise<boolean> => {
  assertUuid(eventId, 'eventId');
  assertWorkerOwner(owner);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const event = await lockOwnedEvent(client, eventId, owner);
      if (!event) {
        await client.query('COMMIT');
        return false;
      }

      await client.query(
        `
          UPDATE telegram_outbox_deliveries
          SET status = 'dead',
              last_error_code = COALESCE(last_error_code, $2),
              updated_at = NOW()
          WHERE event_id = $1
            AND status = 'pending';
        `,
        [eventId, errorCode]
      );

      const result = await client.query(
        `
          UPDATE telegram_outbox_events
          SET status = 'dead',
              lease_owner = NULL,
              lease_until = NULL,
              last_error_code = $3,
              updated_at = NOW()
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $2
          RETURNING ${EVENT_SELECT_FIELDS};
        `,
        [eventId, owner, errorCode]
      );
      const finalized = result.rows[0] as
        | TelegramOutboxEventRow
        | undefined;
      if (!finalized) {
        await client.query('ROLLBACK');
        return false;
      }

      await updateAggregateAfterDead(client, finalized, errorCode);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

const expireLockedTelegramOutboxEvent = async (
  client: PoolClient,
  event: TelegramOutboxEventRow
) => {
  const deliveryStatsResult = await client.query(
    `
      SELECT COUNT(*)::int AS delivery_count,
             COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_part_count
      FROM telegram_outbox_deliveries
      WHERE event_id = $1;
    `,
    [event.id]
  );
  const deliveryCount = Number(
    deliveryStatsResult.rows[0]?.delivery_count ?? 0
  );
  const sentPartCount = Number(
    deliveryStatsResult.rows[0]?.sent_part_count ?? 0
  );

  await client.query(
    `DELETE FROM telegram_outbox_deliveries WHERE event_id = $1;`,
    [event.id]
  );
  await client.query(
    `DELETE FROM telegram_outbox_attachments WHERE event_id = $1;`,
    [event.id]
  );
  const result = await client.query(
    `
      UPDATE telegram_outbox_events
      SET status = 'dead',
          payload = jsonb_build_object(
            'version', payload_version,
            'text', '[expired]'
          ),
          payload_scrubbed_at = COALESCE(payload_scrubbed_at, NOW()),
          attachments_expired_at = CASE
            WHEN attachment_count > 0
              THEN COALESCE(attachments_expired_at, NOW())
            ELSE attachments_expired_at
          END,
          deliveries_expired_at = COALESCE(deliveries_expired_at, NOW()),
          terminal_delivery_count =
            COALESCE(terminal_delivery_count, $2),
          terminal_sent_part_count =
            COALESCE(terminal_sent_part_count, $3),
          lease_owner = NULL,
          lease_until = NULL,
          last_error_code = 'retry_window_expired',
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${EVENT_SELECT_FIELDS};
    `,
    [event.id, deliveryCount, sentPartCount]
  );
  const expired = result.rows[0] as TelegramOutboxEventRow | undefined;
  if (!expired) throw new Error('telegram_outbox_expiry_failed');
  await updateAggregateAfterDead(client, expired, 'retry_window_expired');
};

export const finalizeTelegramOutboxEventExpired = async (
  eventId: string,
  owner: string
): Promise<boolean> => {
  assertUuid(eventId, 'eventId');
  assertWorkerOwner(owner);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          SELECT ${EVENT_SELECT_FIELDS}
          FROM telegram_outbox_events
          WHERE id = $1
            AND status = 'processing'
            AND lease_owner = $2
            AND lease_until > NOW()
            AND retry_expires_at <= NOW()
          FOR UPDATE;
        `,
        [eventId, owner]
      );
      const event = result.rows[0] as TelegramOutboxEventRow | undefined;
      if (!event) {
        await client.query('COMMIT');
        return false;
      }
      await expireLockedTelegramOutboxEvent(client, event);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export type TelegramOutboxRedriveResult =
  | 'queued'
  | 'not_found'
  | 'not_dead'
  | 'acknowledged'
  | 'payload_expired'
  | 'no_targets';

export const redriveTelegramOutboxEvent = async (
  eventId: string
): Promise<TelegramOutboxRedriveResult> => {
  assertUuid(eventId, 'eventId');
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const eventResult = await client.query(
        `
          SELECT events.bot_kind, events.aggregate_type, events.aggregate_id,
                 events.status,
                 last_error_code, payload_scrubbed_at,
                 attachment_count, attachments_expired_at,
                 deliveries_expired_at,
                 EXISTS (
                   SELECT 1
                   FROM telegram_outbox_acknowledgements AS acknowledgements
                   WHERE acknowledgements.event_id = events.id
                 ) AS acknowledged
          FROM telegram_outbox_events AS events
          WHERE events.id = $1
          FOR UPDATE;
        `,
        [eventId]
      );
      const event = eventResult.rows[0] as
        | {
            bot_kind: TelegramBotKind;
            aggregate_type: TelegramOutboxAggregateType;
            aggregate_id: string;
            status: TelegramOutboxEventStatus;
            last_error_code: TelegramOutboxErrorCode | null;
            payload_scrubbed_at: Date | string | null;
            attachment_count: number;
            attachments_expired_at: Date | string | null;
            deliveries_expired_at: Date | string | null;
            acknowledged: boolean;
          }
        | undefined;
      if (!event) {
        await client.query('COMMIT');
        return 'not_found';
      }
      if (event.status !== 'dead') {
        await client.query('COMMIT');
        return 'not_dead';
      }
      if (event.acknowledged) {
        await client.query('COMMIT');
        return 'acknowledged';
      }
      const attachmentResult = await client.query(
        `
          SELECT COUNT(*)::int AS count
          FROM telegram_outbox_attachments
          WHERE event_id = $1;
        `,
        [eventId]
      );
      const storedAttachmentCount = Number(attachmentResult.rows[0]?.count ?? 0);
      if (
        event.payload_scrubbed_at !== null ||
        event.attachments_expired_at !== null ||
        event.deliveries_expired_at !== null ||
        storedAttachmentCount !== event.attachment_count
      ) {
        await client.query('COMMIT');
        return 'payload_expired';
      }

      if (event.last_error_code === 'no_targets') {
        await client.query(
          `DELETE FROM telegram_outbox_deliveries WHERE event_id = $1;`,
          [eventId]
        );
        const seeded = await seedDeliveries(client, eventId, event.bot_kind);
        if (seeded.targetCount === 0) {
          await client.query('ROLLBACK');
          return 'no_targets';
        }
      } else {
        await client.query(
          `
            UPDATE telegram_outbox_deliveries
            SET status = 'pending',
                next_attempt_at = NOW(),
                last_error_code = NULL,
                updated_at = NOW()
            WHERE event_id = $1
              AND status = 'dead';
          `,
          [eventId]
        );
      }

      const dueResult = await client.query(
        `
          SELECT COUNT(*)::int AS count
          FROM telegram_outbox_deliveries
          WHERE event_id = $1
            AND status = 'pending';
        `,
        [eventId]
      );
      if (Number(dueResult.rows[0]?.count ?? 0) === 0) {
        await client.query('ROLLBACK');
        return 'no_targets';
      }

      await client.query(
        `
          UPDATE telegram_outbox_events
          SET status = 'pending',
              next_attempt_at = NOW(),
              retry_expires_at =
                NOW() + ($2::int * INTERVAL '1 day'),
              lease_owner = NULL,
              lease_until = NULL,
              last_error_code = NULL,
              updated_at = NOW()
          WHERE id = $1;
        `,
        [eventId, getTelegramOutboxMaxRetryAgeDays()]
      );
      if (event.aggregate_type === 'lead') {
        await client.query(
          `
            UPDATE lead_requests
            SET telegram_status = 'pending',
                telegram_error = NULL,
                updated_at = NOW()
            WHERE id = $1;
          `,
          [event.aggregate_id]
        );
      }
      await client.query('COMMIT');
      return 'queued';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export type TelegramOutboxAcknowledgeResult =
  | 'acknowledged'
  | 'not_found'
  | 'not_dead'
  | 'already_acknowledged'
  | 'event_key_mismatch'
  | 'recoverable';

const normalizeAuditText = (
  value: string,
  field: string,
  minimum: number,
  maximum: number
) => {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    hasControlCharacter
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
};

export const acknowledgeTelegramOutboxLoss = async (input: {
  eventId: string;
  expectedEventKey: string;
  acknowledgedBy: string;
  reason: string;
}): Promise<TelegramOutboxAcknowledgeResult> => {
  assertUuid(input.eventId, 'eventId');
  const expectedEventKey = normalizeAuditText(
    input.expectedEventKey,
    'expectedEventKey',
    1,
    255
  );
  const acknowledgedBy = normalizeAuditText(
    input.acknowledgedBy,
    'acknowledgedBy',
    1,
    256
  );
  const reason = normalizeAuditText(input.reason, 'reason', 10, 1_000);

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          SELECT events.event_key,
                 events.status,
                 events.last_error_code,
                 events.payload_scrubbed_at,
                 events.attachment_count,
                 events.attachments_expired_at,
                 events.deliveries_expired_at,
                 events.target_count,
                 events.attempt_count,
                 EXISTS (
                   SELECT 1
                   FROM telegram_outbox_acknowledgements AS acknowledgements
                   WHERE acknowledgements.event_id = events.id
                 ) AS acknowledged,
                 (
                   SELECT COUNT(*)::int
                   FROM telegram_outbox_attachments AS attachments
                   WHERE attachments.event_id = events.id
                 ) AS stored_attachment_count
          FROM telegram_outbox_events AS events
          WHERE events.id = $1
          FOR UPDATE;
        `,
        [input.eventId]
      );
      const event = result.rows[0] as
        | {
            event_key: string;
            status: TelegramOutboxEventStatus;
            last_error_code: TelegramOutboxErrorCode | null;
            payload_scrubbed_at: Date | string | null;
            attachment_count: number;
            attachments_expired_at: Date | string | null;
            deliveries_expired_at: Date | string | null;
            target_count: number;
            attempt_count: number;
            acknowledged: boolean;
            stored_attachment_count: number;
          }
        | undefined;
      if (!event) {
        await client.query('COMMIT');
        return 'not_found';
      }
      if (event.event_key !== expectedEventKey) {
        await client.query('COMMIT');
        return 'event_key_mismatch';
      }
      if (event.status !== 'dead') {
        await client.query('COMMIT');
        return 'not_dead';
      }
      if (event.acknowledged) {
        await client.query('COMMIT');
        return 'already_acknowledged';
      }
      const hasIrrecoverableLoss =
        event.payload_scrubbed_at !== null ||
        event.attachments_expired_at !== null ||
        event.deliveries_expired_at !== null ||
        Number(event.stored_attachment_count) !== Number(event.attachment_count);
      if (!hasIrrecoverableLoss) {
        await client.query('COMMIT');
        return 'recoverable';
      }

      const deliveryStatsResult = await client.query(
        `
          SELECT COUNT(*)::int AS delivery_count,
                 COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_part_count
          FROM telegram_outbox_deliveries
          WHERE event_id = $1;
        `,
        [input.eventId]
      );
      const deliveryCount = Number(
        deliveryStatsResult.rows[0]?.delivery_count ?? 0
      );
      const sentPartCount = Number(
        deliveryStatsResult.rows[0]?.sent_part_count ?? 0
      );
      await client.query(
        `DELETE FROM telegram_outbox_deliveries WHERE event_id = $1;`,
        [input.eventId]
      );
      await client.query(
        `DELETE FROM telegram_outbox_attachments WHERE event_id = $1;`,
        [input.eventId]
      );
      await client.query(
        `
          UPDATE telegram_outbox_events
          SET payload = jsonb_build_object(
                'version', payload_version,
                'text', '[expired]'
              ),
              payload_scrubbed_at = COALESCE(payload_scrubbed_at, NOW()),
              attachments_expired_at = CASE
                WHEN attachment_count > 0
                  THEN COALESCE(attachments_expired_at, NOW())
                ELSE attachments_expired_at
              END,
              deliveries_expired_at =
                COALESCE(deliveries_expired_at, NOW()),
              terminal_delivery_count =
                COALESCE(terminal_delivery_count, $2),
              terminal_sent_part_count =
                COALESCE(terminal_sent_part_count, $3)
          WHERE id = $1;
        `,
        [input.eventId, deliveryCount, sentPartCount]
      );

      await client.query(
        `
          INSERT INTO telegram_outbox_acknowledgements (
            event_id,
            event_key,
            acknowledged_by,
            source,
            reason,
            terminal_error_code,
            target_count,
            attempt_count
          )
          VALUES ($1, $2, $3, 'cli', $4, $5, $6, $7);
        `,
        [
          input.eventId,
          event.event_key,
          acknowledgedBy,
          reason,
          event.last_error_code ?? 'unknown_error',
          event.target_count,
          event.attempt_count
        ]
      );
      await client.query('COMMIT');
      return 'acknowledged';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const purgeDeadTelegramOutboxAttachments = async (
  olderThanDays: number,
  batchSize = 100
): Promise<number> => {
  if (
    !Number.isSafeInteger(olderThanDays) ||
    olderThanDays < 1 ||
    olderThanDays > 3_650
  ) {
    throw new Error('Invalid olderThanDays');
  }
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1_000
  ) {
    throw new Error('Invalid batchSize');
  }

  return withClient(async (client) => {
    const result = await client.query(
      `
        WITH candidates AS (
          SELECT events.id
          FROM telegram_outbox_events AS events
          WHERE events.status = 'dead'
            AND events.updated_at <
                NOW() - ($1::int * INTERVAL '1 day')
            AND EXISTS (
              SELECT 1
              FROM telegram_outbox_attachments AS attachments
              WHERE attachments.event_id = events.id
          )
          ORDER BY events.updated_at ASC
          FOR UPDATE OF events SKIP LOCKED
          LIMIT $2
        ), marked AS (
          UPDATE telegram_outbox_events AS events
          SET attachments_expired_at = COALESCE(events.attachments_expired_at, NOW())
          FROM candidates
          WHERE events.id = candidates.id
          RETURNING events.id
        )
        DELETE FROM telegram_outbox_attachments AS attachments
        USING marked
        WHERE attachments.event_id = marked.id
        RETURNING attachments.id;
      `,
      [olderThanDays, batchSize]
    );
    return result.rowCount ?? 0;
  });
};

const assertRetentionInput = (olderThanDays: number, batchSize: number) => {
  if (
    !Number.isSafeInteger(olderThanDays) ||
    olderThanDays < 1 ||
    olderThanDays > 3_650 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1_000
  ) {
    throw new Error('Invalid Telegram outbox retention input');
  }
};

export const expireDueTelegramOutboxEvents = async (
  batchSize = 100
): Promise<number> => {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1_000
  ) {
    throw new Error('Invalid Telegram outbox expiry batch size');
  }
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          SELECT ${EVENT_SELECT_FIELDS}
          FROM telegram_outbox_events
          WHERE retry_expires_at <= NOW()
            AND (
              status IN ('pending', 'retry')
              OR (
                status = 'processing'
                AND (lease_until IS NULL OR lease_until <= NOW())
              )
            )
          ORDER BY retry_expires_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $1;
        `,
        [batchSize]
      );
      const events = result.rows as TelegramOutboxEventRow[];
      for (const event of events) {
        await expireLockedTelegramOutboxEvent(client, event);
      }
      await client.query('COMMIT');
      return events.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const purgeSentTelegramOutboxEvents = async (
  olderThanDays: number,
  batchSize = 100
): Promise<number> => {
  assertRetentionInput(olderThanDays, batchSize);
  return withClient(async (client) => {
    const result = await client.query(
      `
        WITH candidates AS (
          SELECT id
          FROM telegram_outbox_events
          WHERE status = 'sent'
            AND sent_at < NOW() - ($1::int * INTERVAL '1 day')
          ORDER BY sent_at ASC
          LIMIT $2
        )
        DELETE FROM telegram_outbox_events AS events
        USING candidates
        WHERE events.id = candidates.id
        RETURNING events.id;
      `,
      [olderThanDays, batchSize]
    );
    return result.rowCount ?? 0;
  });
};

export const scrubDeadTelegramOutboxPayloads = async (
  olderThanDays: number,
  batchSize = 100
): Promise<number> => {
  assertRetentionInput(olderThanDays, batchSize);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const candidateResult = await client.query(
        `
          SELECT id
          FROM telegram_outbox_events
          WHERE status = 'dead'
            AND (
              payload_scrubbed_at IS NULL
              OR deliveries_expired_at IS NULL
              OR (
                attachment_count > 0
                AND attachments_expired_at IS NULL
              )
              OR EXISTS (
                SELECT 1
                FROM telegram_outbox_attachments AS attachments
                WHERE attachments.event_id = telegram_outbox_events.id
              )
              OR EXISTS (
                SELECT 1
                FROM telegram_outbox_deliveries AS deliveries
                WHERE deliveries.event_id = telegram_outbox_events.id
              )
            )
            AND updated_at < NOW() - ($1::int * INTERVAL '1 day')
          ORDER BY updated_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT $2;
        `,
        [olderThanDays, batchSize]
      );
      const eventIds = candidateResult.rows.map((row) => String(row.id));
      for (const eventId of eventIds) {
        const statsResult = await client.query(
          `
            SELECT COUNT(*)::int AS delivery_count,
                   COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_part_count
            FROM telegram_outbox_deliveries
            WHERE event_id = $1;
          `,
          [eventId]
        );
        const deliveryCount = Number(
          statsResult.rows[0]?.delivery_count ?? 0
        );
        const sentPartCount = Number(
          statsResult.rows[0]?.sent_part_count ?? 0
        );
        await client.query(
          `DELETE FROM telegram_outbox_deliveries WHERE event_id = $1;`,
          [eventId]
        );
        await client.query(
          `DELETE FROM telegram_outbox_attachments WHERE event_id = $1;`,
          [eventId]
        );
        await client.query(
          `
            UPDATE telegram_outbox_events
            SET payload = jsonb_build_object(
                  'version', payload_version,
                  'text', '[expired]'
                ),
                payload_scrubbed_at = COALESCE(payload_scrubbed_at, NOW()),
                attachments_expired_at = CASE
                  WHEN attachment_count > 0
                    THEN COALESCE(attachments_expired_at, NOW())
                  ELSE attachments_expired_at
                END,
                deliveries_expired_at =
                  COALESCE(deliveries_expired_at, NOW()),
                terminal_delivery_count =
                  COALESCE(terminal_delivery_count, $2),
                terminal_sent_part_count =
                  COALESCE(terminal_sent_part_count, $3)
            WHERE id = $1;
          `,
          [eventId, deliveryCount, sentPartCount]
        );
      }
      await client.query('COMMIT');
      return eventIds.length;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export type TelegramNotificationHealth = {
  eventCounts: {
    pending: number;
    processing: number;
    retry: number;
    sent: number;
    dead: number;
    acknowledgedDead: number;
    total: number;
  };
  oldestPendingAt: string | null;
  oldestPendingAgeSeconds: number | null;
  privacyRetentionDrift: number;
  stockReservationDrift: number;
  paidInvariant: {
    required: number;
    notified: number;
    awaitingNotification: number;
    overdueNotification: number;
    missingOutboxEvent: number;
    requiredMarkerDrift: number;
    sentMarkerDrift: number;
    paymentStatusDrift: number;
  };
  leadNotifications: {
    pending: number;
    sent: number;
    failed: number;
  };
};

export const ACTIVE_YOOKASSA_WITHOUT_STOCK_RESERVATION_DRIFT_SQL = `
  (
    orders.status = 'pending'
    AND orders.payment_provider = 'yookassa'
    AND orders.stock_reservation_status IS NULL
    AND (
      orders.payment_id IS NOT NULL
      OR orders.payment_status = 'creating'
    )
    AND (
      orders.payment_status IS NULL
      OR orders.payment_status NOT IN ('canceled', 'succeeded')
    )
  )
`;

export const SENT_OUTBOX_RETENTION_DRIFT_SQL = `
  (
    events.status = 'sent'
    AND (
      events.sent_at IS NULL
      OR events.sent_at <
        NOW() - ($2::int * INTERVAL '1 day')
    )
  )
`;

const toCount = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const toNullableSeconds = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
};

const toNullableIsoDate = (value: unknown) => {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

export const getTelegramNotificationHealth =
  async (
    overdueMs = 300_000,
    retentionDays = getTelegramOutboxRetentionDays(),
    timeoutMs = 3_000
  ): Promise<TelegramNotificationHealth> => {
    assertDelay(overdueMs, 'overdueMs', 86_400_000);
    if (overdueMs < 1_000) {
      throw new Error('Invalid overdueMs');
    }

    if (
      !Number.isSafeInteger(retentionDays) ||
      retentionDays < 1 ||
      retentionDays > 3_650
    ) {
      throw new Error('Invalid retentionDays');
    }

    assertDelay(timeoutMs, 'timeoutMs', 30_000);
    const result = await queryWithTimeout(`
        WITH event_stats AS (
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
            COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
            COUNT(*) FILTER (WHERE status = 'retry') AS retry_count,
            COUNT(*) FILTER (WHERE status = 'sent') AS sent_count,
            COUNT(*) FILTER (
              WHERE status = 'dead'
                AND NOT EXISTS (
                  SELECT 1
                  FROM telegram_outbox_acknowledgements AS acknowledgements
                  WHERE acknowledgements.event_id = events.id
                )
            ) AS dead_count,
            COUNT(*) FILTER (
              WHERE status = 'dead'
                AND EXISTS (
                  SELECT 1
                  FROM telegram_outbox_acknowledgements AS acknowledgements
                  WHERE acknowledgements.event_id = events.id
                )
            ) AS acknowledged_dead_count,
            COUNT(*) AS total_count,
            MIN(created_at) FILTER (
              WHERE status IN ('pending', 'processing', 'retry')
            ) AS oldest_pending_at
          FROM telegram_outbox_events AS events
        ),
        paid_stats AS (
          SELECT
            COUNT(*) AS required_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notified_at IS NOT NULL
            ) AS notified_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notified_at IS NULL
            ) AS awaiting_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notified_at IS NULL
                AND COALESCE(
                      orders.telegram_notification_required_at,
                      orders.updated_at
                    ) <
                    NOW() - ($1::int * INTERVAL '1 millisecond')
            ) AS overdue_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notified_at IS NULL
                AND NOT EXISTS (
                SELECT 1
                FROM telegram_outbox_events AS events
                WHERE events.event_type = 'order_paid'
                  AND events.aggregate_type = 'order'
                  AND events.aggregate_id = orders.id
              )
            ) AS missing_event_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notification_required_at IS NULL
            ) AS required_marker_drift_count,
            COUNT(*) FILTER (
              WHERE orders.telegram_notified_at IS NULL
                AND EXISTS (
                  SELECT 1
                  FROM telegram_outbox_events AS events
                  WHERE events.event_type = 'order_paid'
                    AND events.aggregate_type = 'order'
                    AND events.aggregate_id = orders.id
                    AND events.status = 'sent'
                )
            ) AS sent_marker_drift_count
          FROM orders
          WHERE orders.status = 'paid'
            AND orders.telegram_notification_exempted_at IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM telegram_outbox_events AS events
              INNER JOIN telegram_outbox_acknowledgements AS acknowledgements
                ON acknowledgements.event_id = events.id
              WHERE events.event_type = 'order_paid'
                AND events.aggregate_type = 'order'
                AND events.aggregate_id = orders.id
                AND events.status = 'dead'
            )
        ),
        payment_drift_stats AS (
          SELECT
            (
              SELECT COUNT(*)
              FROM orders
              WHERE payment_anomaly_code IS NOT NULL
                OR (
                  payment_status = 'creating'
                  AND (
                    payment_creation_started_at IS NULL
                    OR payment_creation_started_at < NOW() - INTERVAL '23 hours'
                  )
                )
                OR (
                  payment_status = 'succeeded'
                  AND status <> 'paid'
                )
                OR (
                  status = 'paid'
                  AND payment_provider = 'yookassa'
                  AND (
                    payment_status IS DISTINCT FROM 'succeeded'
                    OR payment_confirmed_at IS NULL
                  )
                )
            ) + (
              SELECT COUNT(*)
              FROM payment_anomalies
              WHERE resolved_at IS NULL
            ) AS drift_count
        ),
        stock_reservation_drift_stats AS (
          SELECT COUNT(*) AS drift_count
          FROM orders
          WHERE (
              status = 'paid'
              AND stock_reservation_status IS DISTINCT FROM 'consumed'
            )
            OR (
              stock_reservation_status = 'consumed'
              AND status <> 'paid'
            )
            OR (
              stock_reservation_status = 'released'
              AND (
                status <> 'pending'
                OR payment_status IS DISTINCT FROM 'canceled'
              )
            )
            OR (
              stock_reservation_status = 'reserved'
              AND (
                status <> 'pending'
                OR payment_status IS NULL
                OR payment_status IN ('canceled', 'succeeded')
                OR stock_reserved_at IS NULL
                OR stock_reserved_at < NOW() - INTERVAL '23 hours'
                OR stock_reservation_attempt_key IS NULL
                OR (
                  payment_idempotency_key IS NOT NULL
                  AND stock_reservation_attempt_key
                    IS DISTINCT FROM payment_idempotency_key
                )
              )
            )
            OR ${ACTIVE_YOOKASSA_WITHOUT_STOCK_RESERVATION_DRIFT_SQL}
        ),
        privacy_drift_stats AS (
          SELECT COUNT(*) AS drift_count
          FROM telegram_outbox_events AS events
          WHERE (
              events.status IN ('pending', 'processing', 'retry')
              AND events.retry_expires_at <= NOW()
            )
            OR (
              events.status = 'dead'
              AND events.last_error_code = 'retry_window_expired'
              AND (
                events.payload_scrubbed_at IS NULL
                OR events.deliveries_expired_at IS NULL
                OR (
                  events.attachment_count > 0
                  AND events.attachments_expired_at IS NULL
                )
                OR EXISTS (
                  SELECT 1
                  FROM telegram_outbox_attachments AS attachments
                  WHERE attachments.event_id = events.id
                )
                OR EXISTS (
                  SELECT 1
                  FROM telegram_outbox_deliveries AS deliveries
                  WHERE deliveries.event_id = events.id
                )
              )
            )
            OR (
              events.status = 'dead'
              AND EXISTS (
                SELECT 1
                FROM telegram_outbox_acknowledgements AS acknowledgements
                WHERE acknowledgements.event_id = events.id
              )
              AND (
                events.payload_scrubbed_at IS NULL
                OR events.deliveries_expired_at IS NULL
                OR (
                  events.attachment_count > 0
                  AND events.attachments_expired_at IS NULL
                )
                OR EXISTS (
                  SELECT 1
                  FROM telegram_outbox_attachments AS attachments
                  WHERE attachments.event_id = events.id
                )
                OR EXISTS (
                  SELECT 1
                  FROM telegram_outbox_deliveries AS deliveries
                  WHERE deliveries.event_id = events.id
                )
              )
            )
            OR ${SENT_OUTBOX_RETENTION_DRIFT_SQL}
        ),
        lead_stats AS (
          SELECT
            COUNT(*) FILTER (
              WHERE telegram_status = 'pending'
            ) AS pending_count,
            COUNT(*) FILTER (
              WHERE telegram_status = 'sent'
            ) AS sent_count,
            COUNT(*) FILTER (
              WHERE telegram_status = 'failed'
                AND NOT EXISTS (
                  SELECT 1
                  FROM telegram_outbox_events AS events
                  INNER JOIN telegram_outbox_acknowledgements AS acknowledgements
                    ON acknowledgements.event_id = events.id
                  WHERE events.event_type = 'lead_created'
                    AND events.aggregate_type = 'lead'
                    AND events.aggregate_id = lead_requests.id
                    AND events.status = 'dead'
                )
            ) AS failed_count
          FROM lead_requests
        )
        SELECT
          event_stats.pending_count,
          event_stats.processing_count,
          event_stats.retry_count,
          event_stats.sent_count,
          event_stats.dead_count,
          event_stats.acknowledged_dead_count,
          event_stats.total_count,
          event_stats.oldest_pending_at,
          CASE
            WHEN event_stats.oldest_pending_at IS NULL THEN NULL
            ELSE EXTRACT(
              EPOCH FROM (NOW() - event_stats.oldest_pending_at)
            )
          END AS oldest_pending_age_seconds,
          paid_stats.required_count AS paid_required_count,
          paid_stats.notified_count AS paid_notified_count,
          paid_stats.awaiting_count AS paid_awaiting_count,
          paid_stats.overdue_count AS paid_overdue_count,
          paid_stats.missing_event_count AS paid_missing_event_count,
          paid_stats.required_marker_drift_count,
          paid_stats.sent_marker_drift_count,
          payment_drift_stats.drift_count AS payment_status_drift_count,
          stock_reservation_drift_stats.drift_count
            AS stock_reservation_drift_count,
          privacy_drift_stats.drift_count AS privacy_retention_drift_count,
          lead_stats.pending_count AS lead_pending_count,
          lead_stats.sent_count AS lead_sent_count,
          lead_stats.failed_count AS lead_failed_count
        FROM event_stats
        CROSS JOIN paid_stats
        CROSS JOIN payment_drift_stats
        CROSS JOIN stock_reservation_drift_stats
        CROSS JOIN privacy_drift_stats
        CROSS JOIN lead_stats;
      `, timeoutMs, [overdueMs, retentionDays]);
    const row = result.rows[0] ?? {};

    return {
        eventCounts: {
          pending: toCount(row.pending_count),
          processing: toCount(row.processing_count),
          retry: toCount(row.retry_count),
          sent: toCount(row.sent_count),
          dead: toCount(row.dead_count),
          acknowledgedDead: toCount(row.acknowledged_dead_count),
          total: toCount(row.total_count)
        },
        oldestPendingAt: toNullableIsoDate(row.oldest_pending_at),
        oldestPendingAgeSeconds: toNullableSeconds(
          row.oldest_pending_age_seconds
        ),
        privacyRetentionDrift: toCount(row.privacy_retention_drift_count),
        stockReservationDrift: toCount(row.stock_reservation_drift_count),
        paidInvariant: {
          required: toCount(row.paid_required_count),
          notified: toCount(row.paid_notified_count),
          awaitingNotification: toCount(row.paid_awaiting_count),
          overdueNotification: toCount(row.paid_overdue_count),
          missingOutboxEvent: toCount(row.paid_missing_event_count),
          requiredMarkerDrift: toCount(row.required_marker_drift_count),
          sentMarkerDrift: toCount(row.sent_marker_drift_count),
          paymentStatusDrift: toCount(row.payment_status_drift_count)
        },
        leadNotifications: {
          pending: toCount(row.lead_pending_count),
          sent: toCount(row.lead_sent_count),
          failed: toCount(row.lead_failed_count)
        }
    };
  };

export type TelegramUpdateInboxState =
  | 'started'
  | 'already_processed'
  | 'busy';

export type TelegramUpdateInboxBeginResult = {
  state: TelegramUpdateInboxState;
  attemptCount: number;
};

const assertBotKind = (botKind: TelegramBotKind) => {
  if (!Object.prototype.hasOwnProperty.call(subscriberTables, botKind)) {
    throw new Error('Invalid botKind');
  }
};

const assertBotInstanceKey = (value: string) => {
  if (!/^[a-f0-9]{32}$/.test(value)) {
    throw new Error('Invalid botInstanceKey');
  }
};

const normalizeNonNegativeBigInt = (
  value: number | string,
  field: string
) => {
  const normalized = String(value);
  assertBigIntText(normalized, field);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
};

export type TelegramUpdateCursor = {
  offset: number;
  lastUpdateAt: string | null;
};

export const loadTelegramUpdateCursor = async (
  botKind: TelegramBotKind,
  botInstanceKey: string
): Promise<TelegramUpdateCursor> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  return withClient(async (client) => {
    const result = await client.query(
      `
        INSERT INTO telegram_update_state (
          bot_kind,
          bot_instance_key,
          update_offset
        )
        VALUES ($1, $2, 0)
        ON CONFLICT (bot_kind) DO UPDATE
        SET update_offset = CASE
              WHEN telegram_update_state.bot_instance_key = EXCLUDED.bot_instance_key
                THEN telegram_update_state.update_offset
              ELSE 0
            END,
            last_update_at = CASE
              WHEN telegram_update_state.bot_instance_key = EXCLUDED.bot_instance_key
                THEN telegram_update_state.last_update_at
              ELSE NULL
            END,
            bot_instance_key = EXCLUDED.bot_instance_key,
            updated_at = CASE
              WHEN telegram_update_state.bot_instance_key = EXCLUDED.bot_instance_key
                THEN telegram_update_state.updated_at
              ELSE NOW()
            END
        RETURNING update_offset::text AS offset, last_update_at;
      `,
      [botKind, botInstanceKey]
    );
    const parsed = Number(result.rows[0]?.offset ?? 0);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error('Stored Telegram update offset is not a safe integer');
    }
    return {
      offset: parsed,
      lastUpdateAt: toNullableIsoDate(result.rows[0]?.last_update_at)
    };
  });
};

export const saveTelegramUpdateOffset = async (
  botKind: TelegramBotKind,
  botInstanceKey: string,
  offset: number | string
): Promise<void> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  const normalizedOffset = normalizeNonNegativeBigInt(offset, 'offset');
  await withClient(async (client) => {
    await client.query(
      `
        INSERT INTO telegram_update_state (
          bot_kind,
          bot_instance_key,
          update_offset,
          last_update_at
        )
        VALUES ($1, $2, $3::bigint, NOW())
        ON CONFLICT (bot_kind) DO UPDATE
        SET update_offset = CASE
              WHEN telegram_update_state.bot_instance_key = EXCLUDED.bot_instance_key
                THEN GREATEST(
                  telegram_update_state.update_offset,
                  EXCLUDED.update_offset
                )
              ELSE EXCLUDED.update_offset
            END,
            bot_instance_key = EXCLUDED.bot_instance_key,
            last_update_at = NOW(),
            updated_at = NOW();
      `,
      [botKind, botInstanceKey, normalizedOffset]
    );
  });
};

export const resetTelegramUpdateOffset = async (
  botKind: TelegramBotKind,
  botInstanceKey: string
): Promise<boolean> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_update_state
        SET update_offset = 0,
            last_update_at = NULL,
            updated_at = NOW()
        WHERE bot_kind = $1
          AND bot_instance_key = $2
        RETURNING bot_kind;
      `,
      [botKind, botInstanceKey]
    );
    return (result.rowCount ?? 0) > 0;
  });
};

export const beginTelegramUpdateInbox = async (
  botKind: TelegramBotKind,
  botInstanceKey: string,
  updateId: number | string,
  retryProcessingAfterMs = 30_000
): Promise<TelegramUpdateInboxBeginResult> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  const normalizedUpdateId = normalizeNonNegativeBigInt(
    updateId,
    'updateId'
  );
  assertDelay(
    retryProcessingAfterMs,
    'retryProcessingAfterMs',
    86_400_000
  );

  return withClient(async (client) => {
    const result = await client.query(
      `
        INSERT INTO telegram_update_inbox (
          bot_kind,
          bot_instance_key,
          update_id,
          status,
          attempt_count
        )
        VALUES ($1, $2, $3::bigint, 'processing', 1)
        ON CONFLICT (bot_kind, update_id) DO UPDATE
        SET bot_instance_key = EXCLUDED.bot_instance_key,
            attempt_count = CASE
              WHEN telegram_update_inbox.bot_instance_key = EXCLUDED.bot_instance_key
                THEN telegram_update_inbox.attempt_count + 1
              ELSE 1
            END,
            status = 'processing',
            last_error_code = NULL,
            processed_at = NULL,
            updated_at = NOW()
        WHERE telegram_update_inbox.bot_instance_key <> EXCLUDED.bot_instance_key
           OR (
             telegram_update_inbox.status = 'processing'
             AND telegram_update_inbox.updated_at <=
                 NOW() - ($4::int * INTERVAL '1 millisecond')
           )
        RETURNING status, attempt_count;
      `,
        [botKind, botInstanceKey, normalizedUpdateId, retryProcessingAfterMs]
    );
    const started = result.rows[0] as
      | { status: 'processing'; attempt_count: number }
      | undefined;
    if (started) {
      return {
        state: 'started',
        attemptCount: Number(started.attempt_count)
      };
    }

    const existingResult = await client.query(
      `
        SELECT status, attempt_count
        FROM telegram_update_inbox
          WHERE bot_kind = $1
          AND bot_instance_key = $2
          AND update_id = $3::bigint;
      `,
      [botKind, botInstanceKey, normalizedUpdateId]
    );
    const existing = existingResult.rows[0] as
      | { status: 'processing' | 'processed'; attempt_count: number }
      | undefined;
    return {
      state:
        existing?.status === 'processed' ? 'already_processed' : 'busy',
      attemptCount: Number(existing?.attempt_count ?? 0)
    };
  });
};

export const completeTelegramUpdateInbox = async (
  botKind: TelegramBotKind,
  botInstanceKey: string,
  updateId: number | string,
  attemptCount: number,
  nextOffset?: number | string
): Promise<boolean> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error('Invalid attemptCount');
  }
  const normalizedUpdateId = normalizeNonNegativeBigInt(
    updateId,
    'updateId'
  );
  const normalizedOffset =
    nextOffset === undefined
      ? null
      : normalizeNonNegativeBigInt(nextOffset, 'nextOffset');

  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          UPDATE telegram_update_inbox
          SET status = 'processed',
              last_error_code = NULL,
              processed_at = NOW(),
              updated_at = NOW()
          WHERE bot_kind = $1
            AND bot_instance_key = $2
            AND update_id = $3::bigint
            AND attempt_count = $4
            AND status = 'processing'
          RETURNING update_id;
        `,
        [botKind, botInstanceKey, normalizedUpdateId, attemptCount]
      );
      if ((result.rowCount ?? 0) === 0) {
        await client.query('COMMIT');
        return false;
      }

      if (normalizedOffset !== null) {
        await client.query(
          `
            INSERT INTO telegram_update_state (
              bot_kind,
              bot_instance_key,
              update_offset,
              last_update_at
            )
            VALUES ($1, $2, $3::bigint, NOW())
            ON CONFLICT (bot_kind) DO UPDATE
            SET update_offset = CASE
                  WHEN telegram_update_state.bot_instance_key = EXCLUDED.bot_instance_key
                    THEN GREATEST(
                      telegram_update_state.update_offset,
                      EXCLUDED.update_offset
                    )
                  ELSE EXCLUDED.update_offset
                END,
                bot_instance_key = EXCLUDED.bot_instance_key,
                last_update_at = NOW(),
                updated_at = NOW();
          `,
          [botKind, botInstanceKey, normalizedOffset]
        );
      }

      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const failTelegramUpdateInbox = async (
  botKind: TelegramBotKind,
  botInstanceKey: string,
  updateId: number | string,
  attemptCount: number,
  errorCode: TelegramOutboxErrorCode
): Promise<boolean> => {
  assertBotKind(botKind);
  assertBotInstanceKey(botInstanceKey);
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error('Invalid attemptCount');
  }
  const normalizedUpdateId = normalizeNonNegativeBigInt(
    updateId,
    'updateId'
  );

  return withClient(async (client) => {
    const result = await client.query(
      `
        UPDATE telegram_update_inbox
        SET last_error_code = $5,
            updated_at = NOW()
        WHERE bot_kind = $1
          AND bot_instance_key = $2
          AND update_id = $3::bigint
          AND attempt_count = $4
          AND status = 'processing'
        RETURNING update_id;
      `,
      [botKind, botInstanceKey, normalizedUpdateId, attemptCount, errorCode]
    );
    return (result.rowCount ?? 0) > 0;
  });
};
