type CircuitState = {
  consecutiveFailures: number;
  openedUntilMs: number;
};

export class HttpTimeoutError extends Error {
  timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`HTTP request timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class HttpCircuitOpenError extends Error {
  circuitKey: string;
  retryAfterMs: number;

  constructor(circuitKey: string, retryAfterMs: number) {
    super(`Circuit "${circuitKey}" is open for ${retryAfterMs}ms`);
    this.name = 'HttpCircuitOpenError';
    this.circuitKey = circuitKey;
    this.retryAfterMs = retryAfterMs;
  }
}

export type ResilientFetchOptions = {
  circuitKey: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryOnStatuses?: number[];
  circuitFailureStatuses?: number[];
  retryOnTimeout?: boolean;
  retryOnNetworkError?: boolean;
  circuitFailureThreshold?: number;
  circuitOpenMs?: number;
};

const parsePositiveIntEnv = (value: string | undefined, fallback: number) => {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const normalizePositiveInt = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : fallback;
};

const normalizeNonNegativeInt = (value: number | undefined, fallback: number) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : fallback;
};

const DEFAULT_TIMEOUT_MS = parsePositiveIntEnv(process.env.OUTBOUND_HTTP_TIMEOUT_MS, 10_000);
const DEFAULT_MAX_RETRIES = parsePositiveIntEnv(process.env.OUTBOUND_HTTP_MAX_RETRIES, 2);
const DEFAULT_RETRY_BASE_DELAY_MS = parsePositiveIntEnv(
  process.env.OUTBOUND_HTTP_RETRY_BASE_DELAY_MS,
  250
);
const DEFAULT_RETRY_MAX_DELAY_MS = parsePositiveIntEnv(
  process.env.OUTBOUND_HTTP_RETRY_MAX_DELAY_MS,
  2_000
);
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = parsePositiveIntEnv(
  process.env.OUTBOUND_HTTP_CIRCUIT_FAILURE_THRESHOLD,
  5
);
const DEFAULT_CIRCUIT_OPEN_MS = parsePositiveIntEnv(
  process.env.OUTBOUND_HTTP_CIRCUIT_OPEN_MS,
  30_000
);

const DEFAULT_RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_CIRCUIT_FAILURE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

const circuits = new Map<string, CircuitState>();

const getCircuitState = (key: string) => {
  const existing = circuits.get(key);
  if (existing) {
    return existing;
  }
  const created: CircuitState = {
    consecutiveFailures: 0,
    openedUntilMs: 0
  };
  circuits.set(key, created);
  return created;
};

const ensureCircuitClosed = (key: string) => {
  const state = getCircuitState(key);
  const now = Date.now();
  if (state.openedUntilMs > now) {
    throw new HttpCircuitOpenError(key, state.openedUntilMs - now);
  }
  if (state.openedUntilMs > 0 && state.openedUntilMs <= now) {
    state.openedUntilMs = 0;
    state.consecutiveFailures = 0;
  }
};

const markCircuitSuccess = (key: string) => {
  const state = getCircuitState(key);
  state.consecutiveFailures = 0;
  state.openedUntilMs = 0;
};

const markCircuitFailure = (
  key: string,
  threshold: number,
  openMs: number
) => {
  const state = getCircuitState(key);
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= threshold) {
    state.consecutiveFailures = 0;
    state.openedUntilMs = Date.now() + openMs;
  }
};

const isAbortError = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';

const createAbortedSignal = (reason: unknown) => {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
};

const mergeSignals = (
  signalA?: AbortSignal | null,
  signalB?: AbortSignal | null
) => {
  if (!signalA) {
    return signalB ?? undefined;
  }
  if (!signalB) {
    return signalA;
  }
  if (signalA.aborted) {
    return createAbortedSignal(signalA.reason);
  }
  if (signalB.aborted) {
    return createAbortedSignal(signalB.reason);
  }

  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal) => {
    if (controller.signal.aborted) {
      return;
    }
    controller.abort(signal.reason);
  };

  signalA.addEventListener('abort', () => abortFrom(signalA), { once: true });
  signalB.addEventListener('abort', () => abortFrom(signalB), { once: true });
  return controller.signal;
};

const fetchWithTimeout = async (
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number
) => {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return fetch(input, init);
  }

  const timeoutController = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    timeoutController.abort(new HttpTimeoutError(timeoutMs));
  }, timeoutMs);

  try {
    const signal = mergeSignals(init.signal ?? null, timeoutController.signal);
    return await fetch(input, {
      ...init,
      signal
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new HttpTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseRetryAfterMs = (headerValue: string | null) => {
  if (!headerValue) {
    return null;
  }
  const asSeconds = Number.parseInt(headerValue.trim(), 10);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }
  const asDate = Date.parse(headerValue);
  if (!Number.isFinite(asDate)) {
    return null;
  }
  return Math.max(0, asDate - Date.now());
};

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const computeDelayMs = (
  attemptIndex: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | null
) => {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attemptIndex);
  const jitter = Math.floor(Math.random() * Math.max(1, Math.round(exponential * 0.2)));
  const candidate = exponential + jitter;
  return retryAfterMs === null ? candidate : Math.max(candidate, retryAfterMs);
};

const toStatusSet = (statuses: number[] | undefined, fallback: Set<number>) => {
  if (!Array.isArray(statuses) || statuses.length === 0) {
    return fallback;
  }
  return new Set(
    statuses
      .map((status) => Math.trunc(status))
      .filter((status) => Number.isFinite(status) && status >= 100 && status <= 599)
  );
};

export const resilientFetch = async (
  input: string | URL | Request,
  init: RequestInit,
  options: ResilientFetchOptions
): Promise<Response> => {
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxRetries = normalizeNonNegativeInt(options.maxRetries, DEFAULT_MAX_RETRIES);
  const baseDelayMs = normalizePositiveInt(options.retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const maxDelayMs = normalizePositiveInt(options.retryMaxDelayMs, DEFAULT_RETRY_MAX_DELAY_MS);
  const circuitFailureThreshold = normalizePositiveInt(
    options.circuitFailureThreshold,
    DEFAULT_CIRCUIT_FAILURE_THRESHOLD
  );
  const circuitOpenMs = normalizePositiveInt(options.circuitOpenMs, DEFAULT_CIRCUIT_OPEN_MS);
  const retryStatuses = toStatusSet(options.retryOnStatuses, DEFAULT_RETRY_STATUSES);
  const circuitFailureStatuses = toStatusSet(
    options.circuitFailureStatuses,
    DEFAULT_CIRCUIT_FAILURE_STATUSES
  );
  const retryOnTimeout = options.retryOnTimeout ?? true;
  const retryOnNetworkError = options.retryOnNetworkError ?? true;

  ensureCircuitClosed(options.circuitKey);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(input, init, timeoutMs);
      const shouldRetryStatus = retryStatuses.has(response.status);
      const hasMoreRetries = attempt < maxRetries;

      if (shouldRetryStatus && hasMoreRetries) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs, retryAfterMs);
        await wait(delayMs);
        continue;
      }

      if (circuitFailureStatuses.has(response.status)) {
        markCircuitFailure(options.circuitKey, circuitFailureThreshold, circuitOpenMs);
      } else {
        markCircuitSuccess(options.circuitKey);
      }
      return response;
    } catch (error) {
      if (error instanceof HttpCircuitOpenError) {
        throw error;
      }

      const callerAborted = isAbortError(error) && Boolean(init.signal?.aborted);
      const timeoutError = error instanceof HttpTimeoutError;
      const networkError = error instanceof Error && !timeoutError && !callerAborted;
      const hasMoreRetries = attempt < maxRetries;
      const shouldRetry =
        hasMoreRetries &&
        ((timeoutError && retryOnTimeout) || (networkError && retryOnNetworkError));

      if (shouldRetry) {
        const delayMs = computeDelayMs(attempt, baseDelayMs, maxDelayMs, null);
        await wait(delayMs);
        continue;
      }

      if (!callerAborted) {
        markCircuitFailure(options.circuitKey, circuitFailureThreshold, circuitOpenMs);
      }
      throw error;
    }
  }

  throw new Error('Unexpected resilientFetch state');
};

export const resetHttpCircuits = () => {
  circuits.clear();
};
