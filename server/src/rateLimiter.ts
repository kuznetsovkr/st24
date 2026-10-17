import { createClient, type RedisClientType } from 'redis';
import { createShutdownFence } from './shutdownFence';

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export type ScopedRateLimiter = {
  consume: (scope: string, ip: string | undefined, subject: string) => Promise<RateLimitResult>;
  reset: (scope: string, ip: string | undefined, subject: string) => Promise<void>;
};

type RateLimitState = {
  count: number;
  resetAt: number;
};

const parsePositiveIntEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
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

const getRedisUrl = () => {
  const primary = process.env.RATE_LIMIT_REDIS_URL?.trim();
  if (primary) {
    return primary;
  }
  const fallback = process.env.REDIS_URL?.trim();
  return fallback || null;
};

const REDIS_ENABLED = parseBoolEnv(process.env.RATE_LIMIT_REDIS_ENABLED, true);
const REDIS_REQUIRED = parseBoolEnv(process.env.RATE_LIMIT_REDIS_REQUIRED, false);
const REDIS_PREFIX = (process.env.RATE_LIMIT_REDIS_PREFIX ?? 'ratelimit').trim() || 'ratelimit';
const REDIS_CONNECT_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.RATE_LIMIT_REDIS_CONNECT_TIMEOUT_MS,
  2000
);
const REDIS_RECONNECT_COOLDOWN_MS = parsePositiveIntEnv(
  process.env.RATE_LIMIT_REDIS_RECONNECT_COOLDOWN_MS,
  10000
);

const REDIS_CONSUME_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('TTL', KEYS[1])
return {current, ttl}
`;

let redisClient: RedisClientType | null = null;
let redisConnectPromise: Promise<RedisClientType | null> | null = null;
let redisDisabledUntilMs = 0;
let lastRedisErrorLogMs = 0;
const redisShutdownFence = createShutdownFence();
const redisBackgroundDisconnects = new Set<Promise<void>>();

const logRedisError = (message: string) => {
  if (redisShutdownFence.isClosing()) {
    return;
  }
  const now = Date.now();
  if (now - lastRedisErrorLogMs < 30_000) {
    return;
  }
  lastRedisErrorLogMs = now;
  console.warn(`[rate-limit] ${message}`);
};

const parseEvalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
};

const parseConsumeResult = (value: unknown) => {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  const count = parseEvalNumber(value[0]);
  const ttl = parseEvalNumber(value[1]);
  if (count === null || ttl === null) {
    return null;
  }
  return { count, ttl };
};

const markRedisUnavailable = async (reason: string) => {
  if (!redisShutdownFence.isClosing()) {
    redisDisabledUntilMs = Date.now() + REDIS_RECONNECT_COOLDOWN_MS;
    // Do not print the Redis error object: connection errors may include a URL
    // containing credentials. The stable reason is enough operationally.
    logRedisError(reason);
  }
  if (!redisClient) {
    return;
  }
  const existing = redisClient;
  redisClient = null;
  const disconnectPromise = (async () => {
    try {
      if (existing.isOpen) {
        await existing.disconnect();
      }
    } catch {
      // no-op
    }
  })();
  redisBackgroundDisconnects.add(disconnectPromise);
  try {
    await disconnectPromise;
  } finally {
    redisBackgroundDisconnects.delete(disconnectPromise);
  }
};

const getRedisClient = async (): Promise<RedisClientType | null> => {
  if (!REDIS_ENABLED || redisShutdownFence.isClosing()) {
    return null;
  }

  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    if (REDIS_REQUIRED) {
      throw new Error(
        'RATE_LIMIT_REDIS_REQUIRED=true but Redis URL is not configured (RATE_LIMIT_REDIS_URL or REDIS_URL)'
      );
    }
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (redisDisabledUntilMs > Date.now()) {
    return null;
  }

  if (redisConnectPromise) {
    return redisConnectPromise;
  }

  redisConnectPromise = (async () => {
    try {
      if (!redisClient) {
        redisClient = createClient({
          url: redisUrl,
          disableOfflineQueue: true,
          socket: {
            connectTimeout: REDIS_CONNECT_TIMEOUT_MS
          }
        });
        redisClient.on('error', () => {
          logRedisError('Redis client error');
        });
      }
      if (!redisClient.isOpen) {
        await redisClient.connect();
      }
      // A close may have started while connect() was pending. Do not hand the
      // newly connected client to another operation; the closer awaits this
      // promise and takes ownership of it below.
      return redisShutdownFence.isClosing() ? null : redisClient;
    } catch (error) {
      await markRedisUnavailable('Redis is unavailable, falling back to in-memory limiter');
      if (REDIS_REQUIRED) {
        throw error instanceof Error ? error : new Error('Failed to connect to Redis');
      }
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
};

export const closeRateLimiterRedis = (): Promise<void> => {
  return redisShutdownFence.closeOnce(async () => {
    const pendingConnect = redisConnectPromise;
    if (pendingConnect) {
      await pendingConnect.catch(() => null);
    }

    const backgroundDisconnects = [...redisBackgroundDisconnects];
    if (backgroundDisconnects.length > 0) {
      await Promise.allSettled(backgroundDisconnects);
    }

    const client = redisClient;
    redisClient = null;
    redisConnectPromise = null;
    if (!client) {
      return;
    }

    try {
      if (client.isReady) {
        await client.quit();
      } else if (client.isOpen) {
        await client.disconnect();
      }
      return;
    } catch {
      // quit() can fail while the connection is being torn down. A forced
      // disconnect is an acceptable shutdown fallback.
    }

    try {
      if (client.isOpen) {
        await client.disconnect();
      }
    } catch {
      throw new Error('Failed to close rate limiter Redis client');
    }
  });
};

const createMemoryScopedRateLimiter = (windowSeconds: number, max: number): ScopedRateLimiter => {
  const store = new Map<string, RateLimitState>();
  let lastCleanup = 0;
  const windowMs = windowSeconds * 1000;
  const keyOf = (scope: string, ip: string | undefined, subject: string) =>
    `${scope}:${ip ?? 'unknown'}:${subject}`;

  const consume = async (
    scope: string,
    ip: string | undefined,
    subject: string
  ): Promise<RateLimitResult> => {
    const now = Date.now();
    const key = keyOf(scope, ip, subject);

    if (now - lastCleanup > windowMs) {
      for (const [storeKey, state] of store.entries()) {
        if (state.resetAt <= now) {
          store.delete(storeKey);
        }
      }
      lastCleanup = now;
    }

    const existing = store.get(key);
    if (!existing || existing.resetAt <= now) {
      store.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      return {
        allowed: true,
        retryAfterSeconds: 0
      };
    }

    if (existing.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return {
        allowed: false,
        retryAfterSeconds
      };
    }

    existing.count += 1;
    store.set(key, existing);
    return {
      allowed: true,
      retryAfterSeconds: 0
    };
  };

  const reset = async (scope: string, ip: string | undefined, subject: string) => {
    store.delete(keyOf(scope, ip, subject));
  };

  return { consume, reset };
};

export const createScopedRateLimiter = (windowSeconds: number, max: number): ScopedRateLimiter => {
  const memoryLimiter = createMemoryScopedRateLimiter(windowSeconds, max);
  const keyOf = (scope: string, ip: string | undefined, subject: string) =>
    `${REDIS_PREFIX}:${windowSeconds}:${max}:${scope}:${ip ?? 'unknown'}:${subject}`;

  const consume = async (
    scope: string,
    ip: string | undefined,
    subject: string
  ): Promise<RateLimitResult> => {
    try {
      const client = await getRedisClient();
      if (!client) {
        return memoryLimiter.consume(scope, ip, subject);
      }

      const key = keyOf(scope, ip, subject);
      const raw = await client.eval(REDIS_CONSUME_SCRIPT, {
        keys: [key],
        arguments: [String(windowSeconds)]
      });
      const parsed = parseConsumeResult(raw);
      if (!parsed) {
        throw new Error('Unexpected Redis eval result for rate limiter');
      }

      if (parsed.count > max) {
        const retryAfterSeconds = parsed.ttl > 0 ? parsed.ttl : windowSeconds;
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, retryAfterSeconds)
        };
      }

      return {
        allowed: true,
        retryAfterSeconds: 0
      };
    } catch (error) {
      if (REDIS_REQUIRED) {
        throw error;
      }
      await markRedisUnavailable('Rate limiter Redis consume failed, using in-memory fallback');
      return memoryLimiter.consume(scope, ip, subject);
    }
  };

  const reset = async (scope: string, ip: string | undefined, subject: string) => {
    try {
      const client = await getRedisClient();
      if (!client) {
        await memoryLimiter.reset(scope, ip, subject);
        return;
      }
      await client.del(keyOf(scope, ip, subject));
    } catch (error) {
      if (REDIS_REQUIRED) {
        throw error;
      }
      await markRedisUnavailable('Rate limiter Redis reset failed, using in-memory fallback');
      await memoryLimiter.reset(scope, ip, subject);
    }
  };

  return {
    consume,
    reset
  };
};
