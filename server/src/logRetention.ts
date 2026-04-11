import { query } from './db';

type RetentionTableConfig = {
  table: string;
  retentionDays: number;
};

const parsePositiveIntEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const parseNonNegativeIntEnv = (value: string | undefined, fallback: number) => {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
};

const parseBoolEnv = (value: string | undefined, fallback: boolean) => {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return fallback;
};

const LOG_RETENTION_ENABLED = parseBoolEnv(process.env.LOG_RETENTION_ENABLED, true);
const LOG_RETENTION_DEFAULT_DAYS = parsePositiveIntEnv(process.env.LOG_RETENTION_DEFAULT_DAYS, 90);
const LOG_RETENTION_RUN_INTERVAL_SECONDS = parsePositiveIntEnv(
  process.env.LOG_RETENTION_RUN_INTERVAL_SECONDS,
  21_600
);
const LOG_RETENTION_BATCH_SIZE = parsePositiveIntEnv(process.env.LOG_RETENTION_BATCH_SIZE, 2000);
const LOG_RETENTION_MAX_BATCHES_PER_TABLE = parsePositiveIntEnv(
  process.env.LOG_RETENTION_MAX_BATCHES_PER_TABLE,
  100
);

const buildRetentionTables = (): RetentionTableConfig[] => [
  {
    table: 'security_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.SECURITY_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'order_lifecycle_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.ORDER_LIFECYCLE_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'admin_audit_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.ADMIN_AUDIT_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'integration_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.INTEGRATION_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'error_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.ERROR_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'phone_code_delivery_events',
    retentionDays: parseNonNegativeIntEnv(
      process.env.PHONE_CODE_DELIVERY_EVENTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  },
  {
    table: 'lead_requests',
    retentionDays: parseNonNegativeIntEnv(
      process.env.LEAD_REQUESTS_RETENTION_DAYS,
      LOG_RETENTION_DEFAULT_DAYS
    )
  }
];

const deleteExpiredRowsBatch = async (
  table: string,
  retentionDays: number
): Promise<number> => {
  const result = await query(
    `
      WITH expired AS (
        SELECT ctid
        FROM ${table}
        WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
        LIMIT $2
      )
      DELETE FROM ${table}
      WHERE ctid IN (SELECT ctid FROM expired);
    `,
    [retentionDays, LOG_RETENTION_BATCH_SIZE]
  );

  return result.rowCount ?? 0;
};

const cleanupTable = async (table: string, retentionDays: number) => {
  let totalDeleted = 0;
  for (let batch = 0; batch < LOG_RETENTION_MAX_BATCHES_PER_TABLE; batch += 1) {
    const deleted = await deleteExpiredRowsBatch(table, retentionDays);
    totalDeleted += deleted;
    if (deleted < LOG_RETENTION_BATCH_SIZE) {
      break;
    }
  }
  return totalDeleted;
};

export const runLogRetentionCleanup = async () => {
  const tableConfigs = buildRetentionTables();
  let totalDeleted = 0;

  for (const config of tableConfigs) {
    if (config.retentionDays <= 0) {
      continue;
    }
    try {
      const deleted = await cleanupTable(config.table, config.retentionDays);
      totalDeleted += deleted;
      if (deleted > 0) {
        console.log(
          `[log-retention] ${config.table}: deleted ${deleted} rows older than ${config.retentionDays} days`
        );
      }
    } catch (error) {
      console.error(`[log-retention] Failed to cleanup ${config.table}`, error);
    }
  }

  return totalDeleted;
};

export const startLogRetentionScheduler = () => {
  if (!LOG_RETENTION_ENABLED) {
    console.log('[log-retention] disabled');
    return () => undefined;
  }

  const intervalMs = LOG_RETENTION_RUN_INTERVAL_SECONDS * 1000;
  let isRunning = false;

  const runOnce = async () => {
    if (isRunning) {
      return;
    }
    isRunning = true;
    try {
      await runLogRetentionCleanup();
    } finally {
      isRunning = false;
    }
  };

  void runOnce();
  const timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  timer.unref?.();

  console.log(
    `[log-retention] enabled, interval=${LOG_RETENTION_RUN_INTERVAL_SECONDS}s, defaultDays=${LOG_RETENTION_DEFAULT_DAYS}`
  );

  return () => {
    clearInterval(timer);
  };
};
