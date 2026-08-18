import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotificationHealthReport } from './notificationHealth';
import {
  ACTIVE_YOOKASSA_WITHOUT_STOCK_RESERVATION_DRIFT_SQL,
  SENT_OUTBOX_RETENTION_DRIFT_SQL
} from './db/telegramOutbox';

test('notification health rejects an invalid overdue threshold before opening PostgreSQL', async () => {
  await assert.rejects(
    () =>
      createNotificationHealthReport({
        now: Date.parse('2026-08-09T00:00:00.000Z'),
        overdueMs: 0
      }),
    /Invalid overdueMs/
  );
});

test('notification health rejects an invalid retention threshold before opening PostgreSQL', async () => {
  await assert.rejects(
    () =>
      createNotificationHealthReport({
        now: Date.parse('2026-08-09T00:00:00.000Z'),
        overdueMs: 300_000,
        retentionDays: 0
      }),
    /Invalid retentionDays/
  );
});

test('notification health maps healthy dependencies to the monitor contract', async () => {
  const now = Date.parse('2026-08-09T00:00:00.000Z');
  const lastSuccessAt = new Date(now - 1_000).toISOString();
  let databaseArguments: [number, number] | null = null;
  const report = await createNotificationHealthReport({
    now,
    overdueMs: 300_000,
    retentionDays: 45,
    workerStaleMs: 120_000,
    pollingStaleMs: 120_000,
    dependencies: {
      loadDatabase: async (overdueMs, retentionDays) => {
        databaseArguments = [overdueMs ?? -1, retentionDays ?? -1];
        return ({
        eventCounts: {
          pending: 0, processing: 0, retry: 0, sent: 4, dead: 0,
          acknowledgedDead: 1, total: 5
        },
        oldestPendingAt: null,
        oldestPendingAgeSeconds: null,
        privacyRetentionDrift: 0,
        stockReservationDrift: 0,
        paidInvariant: {
          required: 2,
          notified: 2,
          awaitingNotification: 0,
          overdueNotification: 0,
          missingOutboxEvent: 0,
          requiredMarkerDrift: 0,
          sentMarkerDrift: 0,
          paymentStatusDrift: 0
        },
        leadNotifications: { pending: 0, sent: 2, failed: 0 }
      });
      },
      getWorkerSnapshot: () => ({
        running: true,
        lastAttemptAt: lastSuccessAt,
        lastSuccessAt,
        consecutiveFailures: 0,
        lastErrorCode: null
      }),
      getRuntimeSnapshot: () => ({
        main: {
          kind: 'main', mode: 'polling', tokenConfigured: true,
          webhookSecretConfigured: false, expectedWebhookUrl: null,
          allowedChatIds: ['1001'], running: true, lastAttemptAt: lastSuccessAt,
          lastSuccessAt, consecutiveFailures: 0, lastErrorCode: null
        },
        orders: {
          kind: 'orders', mode: 'webhook', tokenConfigured: true,
          webhookSecretConfigured: true,
          expectedWebhookUrl: 'https://example.test/api/telegram/orders-webhook',
          allowedChatIds: ['1002'], running: true, lastAttemptAt: null,
          lastSuccessAt: null, consecutiveFailures: 0, lastErrorCode: null
        },
        b2b: {
          kind: 'b2b', mode: 'disabled', tokenConfigured: true,
          webhookSecretConfigured: false, expectedWebhookUrl: null,
          allowedChatIds: ['1003'], running: false, lastAttemptAt: null,
          lastSuccessAt: null, consecutiveFailures: 0, lastErrorCode: null
        }
      }),
      getProbeSnapshot: () => ({
        main: {
          running: true, lastAttemptAt: lastSuccessAt, lastSuccessAt,
          consecutiveFailures: 0, lastErrorCode: null, botId: '101', username: 'main_bot'
        },
        orders: {
          running: true, lastAttemptAt: lastSuccessAt, lastSuccessAt,
          consecutiveFailures: 0, lastErrorCode: null, botId: '102', username: 'orders_bot'
        },
        b2b: {
          running: true, lastAttemptAt: lastSuccessAt, lastSuccessAt,
          consecutiveFailures: 0, lastErrorCode: null, botId: '103', username: 'b2b_bot'
        }
      }),
      listActiveChatIds: async (kind) => [
        kind === 'main' ? '1001' : kind === 'orders' ? '1002' : '1003'
      ]
    }
  });

  assert.equal(report.status, 'ok');
  assert.deepEqual(databaseArguments, [300_000, 45]);
  assert.deepEqual(report.outbox, {
    pending: 0,
    retry: 0,
    dead: 0,
    acknowledgedDead: 1,
    oldestPendingAgeMs: 0
  });
  assert.deepEqual(report.invariants, {
    paidWithoutOutbox: 0,
    overduePaidNotifications: 0,
    paymentStatusDrift: 0,
    stockReservationDrift: 0,
    notificationMarkerDrift: 0,
    failedLeadNotifications: 0,
    piiRetentionDrift: 0
  });
});

test('notification health SQL detects only provably active YooKassa attempts without stock', () => {
  const normalized = ACTIVE_YOOKASSA_WITHOUT_STOCK_RESERVATION_DRIFT_SQL.replace(
    /\s+/g,
    ' '
  );
  assert.match(normalized, /orders\.status = 'pending'/);
  assert.match(normalized, /orders\.payment_provider = 'yookassa'/);
  assert.match(normalized, /orders\.stock_reservation_status IS NULL/);
  assert.match(
    normalized,
    /orders\.payment_id IS NOT NULL OR orders\.payment_status = 'creating'/
  );
  assert.match(
    normalized,
    /orders\.payment_status IS NULL OR orders\.payment_status NOT IN \('canceled', 'succeeded'\)/
  );
});

test('notification health SQL detects sent rows only after the configured retention boundary', () => {
  const normalized = SENT_OUTBOX_RETENTION_DRIFT_SQL.replace(/\s+/g, ' ');
  assert.match(normalized, /events\.status = 'sent'/);
  assert.match(normalized, /events\.sent_at IS NULL/);
  assert.match(
    normalized,
    /events\.sent_at < NOW\(\) - \(\$2::int \* INTERVAL '1 day'\)/
  );
});
