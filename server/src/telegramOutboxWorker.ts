import { randomUUID } from 'crypto';
import {
  claimNextTelegramOutboxEvent,
  extendTelegramOutboxLease,
  finalizeTelegramOutboxEventDead,
  finalizeTelegramOutboxEventExpired,
  finalizeTelegramOutboxEventRetry,
  finalizeTelegramOutboxEventSent,
  loadTelegramOutboxEvent,
  markTelegramOutboxDeliveryDead,
  markTelegramOutboxDeliveryRetry,
  markTelegramOutboxDeliverySent,
  markTelegramOutboxDeliverySkipped,
  type TelegramOutboxBundle,
  type TelegramOutboxDeliveryRow,
  type TelegramOutboxErrorCode,
  type TelegramOutboxEventRow
} from './db/telegramOutbox';
import { logIntegrationEvent } from './integrationEvents';
import {
  deactivateTelegramChat,
  listActiveTelegramChatIds
} from './telegram';
import {
  sendTelegramPartToChat,
  TelegramDeliveryError,
  type TelegramDeliveryReceipt,
  type TelegramOutboundPart
} from './telegramTransport';

const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_MS = 15 * 60_000;
const RETRY_BASE_MS = 15_000;
const RETRY_CAP_MS = 60 * 60_000;

export type TelegramOutboxWorkerSnapshot = {
  running: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
};

const workerSnapshot: TelegramOutboxWorkerSnapshot = {
  running: false,
  lastAttemptAt: null,
  lastSuccessAt: null,
  consecutiveFailures: 0,
  lastErrorCode: null
};

export const getTelegramOutboxWorkerSnapshot = (): TelegramOutboxWorkerSnapshot => ({
  ...workerSnapshot
});

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

export const computeTelegramOutboxRetryDelayMs = (
  attempt: number,
  retryAfterSeconds: number | null = null,
  random: () => number = Math.random
): number => {
  if (
    typeof retryAfterSeconds === 'number' &&
    Number.isFinite(retryAfterSeconds) &&
    retryAfterSeconds >= 0
  ) {
    return Math.min(
      RETRY_CAP_MS,
      Math.max(1_000, Math.ceil(retryAfterSeconds * 1_000))
    );
  }
  const normalizedAttempt = Math.max(1, Math.min(20, Math.floor(attempt)));
  const ceiling = Math.min(
    RETRY_CAP_MS,
    RETRY_BASE_MS * 2 ** (normalizedAttempt - 1)
  );
  const randomValue = random();
  const sample = Number.isFinite(randomValue)
    ? Math.max(0, Math.min(1, randomValue))
    : 0.5;
  return Math.max(1_000, Math.floor(sample * ceiling));
};

export const classifyTelegramOutboxError = (
  error: unknown
): { code: TelegramOutboxErrorCode; permanent: boolean; retryAfterSeconds: number | null } => {
  if (!(error instanceof TelegramDeliveryError)) {
    return { code: 'unknown_error', permanent: false, retryAfterSeconds: null };
  }
  if (error.code === 'missing_token') {
    return { code: 'config_missing', permanent: false, retryAfterSeconds: null };
  }
  if (error.code === 'timeout') {
    return { code: 'timeout', permanent: false, retryAfterSeconds: null };
  }
  if (error.code === 'network_error' || error.code === 'circuit_open') {
    return {
      code: 'network_error',
      permanent: false,
      retryAfterSeconds: error.retryAfterSeconds
    };
  }
  if (error.code === 'chat_not_found') {
    return { code: 'telegram_chat_not_found', permanent: false, retryAfterSeconds: null };
  }
  if (error.code === 429) {
    return {
      code: 'telegram_rate_limited',
      permanent: false,
      retryAfterSeconds: error.retryAfterSeconds
    };
  }
  if (error.code === 401) {
    return { code: 'telegram_auth_error', permanent: false, retryAfterSeconds: null };
  }
  if (error.code === 403) {
    return { code: 'telegram_chat_blocked', permanent: true, retryAfterSeconds: null };
  }
  if (error.code === 400) {
    return { code: 'invalid_payload', permanent: true, retryAfterSeconds: null };
  }
  if (error.code === 'invalid_response') {
    return { code: 'telegram_api_error', permanent: false, retryAfterSeconds: null };
  }
  return {
    code: 'telegram_api_error',
    permanent: error.permanent,
    retryAfterSeconds: error.retryAfterSeconds
  };
};

export type WorkerDependencies = {
  claim(owner: string, leaseMs: number): Promise<TelegramOutboxEventRow | null>;
  load(eventId: string): Promise<TelegramOutboxBundle | null>;
  extendLease(eventId: string, owner: string, leaseMs: number): Promise<boolean>;
  listActiveChatIds(botKind: TelegramOutboxEventRow['bot_kind']): Promise<string[]>;
  deactivateChat(botKind: TelegramOutboxEventRow['bot_kind'], chatId: string): Promise<void>;
  sendPart(
    botKind: TelegramOutboxEventRow['bot_kind'],
    chatId: string,
    part: TelegramOutboundPart
  ): Promise<TelegramDeliveryReceipt>;
  logAttempt(
    event: TelegramOutboxEventRow,
    startedAt: number,
    errorCode?: TelegramOutboxErrorCode
  ): void;
  markSent: typeof markTelegramOutboxDeliverySent;
  markSkipped: typeof markTelegramOutboxDeliverySkipped;
  markRetry: typeof markTelegramOutboxDeliveryRetry;
  markDead: typeof markTelegramOutboxDeliveryDead;
  finalizeSent: typeof finalizeTelegramOutboxEventSent;
  finalizeRetry: typeof finalizeTelegramOutboxEventRetry;
  finalizeDead: typeof finalizeTelegramOutboxEventDead;
  finalizeExpired: typeof finalizeTelegramOutboxEventExpired;
  now?: () => number;
};

const defaultDependencies: WorkerDependencies = {
  claim: claimNextTelegramOutboxEvent,
  load: loadTelegramOutboxEvent,
  extendLease: extendTelegramOutboxLease,
  listActiveChatIds: listActiveTelegramChatIds,
  deactivateChat: deactivateTelegramChat,
  sendPart: sendTelegramPartToChat,
  logAttempt: logDeliveryAttempt,
  markSent: markTelegramOutboxDeliverySent,
  markSkipped: markTelegramOutboxDeliverySkipped,
  markRetry: markTelegramOutboxDeliveryRetry,
  markDead: markTelegramOutboxDeliveryDead,
  finalizeSent: finalizeTelegramOutboxEventSent,
  finalizeRetry: finalizeTelegramOutboxEventRetry,
  finalizeDead: finalizeTelegramOutboxEventDead,
  finalizeExpired: finalizeTelegramOutboxEventExpired
};

class TelegramOutboxLeaseLostError extends Error {
  constructor() {
    super('telegram_outbox_lease_lost');
    this.name = 'TelegramOutboxLeaseLostError';
  }
}

const requireMutation = async (mutation: Promise<boolean>) => {
  if (!(await mutation)) throw new TelegramOutboxLeaseLostError();
};

export const isTelegramOutboxRetryExpired = (
  event: Pick<TelegramOutboxEventRow, 'retry_expires_at'>,
  now = Date.now()
) => {
  const deadline = Date.parse(event.retry_expires_at);
  return !Number.isFinite(deadline) || deadline <= now;
};

const buildPart = (
  bundle: TelegramOutboxBundle,
  delivery: TelegramOutboxDeliveryRow
): TelegramOutboundPart | null => {
  if (delivery.delivery_kind === 'text' && delivery.part_no === 0) {
    return { type: 'text', text: bundle.event.payload.text };
  }
  if (delivery.delivery_kind !== 'document' || delivery.part_no < 1) return null;
  const attachment = bundle.attachments.find(
    (candidate) => candidate.part_no === delivery.part_no
  );
  if (!attachment?.bytes) return null;
  return {
    type: 'document',
    bytes: attachment.bytes,
    fileName: attachment.file_name,
    mimeType: attachment.mime_type,
    caption: attachment.file_name
  };
};

function logDeliveryAttempt(
  event: TelegramOutboxEventRow,
  startedAt: number,
  errorCode?: TelegramOutboxErrorCode
) {
  void logIntegrationEvent({
    provider: 'telegram',
    operation: `outbox_${event.bot_kind}`,
    attempt: event.attempt_count,
    latencyMs: Date.now() - startedAt,
    fallbackUsed: false,
    error: errorCode ?? null
  });
}

const deliveryKey = (delivery: TelegramOutboxDeliveryRow) =>
  `${delivery.chat_id}:${delivery.part_no}`;

const processClaimedEvent = async (
  claimed: TelegramOutboxEventRow,
  owner: string,
  leaseMs: number,
  dependencies: WorkerDependencies
): Promise<void> => {
  const now = () => dependencies.now?.() ?? Date.now();
  if (isTelegramOutboxRetryExpired(claimed, now())) {
    await requireMutation(dependencies.finalizeExpired(claimed.id, owner));
    return;
  }
  const bundle = await dependencies.load(claimed.id);
  if (!bundle) throw new TelegramOutboxLeaseLostError();

  const activeChatIds = new Set(
    await dependencies.listActiveChatIds(bundle.event.bot_kind)
  );
  const mutableDeliveries = new Map(
    bundle.deliveries.map((delivery) => [deliveryKey(delivery), { ...delivery }])
  );
  const blockedChats = new Set<string>();
  const dueAt = now();

  for (const original of bundle.deliveries) {
    const delivery = mutableDeliveries.get(deliveryKey(original)) ?? original;
    if (delivery.status !== 'pending') continue;
    if (Date.parse(delivery.next_attempt_at) > dueAt) continue;

    const mutationInput = {
      eventId: bundle.event.id,
      owner,
      chatId: delivery.chat_id,
      partNo: delivery.part_no
    };
    const previous =
      delivery.part_no > 0
        ? mutableDeliveries.get(`${delivery.chat_id}:${delivery.part_no - 1}`)
        : undefined;

    const leaseExtended = await dependencies.extendLease(
      bundle.event.id,
      owner,
      leaseMs
    );
    if (!leaseExtended) {
      if (await dependencies.finalizeExpired(bundle.event.id, owner)) return;
      throw new TelegramOutboxLeaseLostError();
    }
    if (isTelegramOutboxRetryExpired(bundle.event, now())) {
      await requireMutation(
        dependencies.finalizeExpired(bundle.event.id, owner)
      );
      return;
    }

    if (!activeChatIds.has(delivery.chat_id) || blockedChats.has(delivery.chat_id)) {
      const code: TelegramOutboxErrorCode = activeChatIds.has(delivery.chat_id)
        ? 'telegram_chat_blocked'
        : 'subscriber_inactive';
      await requireMutation(
        dependencies.markSkipped({ ...mutationInput, errorCode: code })
      );
      delivery.status = 'skipped';
      delivery.last_error_code = code;
      continue;
    }
    if (previous?.status === 'pending') continue;
    if (previous?.status === 'skipped') {
      const code = previous.last_error_code ?? 'subscriber_inactive';
      await requireMutation(dependencies.markSkipped({ ...mutationInput, errorCode: code }));
      delivery.status = 'skipped';
      delivery.last_error_code = code;
      continue;
    }
    if (previous?.status === 'dead') {
      const code = previous.last_error_code ?? 'max_attempts';
      await requireMutation(dependencies.markDead({ ...mutationInput, errorCode: code }));
      delivery.status = 'dead';
      delivery.last_error_code = code;
      continue;
    }

    const part = buildPart(bundle, delivery);
    if (!part) {
      await requireMutation(
        dependencies.markDead({ ...mutationInput, errorCode: 'attachment_missing' })
      );
      delivery.status = 'dead';
      delivery.last_error_code = 'attachment_missing';
      continue;
    }

    const startedAt = Date.now();
    try {
      const receipt = await dependencies.sendPart(
        bundle.event.bot_kind,
        delivery.chat_id,
        part
      );
      if (receipt.chatId !== delivery.chat_id) {
        await requireMutation(
          dependencies.markDead({ ...mutationInput, errorCode: 'invalid_payload' })
        );
        delivery.status = 'dead';
        delivery.last_error_code = 'invalid_payload';
        dependencies.logAttempt(bundle.event, startedAt, 'invalid_payload');
        continue;
      }
      await requireMutation(
        dependencies.markSent({
          ...mutationInput,
          telegramMessageId: receipt.messageId
        })
      );
      delivery.status = 'sent';
      delivery.last_error_code = null;
      dependencies.logAttempt(bundle.event, startedAt);
    } catch (error) {
      if (error instanceof TelegramOutboxLeaseLostError) throw error;
      const classified = classifyTelegramOutboxError(error);
      dependencies.logAttempt(bundle.event, startedAt, classified.code);
      if (
        classified.code === 'telegram_chat_blocked' ||
        classified.code === 'telegram_chat_not_found'
      ) {
        await dependencies.deactivateChat(bundle.event.bot_kind, delivery.chat_id).catch(
          () => undefined
        );
        blockedChats.add(delivery.chat_id);
        await requireMutation(
          dependencies.markSkipped({ ...mutationInput, errorCode: classified.code })
        );
        delivery.status = 'skipped';
        delivery.last_error_code = classified.code;
      } else if (classified.permanent) {
        const code = classified.code;
        await requireMutation(dependencies.markDead({ ...mutationInput, errorCode: code }));
        delivery.status = 'dead';
        delivery.last_error_code = code;
      } else {
        const retryAfterMs = computeTelegramOutboxRetryDelayMs(
          delivery.attempt_count + 1,
          classified.retryAfterSeconds
        );
        await requireMutation(
          dependencies.markRetry({
            ...mutationInput,
            errorCode: classified.code,
            retryAfterMs
          })
        );
        delivery.next_attempt_at = new Date(Date.now() + retryAfterMs).toISOString();
        delivery.last_error_code = classified.code;
      }
    }
  }

  const refreshed = await dependencies.load(bundle.event.id);
  if (!refreshed) throw new TelegramOutboxLeaseLostError();
  const deadDelivery = refreshed.deliveries.find((delivery) => delivery.status === 'dead');
  if (deadDelivery) {
    if (await dependencies.finalizeExpired(refreshed.event.id, owner)) return;
    await requireMutation(
      dependencies.finalizeDead(
        refreshed.event.id,
        owner,
        deadDelivery.last_error_code ?? 'max_attempts'
      )
    );
    return;
  }

  const pendingDeliveries = refreshed.deliveries.filter(
    (delivery) => delivery.status === 'pending'
  );
  if (pendingDeliveries.length > 0) {
    if (await dependencies.finalizeExpired(refreshed.event.id, owner)) return;
    const earliestRetryAt = Math.min(
      ...pendingDeliveries.map((delivery) => Date.parse(delivery.next_attempt_at))
    );
    const retryAfterMs = Number.isFinite(earliestRetryAt)
      ? Math.max(1_000, earliestRetryAt - Date.now())
      : computeTelegramOutboxRetryDelayMs(refreshed.event.attempt_count);
    await requireMutation(
      dependencies.finalizeRetry(
        refreshed.event.id,
        owner,
        pendingDeliveries.find((delivery) => delivery.last_error_code)?.last_error_code ??
          'unknown_error',
        retryAfterMs
      )
    );
    return;
  }

  if (await dependencies.finalizeSent(refreshed.event.id, owner)) return;
  if (await dependencies.finalizeExpired(refreshed.event.id, owner)) return;
  await requireMutation(dependencies.finalizeDead(refreshed.event.id, owner, 'no_targets'));
};

export const runTelegramOutboxWorkerCycle = async (
  owner: string,
  options: {
    leaseMs?: number;
    dependencies?: WorkerDependencies;
  } = {}
): Promise<boolean> => {
  const dependencies = options.dependencies ?? defaultDependencies;
  const claimed = await dependencies.claim(owner, options.leaseMs ?? DEFAULT_LEASE_MS);
  if (!claimed) return false;
  await processClaimedEvent(
    claimed,
    owner,
    options.leaseMs ?? DEFAULT_LEASE_MS,
    dependencies
  );
  return true;
};

let workerStarted = false;

export const startTelegramOutboxWorker = () => {
  if (workerStarted) return;
  workerStarted = true;
  workerSnapshot.running = true;
  const owner = `worker-${process.pid}-${randomUUID()}`;
  const intervalMs = parseBoundedInteger(
    process.env.TELEGRAM_OUTBOX_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    100,
    60_000
  );
  const leaseMs = parseBoundedInteger(
    process.env.TELEGRAM_OUTBOX_LEASE_MS,
    DEFAULT_LEASE_MS,
    30_000,
    60 * 60_000
  );
  const run = async () => {
    workerSnapshot.lastAttemptAt = new Date().toISOString();
    try {
      await runTelegramOutboxWorkerCycle(owner, { leaseMs });
      workerSnapshot.lastSuccessAt = new Date().toISOString();
      workerSnapshot.consecutiveFailures = 0;
      workerSnapshot.lastErrorCode = null;
    } catch (error) {
      workerSnapshot.consecutiveFailures += 1;
      workerSnapshot.lastErrorCode =
        error instanceof TelegramOutboxLeaseLostError
          ? 'lease_lost'
          : 'worker_cycle_failed';
      void logIntegrationEvent({
        provider: 'telegram',
        operation: 'outbox_worker',
        fallbackUsed: false,
        error: workerSnapshot.lastErrorCode
      });
    } finally {
      setTimeout(() => void run(), intervalMs);
    }
  };

  void run();
};
