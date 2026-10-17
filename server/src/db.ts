import { Pool, type PoolClient, type PoolConfig, type QueryConfig } from 'pg';
import { createShutdownFence } from './shutdownFence';

let pool: Pool | null = null;
let healthPool: Pool | null = null;
let healthPoolPhaseTimeoutMs: number | null = null;
const databaseShutdownFence = createShutdownFence();
const retiredHealthPoolCloses = new Set<Promise<void>>();
let retiredHealthPoolCloseFailed = false;

const assertDatabaseAvailable = () => {
  databaseShutdownFence.assertOpen('Database is shutting down');
};

const trackRetiredHealthPoolClose = (retiredPool: Pool) => {
  const closePromise = retiredPool.end();
  retiredHealthPoolCloses.add(closePromise);
  void closePromise.then(
    () => {
      retiredHealthPoolCloses.delete(closePromise);
    },
    () => {
      retiredHealthPoolCloseFailed = true;
      retiredHealthPoolCloses.delete(closePromise);
    }
  );
};

const parseBoundedPositiveInt = (
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
) => {
  const raw = value?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
};

const getDatabaseUrl = () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return databaseUrl;
};

const createSafePool = (config: PoolConfig, label: string) => {
  const createdPool = new Pool(config);
  createdPool.on('error', () => {
    console.error(`[DATABASE] ${label} pool lost an idle client`);
  });
  return createdPool;
};

const getPool = () => {
  assertDatabaseAvailable();

  if (pool) {
    return pool;
  }

  pool = createSafePool({
    connectionString: getDatabaseUrl(),
    connectionTimeoutMillis: parseBoundedPositiveInt(
      process.env.DATABASE_CONNECT_TIMEOUT_MS,
      10_000,
      250,
      30_000
    )
  }, 'application');

  return pool;
};

export const query = (
  text: string,
  params?: Array<string | number | boolean | string[] | null>
) =>
  getPool().query(text, params);

export const queryWithTimeout = (
  text: string,
  timeoutMs: number,
  params?: Array<string | number | boolean | string[] | null>
) => {
  assertDatabaseAvailable();

  const phaseTimeoutMs = Math.max(1, Math.floor(timeoutMs / 2));
  if (!healthPool || healthPoolPhaseTimeoutMs !== phaseTimeoutMs) {
    const previousPool = healthPool;
    healthPool = createSafePool({
      connectionString: getDatabaseUrl(),
      connectionTimeoutMillis: phaseTimeoutMs,
      idleTimeoutMillis: 30_000,
      max: 1,
      allowExitOnIdle: true
    }, 'health');
    healthPoolPhaseTimeoutMs = phaseTimeoutMs;
    if (previousPool) {
      trackRetiredHealthPoolClose(previousPool);
    }
  }
  const config = {
    text,
    values: params,
    query_timeout: phaseTimeoutMs
  };
  return healthPool.query(
    config as QueryConfig<Array<string | number | boolean | string[] | null>>
  );
};

export const withClient = async <T>(handler: (client: PoolClient) => Promise<T>) => {
  const client = await getPool().connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
};

export const closeDatabasePools = (): Promise<void> => {
  return databaseShutdownFence.closeOnce(async () => {
    const applicationPool = pool;
    const readinessPool = healthPool;
    pool = null;
    healthPool = null;
    healthPoolPhaseTimeoutMs = null;

    const closes: Promise<void>[] = [...retiredHealthPoolCloses];
    if (applicationPool) {
      closes.push(Promise.resolve().then(() => applicationPool.end()));
    }
    if (readinessPool && readinessPool !== applicationPool) {
      closes.push(Promise.resolve().then(() => readinessPool.end()));
    }

    const results = await Promise.allSettled(closes);
    if (
      retiredHealthPoolCloseFailed
      || results.some((result) => result.status === 'rejected')
    ) {
      // Keep driver errors out of process logs: they may contain connection
      // details. The shutdown coordinator only needs a stable task failure.
      throw new Error('Failed to close database resources');
    }
  });
};
