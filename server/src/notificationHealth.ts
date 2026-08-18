import { performance } from 'perf_hooks';
import { getTelegramNotificationHealth } from './db/telegramOutbox';
import {
  getTelegramBotProbeSnapshot,
  getTelegramRuntimeSnapshot,
  listActiveTelegramChatIds
} from './telegram';
import { getTelegramOutboxWorkerSnapshot } from './telegramOutboxWorker';
import { getTelegramOutboxRetentionDays } from './telegramOutboxConfig';
import type {
  TelegramBotKind,
  TelegramRuntimeState
} from './telegramTransport';
import type { TelegramBotProbeState } from './telegram';

const DEFAULT_OVERDUE_MS = 5 * 60_000;
const DEFAULT_WORKER_STALE_MS = 2 * 60_000;
const DEFAULT_POLLING_STALE_MS = 2 * 60_000;
const DEFAULT_PROBE_STALE_MS = 2 * 60_000;
const DEFAULT_CACHE_TTL_MS = 5_000;

const parseBoundedInteger = (
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const isFreshTimestamp = (value: string | null, now: number, maxAgeMs: number) => {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + maxAgeMs && now - timestamp <= maxAgeMs;
};

const botHealth = (
  kind: TelegramBotKind,
  runtime: TelegramRuntimeState,
  probe: TelegramBotProbeState,
  activeTargets: number,
  now: number,
  pollingStaleMs: number,
  probeStaleMs: number
) => {
  const inboundSucceeded =
    runtime.mode === 'disabled' ||
    (runtime.mode === 'webhook'
      ? runtime.running && runtime.consecutiveFailures === 0
      : runtime.running &&
        runtime.consecutiveFailures === 0 &&
        isFreshTimestamp(runtime.lastSuccessAt, now, pollingStaleMs));
  const outboundEnabled = runtime.tokenConfigured;
  const outboundSucceeded =
    !outboundEnabled ||
    (activeTargets > 0 &&
      probe.running &&
      probe.consecutiveFailures === 0 &&
      probe.botId !== null &&
      probe.username !== null &&
      isFreshTimestamp(probe.lastSuccessAt, now, probeStaleMs));
  return {
    kind,
    mode: runtime.mode,
    outboundEnabled,
    activeTargets,
    status: inboundSucceeded && outboundSucceeded ? ('ok' as const) : ('error' as const),
    ...(probe.botId ? { botId: probe.botId } : {}),
    ...(probe.username ? { username: probe.username } : {}),
    ...(probe.lastSuccessAt ? { lastSuccessAt: probe.lastSuccessAt } : {})
  };
};

export type NotificationHealthReport = {
  status: 'ok' | 'error';
  checkedAt: string;
  worker: {
    status: 'ok' | 'error';
    lastSuccessAt: string | null;
  };
  outbox: {
    pending: number;
    retry: number;
    dead: number;
    acknowledgedDead: number;
    oldestPendingAgeMs: number;
  };
  invariants: {
    paidWithoutOutbox: number;
    overduePaidNotifications: number;
    paymentStatusDrift: number;
    stockReservationDrift: number;
    notificationMarkerDrift: number;
    failedLeadNotifications: number;
    piiRetentionDrift: number;
  };
  bots: Array<{
    kind: TelegramBotKind;
    mode: TelegramRuntimeState['mode'];
    outboundEnabled: boolean;
    activeTargets: number;
    status: 'ok' | 'error';
    botId?: string;
    username?: string;
    lastSuccessAt?: string;
  }>;
};

type NotificationHealthDependencies = {
  loadDatabase: typeof getTelegramNotificationHealth;
  getWorkerSnapshot: typeof getTelegramOutboxWorkerSnapshot;
  getRuntimeSnapshot: typeof getTelegramRuntimeSnapshot;
  getProbeSnapshot: typeof getTelegramBotProbeSnapshot;
  listActiveChatIds: typeof listActiveTelegramChatIds;
};

const defaultDependencies: NotificationHealthDependencies = {
  loadDatabase: getTelegramNotificationHealth,
  getWorkerSnapshot: getTelegramOutboxWorkerSnapshot,
  getRuntimeSnapshot: getTelegramRuntimeSnapshot,
  getProbeSnapshot: getTelegramBotProbeSnapshot,
  listActiveChatIds: listActiveTelegramChatIds
};

export const createNotificationHealthReport = async (
  options: {
    now?: number;
    overdueMs?: number;
    retentionDays?: number;
    workerStaleMs?: number;
    pollingStaleMs?: number;
    probeStaleMs?: number;
    dependencies?: NotificationHealthDependencies;
  } = {}
): Promise<NotificationHealthReport> => {
  const now = options.now ?? Date.now();
  const checkedAt = new Date(now).toISOString();
  const overdueMs =
    options.overdueMs ??
    parseBoundedInteger(
      process.env.TELEGRAM_OUTBOX_OVERDUE_MS,
      DEFAULT_OVERDUE_MS,
      1_000,
      86_400_000
    );
  const retentionDays =
    options.retentionDays ?? getTelegramOutboxRetentionDays();
  const workerStaleMs =
    options.workerStaleMs ??
    parseBoundedInteger(
      process.env.TELEGRAM_OUTBOX_WORKER_STALE_MS,
      DEFAULT_WORKER_STALE_MS,
      10_000,
      86_400_000
    );
  const pollingStaleMs =
    options.pollingStaleMs ??
    parseBoundedInteger(
      process.env.TELEGRAM_POLLING_STALE_MS,
      DEFAULT_POLLING_STALE_MS,
      30_000,
      86_400_000
    );
  const probeStaleMs =
    options.probeStaleMs ??
    parseBoundedInteger(
      process.env.TELEGRAM_RUNTIME_PROBE_STALE_MS,
      DEFAULT_PROBE_STALE_MS,
      30_000,
      86_400_000
    );

  const dependencies = options.dependencies ?? defaultDependencies;
  const [database, ...targetLists] = await Promise.all([
    dependencies.loadDatabase(overdueMs, retentionDays),
    ...(['main', 'orders', 'b2b'] as const).map((kind) =>
      dependencies.listActiveChatIds(kind)
    )
  ]);
  const workerRuntime = dependencies.getWorkerSnapshot();
  const telegramRuntime = dependencies.getRuntimeSnapshot();
  const telegramProbes = dependencies.getProbeSnapshot();
  const workerOk =
    workerRuntime.running &&
    workerRuntime.consecutiveFailures === 0 &&
    isFreshTimestamp(workerRuntime.lastSuccessAt, now, workerStaleMs);
  const bots = (['main', 'orders', 'b2b'] as const).map((kind, index) =>
    botHealth(
      kind,
      telegramRuntime[kind],
      telegramProbes[kind],
      targetLists[index]?.length ?? 0,
      now,
      pollingStaleMs,
      probeStaleMs
    )
  );
  const oldestPendingAgeMs = (database.oldestPendingAgeSeconds ?? 0) * 1_000;
  const invariants = {
    paidWithoutOutbox: database.paidInvariant.missingOutboxEvent,
    overduePaidNotifications: database.paidInvariant.overdueNotification,
    paymentStatusDrift: database.paidInvariant.paymentStatusDrift,
    stockReservationDrift: database.stockReservationDrift,
    notificationMarkerDrift:
      database.paidInvariant.requiredMarkerDrift +
      database.paidInvariant.sentMarkerDrift,
    failedLeadNotifications: database.leadNotifications.failed
    ,
    piiRetentionDrift: database.privacyRetentionDrift
  };
  const outbox = {
    pending: database.eventCounts.pending + database.eventCounts.processing,
    retry: database.eventCounts.retry,
    dead: database.eventCounts.dead,
    acknowledgedDead: database.eventCounts.acknowledgedDead,
    oldestPendingAgeMs
  };
  const status =
    workerOk &&
    bots.every((bot) => bot.status === 'ok') &&
    outbox.dead === 0 &&
    oldestPendingAgeMs <= overdueMs &&
    Object.values(invariants).every((count) => count === 0)
      ? 'ok'
      : 'error';

  return {
    status,
    checkedAt,
    worker: {
      status: workerOk ? 'ok' : 'error',
      lastSuccessAt: workerRuntime.lastSuccessAt
    },
    outbox,
    invariants,
    bots
  };
};

export const createCachedNotificationHealthChecker = (
  probe: () => Promise<NotificationHealthReport> = createNotificationHealthReport,
  cacheTtl: () => number = () =>
    parseBoundedInteger(
      process.env.NOTIFICATION_HEALTH_CACHE_TTL_MS,
      DEFAULT_CACHE_TTL_MS,
      250,
      60_000
    ),
  now: () => number = performance.now
) => {
  let cached: { report: NotificationHealthReport; expiresAt: number } | undefined;
  let inFlight: Promise<NotificationHealthReport> | undefined;

  return async () => {
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) return cached.report;
    if (inFlight) return inFlight;
    inFlight = probe();
    try {
      const report = await inFlight;
      cached = { report, expiresAt: now() + cacheTtl() };
      return report;
    } finally {
      inFlight = undefined;
    }
  };
};

export const getNotificationHealthReport = createCachedNotificationHealthChecker();
