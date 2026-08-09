import { Pool, type PoolClient, type PoolConfig, type QueryConfig } from 'pg';

let pool: Pool | null = null;
let healthPool: Pool | null = null;
let healthPoolPhaseTimeoutMs: number | null = null;

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
    if (previousPool) void previousPool.end().catch(() => undefined);
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
