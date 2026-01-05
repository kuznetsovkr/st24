import { Pool, type PoolClient } from 'pg';

let pool: Pool | null = null;

const getPool = () => {
  if (pool) {
    return pool;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required');
  }

  pool = new Pool({
    connectionString: databaseUrl
  });

  return pool;
};

export const query = (
  text: string,
  params?: Array<string | number | boolean | string[] | null>
) =>
  getPool().query(text, params);

export const withClient = async <T>(handler: (client: PoolClient) => Promise<T>) => {
  const client = await getPool().connect();
  try {
    return await handler(client);
  } finally {
    client.release();
  }
};
