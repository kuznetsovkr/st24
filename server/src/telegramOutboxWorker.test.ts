import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyTelegramOutboxError,
  computeTelegramOutboxRetryDelayMs,
  isTelegramOutboxRetryExpired,
  runTelegramOutboxWorkerCycle,
  type WorkerDependencies
} from './telegramOutboxWorker';
import { TelegramDeliveryError } from './telegramTransport';
import type { TelegramOutboxBundle } from './db/telegramOutbox';
import {
  parseTelegramOutboxMaxRetryAgeDays,
  parseTelegramOutboxRetentionDays
} from './telegramOutboxConfig';

test('outbox backoff uses full jitter and an exponential ceiling', () => {
  assert.equal(computeTelegramOutboxRetryDelayMs(1, null, () => 0.5), 7_500);
  assert.equal(computeTelegramOutboxRetryDelayMs(2, null, () => 0.5), 15_000);
  assert.equal(computeTelegramOutboxRetryDelayMs(20, null, () => 1), 3_600_000);
});

test('Telegram retry_after takes precedence over exponential backoff', () => {
  assert.equal(computeTelegramOutboxRetryDelayMs(8, 42, () => 0), 42_000);
});

test('outbox retry lifetime configuration is strict and bounded', () => {
  assert.equal(parseTelegramOutboxMaxRetryAgeDays(undefined), 7);
  assert.equal(parseTelegramOutboxMaxRetryAgeDays('30'), 30);
  assert.throws(() => parseTelegramOutboxMaxRetryAgeDays('30days'));
  assert.throws(() => parseTelegramOutboxMaxRetryAgeDays('0'));
  assert.throws(() => parseTelegramOutboxMaxRetryAgeDays('3651'));
});

test('outbox PII retention configuration is strict and bounded', () => {
  assert.equal(parseTelegramOutboxRetentionDays(undefined), 90);
  assert.equal(parseTelegramOutboxRetentionDays('30'), 30);
  assert.throws(() => parseTelegramOutboxRetentionDays('30days'));
  assert.throws(() => parseTelegramOutboxRetentionDays('0'));
  assert.throws(() => parseTelegramOutboxRetentionDays('3651'));
});

test('classifies blocked chats as permanent per-recipient failures', () => {
  const result = classifyTelegramOutboxError(
    new TelegramDeliveryError({
      botKind: 'main',
      kind: 'telegram_api',
      code: 403,
      permanent: true
    })
  );
  assert.deepEqual(result, {
    code: 'telegram_chat_blocked',
    permanent: true,
    retryAfterSeconds: null
  });
});

test('classifies Telegram throttling as retryable and preserves retry_after', () => {
  const result = classifyTelegramOutboxError(
    new TelegramDeliveryError({
      botKind: 'orders',
      kind: 'telegram_api',
      code: 429,
      retryAfterSeconds: 17
    })
  );
  assert.deepEqual(result, {
    code: 'telegram_rate_limited',
    permanent: false,
    retryAfterSeconds: 17
  });
});

test('a document retry does not resend a text part that already succeeded', async () => {
  const event = {
    id: '00000000-0000-4000-8000-000000000001',
    event_key: 'lead-created:00000000-0000-4000-8000-000000000002',
    event_type: 'lead_created' as const,
    bot_kind: 'main' as const,
    aggregate_type: 'lead' as const,
    aggregate_id: '00000000-0000-4000-8000-000000000002',
    payload_version: 1,
    payload: { version: 1 as const, text: 'Новая заявка' },
    payload_scrubbed_at: null,
    attachment_count: 1,
    attachments_expired_at: null,
    retry_expires_at: '2099-08-09T00:00:00.000Z',
    deliveries_expired_at: null,
    terminal_delivery_count: null,
    terminal_sent_part_count: null,
    status: 'processing' as const,
    attempt_count: 2,
    next_attempt_at: '2026-08-09T00:00:00.000Z',
    lease_owner: 'worker-test',
    lease_until: '2026-08-09T01:00:00.000Z',
    target_count: 1,
    last_error_code: null,
    sent_at: null,
    created_at: '2026-08-09T00:00:00.000Z',
    updated_at: '2026-08-09T00:00:00.000Z'
  };
  const bundle: TelegramOutboxBundle = {
    event,
    attachments: [
      {
        id: '00000000-0000-4000-8000-000000000003',
        event_id: event.id,
        part_no: 1,
        file_name: 'photo.jpg',
        mime_type: 'image/jpeg',
        size_bytes: 3,
        bytes: Buffer.from([1, 2, 3]),
        created_at: event.created_at
      }
    ],
    deliveries: [
      {
        event_id: event.id,
        chat_id: '-1001',
        part_no: 0,
        delivery_kind: 'text',
        status: 'sent',
        attempt_count: 1,
        next_attempt_at: event.created_at,
        telegram_message_id: '10',
        last_error_code: null,
        sent_at: event.created_at,
        created_at: event.created_at,
        updated_at: event.created_at
      },
      {
        event_id: event.id,
        chat_id: '-1001',
        part_no: 1,
        delivery_kind: 'document',
        status: 'pending',
        attempt_count: 1,
        next_attempt_at: event.created_at,
        telegram_message_id: null,
        last_error_code: 'timeout',
        sent_at: null,
        created_at: event.created_at,
        updated_at: event.created_at
      }
    ]
  };
  const sentPartTypes: string[] = [];
  let finalized = false;
  const unexpected = async () => {
    throw new Error('unexpected mutation');
  };
  const dependencies: WorkerDependencies = {
    claim: async () => event,
    load: async () => bundle,
    extendLease: async () => true,
    listActiveChatIds: async () => ['-1001'],
    deactivateChat: async () => undefined,
    sendPart: async (_botKind, chatId, part) => {
      sentPartTypes.push(part.type);
      return { botKind: 'main', chatId, messageId: 11 };
    },
    logAttempt: () => undefined,
    markSent: async (input) => {
      const delivery = bundle.deliveries.find(
        (candidate) => candidate.chat_id === input.chatId && candidate.part_no === input.partNo
      );
      if (delivery) delivery.status = 'sent';
      return true;
    },
    markSkipped: unexpected,
    markRetry: unexpected,
    markDead: unexpected,
    finalizeSent: async () => {
      finalized = true;
      return true;
    },
    finalizeRetry: unexpected,
    finalizeDead: unexpected,
    finalizeExpired: unexpected
  };

  assert.equal(
    await runTelegramOutboxWorkerCycle('worker-test', { dependencies }),
    true
  );
  assert.deepEqual(sentPartTypes, ['document']);
  assert.equal(finalized, true);
});

test('an inactive snapshotted recipient is skipped without blocking another recipient', async () => {
  const createdAt = '2026-08-09T00:00:00.000Z';
  const event = {
    id: '00000000-0000-4000-8000-000000000011',
    event_key: 'order-paid:00000000-0000-4000-8000-000000000012',
    event_type: 'order_paid' as const,
    bot_kind: 'orders' as const,
    aggregate_type: 'order' as const,
    aggregate_id: '00000000-0000-4000-8000-000000000012',
    payload_version: 1,
    payload: { version: 1 as const, text: 'paid order' },
    payload_scrubbed_at: null,
    attachment_count: 0,
    attachments_expired_at: null,
    retry_expires_at: '2099-08-09T00:00:00.000Z',
    deliveries_expired_at: null,
    terminal_delivery_count: null,
    terminal_sent_part_count: null,
    status: 'processing' as const,
    attempt_count: 1,
    next_attempt_at: createdAt,
    lease_owner: 'worker-test',
    lease_until: '2026-08-09T01:00:00.000Z',
    target_count: 2,
    last_error_code: null,
    sent_at: null,
    created_at: createdAt,
    updated_at: createdAt
  };
  const bundle: TelegramOutboxBundle = {
    event,
    attachments: [],
    deliveries: ['-1001', '-1002'].map((chatId) => ({
      event_id: event.id,
      chat_id: chatId,
      part_no: 0,
      delivery_kind: 'text' as const,
      status: 'pending' as const,
      attempt_count: 0,
      next_attempt_at: createdAt,
      telegram_message_id: null,
      last_error_code: null,
      sent_at: null,
      created_at: createdAt,
      updated_at: createdAt
    }))
  };
  const unexpected = async () => {
    throw new Error('unexpected mutation');
  };
  let finalized = false;
  const dependencies: WorkerDependencies = {
    claim: async () => event,
    load: async () => bundle,
    extendLease: async () => true,
    listActiveChatIds: async () => ['-1002'],
    deactivateChat: async () => undefined,
    sendPart: async (botKind, chatId) => ({ botKind, chatId, messageId: 21 }),
    logAttempt: () => undefined,
    markSent: async (input) => {
      const delivery = bundle.deliveries.find((item) => item.chat_id === input.chatId);
      if (delivery) delivery.status = 'sent';
      return true;
    },
    markSkipped: async (input) => {
      const delivery = bundle.deliveries.find((item) => item.chat_id === input.chatId);
      if (delivery) delivery.status = 'skipped';
      return true;
    },
    markRetry: unexpected,
    markDead: unexpected,
    finalizeSent: async () => {
      finalized = true;
      return true;
    },
    finalizeRetry: unexpected,
    finalizeDead: unexpected,
    finalizeExpired: unexpected
  };

  await runTelegramOutboxWorkerCycle('worker-test', { dependencies });
  assert.equal(bundle.deliveries[0]?.status, 'skipped');
  assert.equal(bundle.deliveries[1]?.status, 'sent');
  assert.equal(finalized, true);
});

test('an expired event is terminalized before its payload is loaded or sent', async () => {
  const event = {
    id: '00000000-0000-4000-8000-000000000021',
    event_key: 'lead-created:00000000-0000-4000-8000-000000000022',
    event_type: 'lead_created' as const,
    bot_kind: 'b2b' as const,
    aggregate_type: 'lead' as const,
    aggregate_id: '00000000-0000-4000-8000-000000000022',
    payload_version: 1,
    payload: { version: 1 as const, text: 'expired' },
    payload_scrubbed_at: null,
    attachment_count: 0,
    attachments_expired_at: null,
    retry_expires_at: '2000-01-01T00:00:00.000Z',
    deliveries_expired_at: null,
    terminal_delivery_count: null,
    terminal_sent_part_count: null,
    status: 'processing' as const,
    attempt_count: 1,
    next_attempt_at: '2000-01-01T00:00:00.000Z',
    lease_owner: 'worker-test',
    lease_until: '2099-01-01T00:00:00.000Z',
    target_count: 1,
    last_error_code: null,
    sent_at: null,
    created_at: '2000-01-01T00:00:00.000Z',
    updated_at: '2000-01-01T00:00:00.000Z'
  };
  let expired = false;
  const unexpected = async () => {
    throw new Error('unexpected operation');
  };
  const dependencies: WorkerDependencies = {
    claim: async () => event,
    load: unexpected,
    extendLease: unexpected,
    listActiveChatIds: unexpected,
    deactivateChat: unexpected,
    sendPart: unexpected,
    logAttempt: () => undefined,
    markSent: unexpected,
    markSkipped: unexpected,
    markRetry: unexpected,
    markDead: unexpected,
    finalizeSent: unexpected,
    finalizeRetry: unexpected,
    finalizeDead: unexpected,
    finalizeExpired: async () => {
      expired = true;
      return true;
    }
  };

  assert.equal(isTelegramOutboxRetryExpired(event), true);
  assert.equal(
    await runTelegramOutboxWorkerCycle('worker-test', { dependencies }),
    true
  );
  assert.equal(expired, true);
});

test('the retry deadline is checked again before every network send', async () => {
  let clock = 1_000;
  const createdAt = new Date(clock).toISOString();
  const event = {
    id: '00000000-0000-4000-8000-000000000031',
    event_key: 'lead-created:00000000-0000-4000-8000-000000000032',
    event_type: 'lead_created' as const,
    bot_kind: 'main' as const,
    aggregate_type: 'lead' as const,
    aggregate_id: '00000000-0000-4000-8000-000000000032',
    payload_version: 1,
    payload: { version: 1 as const, text: 'deadline test' },
    payload_scrubbed_at: null,
    attachment_count: 0,
    attachments_expired_at: null,
    retry_expires_at: new Date(1_500).toISOString(),
    deliveries_expired_at: null,
    terminal_delivery_count: null,
    terminal_sent_part_count: null,
    status: 'processing' as const,
    attempt_count: 1,
    next_attempt_at: createdAt,
    lease_owner: 'worker-test',
    lease_until: new Date(60_000).toISOString(),
    target_count: 2,
    last_error_code: null,
    sent_at: null,
    created_at: createdAt,
    updated_at: createdAt
  };
  const bundle: TelegramOutboxBundle = {
    event,
    attachments: [],
    deliveries: ['-1001', '-1002'].map((chatId) => ({
      event_id: event.id,
      chat_id: chatId,
      part_no: 0,
      delivery_kind: 'text' as const,
      status: 'pending' as const,
      attempt_count: 0,
      next_attempt_at: createdAt,
      telegram_message_id: null,
      last_error_code: null,
      sent_at: null,
      created_at: createdAt,
      updated_at: createdAt
    }))
  };
  const sentTo: string[] = [];
  let expired = false;
  const unexpected = async () => {
    throw new Error('unexpected operation');
  };
  const dependencies: WorkerDependencies = {
    claim: async () => event,
    load: async () => bundle,
    extendLease: async () => true,
    listActiveChatIds: async () => ['-1001', '-1002'],
    deactivateChat: async () => undefined,
    sendPart: async (botKind, chatId) => {
      sentTo.push(chatId);
      clock = 2_000;
      return { botKind, chatId, messageId: 31 };
    },
    logAttempt: () => undefined,
    markSent: async () => true,
    markSkipped: unexpected,
    markRetry: unexpected,
    markDead: unexpected,
    finalizeSent: unexpected,
    finalizeRetry: unexpected,
    finalizeDead: unexpected,
    finalizeExpired: async () => {
      expired = true;
      return true;
    },
    now: () => clock
  };

  await runTelegramOutboxWorkerCycle('worker-test', { dependencies });
  assert.deepEqual(sentTo, ['-1001']);
  assert.equal(expired, true);
});
