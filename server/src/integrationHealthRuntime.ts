import { queryWithTimeout } from './db';
import { getReadinessReport, type ReadinessReport } from './health';
import { getNotificationHealthReport, type NotificationHealthReport } from './notificationHealth';
import {
  createIntegrationHealthChecker, summarizeIntegrations,
  type IntegrationCheck, type IntegrationHealthReport, type ShippingModes
} from './integrationHealth';

const loadShippingModes = async (signal: AbortSignal): Promise<ShippingModes> => {
  signal.throwIfAborted();
  const result = await queryWithTimeout('SELECT key, is_enabled FROM delivery_providers', 1_000);
  signal.throwIfAborted();
  const modes = Object.fromEntries(result.rows.map((row) => [row.key, row.is_enabled]));
  for (const key of ['cdek', 'dellin', 'russian_post']) {
    if (typeof modes[key] !== 'boolean') throw new Error('Shipping modes unavailable');
  }
  return modes as ShippingModes;
};

export const createFullIntegrationHealthChecker = (options: {
  providers?: () => Promise<IntegrationHealthReport>;
  readiness?: () => Promise<ReadinessReport>;
  notifications?: () => Promise<NotificationHealthReport>;
  now?: () => number;
  coreTimeoutMs?: number;
  cacheTtlMs?: number;
} = {}) => {
  const providers = options.providers ?? createIntegrationHealthChecker({ shippingModes: loadShippingModes });
  const readiness = options.readiness ?? getReadinessReport;
  const notifications = options.notifications ?? getNotificationHealthReport;
  const now = options.now ?? Date.now;
  const timeoutMs = options.coreTimeoutMs ?? 3_500;
  let cached: { report: IntegrationHealthReport; expires: number } | undefined;
  let inFlight: Promise<IntegrationHealthReport> | undefined;

  const bounded = async <T>(probe: () => Promise<T>): Promise<T | null> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([probe(), new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      })]);
    } catch { return null; }
    finally { if (timer) clearTimeout(timer); }
  };

  const collect = async (): Promise<IntegrationHealthReport> => {
    const start = now();
    const [external, ready, telegram] = await Promise.all([
      providers(), bounded(readiness), bounded(notifications)
    ]);
    const checkedAt = new Date(now()).toISOString();
    const checks = { ...external.checks };
    const core = (ok: boolean, code: string, stamp = checkedAt): IntegrationCheck => ({
      status: ok ? 'ok' : 'error', code, coverage: 'runtime', checkedAt: stamp, latencyMs: 0
    });
    checks.postgres = core(ready?.checks.postgres.status === 'ok',
      ready?.checks.postgres.status === 'ok' ? 'query_succeeded' : 'database_check_failed', ready?.checkedAt);
    checks.uploads = core(ready?.checks.uploads.status === 'ok',
      ready?.checks.uploads.status === 'ok' ? 'write_read_delete_succeeded' : 'uploads_check_failed', ready?.checkedAt);
    checks.telegram = core(telegram?.status === 'ok',
      telegram?.status === 'ok' ? 'runtime_and_delivery_queue_healthy' : 'notification_pipeline_failed', telegram?.checkedAt);
    return summarizeIntegrations(checks, checkedAt, Math.max(0, now() - start));
  };
  return async () => {
    if (cached && cached.expires > now()) return cached.report;
    if (inFlight) return inFlight;
    inFlight = collect();
    try {
      const report = await inFlight;
      cached = { report, expires: now() + (options.cacheTtlMs ?? 5_000) };
      return report;
    } finally { inFlight = undefined; }
  };
};

export const getIntegrationHealthReport = createFullIntegrationHealthChecker();
