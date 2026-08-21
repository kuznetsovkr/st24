import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { performance } from 'perf_hooks';
import { queryWithTimeout } from './db';

export const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 3_000;
export const DEFAULT_HEALTH_CHECK_CACHE_TTL_MS = 5_000;

export type HealthCheckResult =
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; latencyMs: number; reason: 'check_failed' | 'timeout' };

export type LivenessReport = {
  status: 'ok';
  checkedAt: string;
  uptimeSeconds: number;
  checks: { process: HealthCheckResult };
};

export type ReadinessReport = {
  status: 'ok' | 'error';
  checkedAt: string;
  durationMs: number;
  checks: { postgres: HealthCheckResult; uploads: HealthCheckResult };
};

export type HealthFileSystem = {
  writeFile: (filePath: string, contents: string, signal?: AbortSignal) => Promise<void>;
  readFile: (filePath: string, signal?: AbortSignal) => Promise<string>;
  removeFile: (filePath: string) => Promise<void>;
};

export type ReadinessDependencies = {
  queryDatabase: (text: string, timeoutMs: number) => Promise<unknown>;
  uploadsDir: string;
  timeoutMs: number;
  now: () => number;
  generateId: () => string;
  fileSystem: HealthFileSystem;
  uploadsProbeKey: object;
};

export type ReadinessOptions = Partial<
  Omit<ReadinessDependencies, 'fileSystem' | 'uploadsProbeKey'>
> & {
  fileSystem?: Partial<HealthFileSystem>;
};

const defaultFileSystem: HealthFileSystem = {
  writeFile: async (filePath, contents, signal) => {
    await fs.writeFile(filePath, contents, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
      signal
    });
  },
  readFile: (filePath, signal) => fs.readFile(filePath, { encoding: 'utf8', signal }),
  removeFile: (filePath) => fs.unlink(filePath)
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

const getDefaultDependencies = (): ReadinessDependencies => ({
  queryDatabase: (text, timeoutMs) => queryWithTimeout(text, timeoutMs),
  uploadsDir: path.resolve(process.cwd(), 'uploads'),
  timeoutMs: parseBoundedPositiveInt(
    process.env.HEALTH_CHECK_TIMEOUT_MS,
    DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
    250,
    30_000
  ),
  now: Date.now,
  generateId: randomUUID,
  fileSystem: defaultFileSystem,
  uploadsProbeKey: defaultFileSystem
});

class HealthCheckTimeoutError extends Error {}

const durationSince = (startedAt: number, now: () => number) =>
  Math.max(0, Math.round(now() - startedAt));

const isNotFoundError = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const withTimeout = async <T>(
  operation: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      reject(new HealthCheckTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const runCheck = async (
  check: () => Promise<void>,
  timeoutMs: number,
  now: () => number,
  onTimeout?: () => void
): Promise<HealthCheckResult> => {
  const startedAt = now();
  try {
    await withTimeout(check(), timeoutMs, onTimeout);
    return { status: 'ok', latencyMs: durationSince(startedAt, now) };
  } catch (error) {
    return {
      status: 'error',
      latencyMs: durationSince(startedAt, now),
      reason: error instanceof HealthCheckTimeoutError ? 'timeout' : 'check_failed'
    };
  }
};

const checkPostgres = async (dependencies: ReadinessDependencies) => {
  await dependencies.queryDatabase('SELECT 1', dependencies.timeoutMs);
};

const runUploadsProbe = async (
  dependencies: ReadinessDependencies,
  signal: AbortSignal
) => {
  const id = dependencies.generateId();
  const marker = `health:${id}`;
  const filePath = path.join(dependencies.uploadsDir, `.health-${id}.tmp`);
  let failure: { error: unknown } | undefined;
  try {
    await dependencies.fileSystem.writeFile(filePath, marker, signal);
    const storedMarker = await dependencies.fileSystem.readFile(filePath, signal);
    if (storedMarker !== marker) throw new Error('Uploads health marker mismatch');
  } catch (error) {
    failure = { error };
  }
  try {
    await dependencies.fileSystem.removeFile(filePath);
  } catch (error) {
    if (!isNotFoundError(error)) failure = { error };
  }
  if (failure) throw failure.error;
};

const uploadsProbes = new WeakMap<object, Promise<void>>();

const checkUploads = (
  dependencies: ReadinessDependencies,
  signal: AbortSignal
): Promise<void> => {
  const currentProbe = uploadsProbes.get(dependencies.uploadsProbeKey);
  if (currentProbe) return currentProbe;

  const probe = runUploadsProbe(dependencies, signal);
  uploadsProbes.set(dependencies.uploadsProbeKey, probe);
  const clearProbe = () => {
    if (uploadsProbes.get(dependencies.uploadsProbeKey) === probe) {
      uploadsProbes.delete(dependencies.uploadsProbeKey);
    }
  };
  void probe.then(clearProbe, clearProbe);
  return probe;
};

export const createLivenessReport = (
  now: () => number = Date.now,
  uptime: () => number = process.uptime
): LivenessReport => ({
  status: 'ok',
  checkedAt: new Date(now()).toISOString(),
  uptimeSeconds: Math.max(0, Math.round(uptime())),
  checks: { process: { status: 'ok', latencyMs: 0 } }
});

export const runReadinessChecks = async (
  overrides: ReadinessOptions = {}
): Promise<ReadinessReport> => {
  const defaults = getDefaultDependencies();
  const dependencies: ReadinessDependencies = {
    ...defaults,
    ...overrides,
    fileSystem: { ...defaultFileSystem, ...overrides.fileSystem },
    uploadsProbeKey: overrides.fileSystem ?? defaults.uploadsProbeKey
  };
  const startedAt = dependencies.now();
  const checkedAt = new Date(startedAt).toISOString();
  const uploadsAbortController = new AbortController();
  const [postgres, uploads] = await Promise.all([
    runCheck(() => checkPostgres(dependencies), dependencies.timeoutMs, dependencies.now),
    runCheck(
      () => checkUploads(dependencies, uploadsAbortController.signal),
      dependencies.timeoutMs,
      dependencies.now,
      () => uploadsAbortController.abort()
    )
  ]);
  return {
    status: postgres.status === 'ok' && uploads.status === 'ok' ? 'ok' : 'error',
    checkedAt,
    durationMs: durationSince(startedAt, dependencies.now),
    checks: { postgres, uploads }
  };
};

export const createCachedReadinessChecker = (
  probe: () => Promise<ReadinessReport> = runReadinessChecks,
  cacheTtl: () => number = () =>
    parseBoundedPositiveInt(
      process.env.HEALTH_CHECK_CACHE_TTL_MS,
      DEFAULT_HEALTH_CHECK_CACHE_TTL_MS,
      250,
      60_000
    ),
  now: () => number = () => performance.now()
) => {
  let cached: { report: ReadinessReport; expiresAt: number } | undefined;
  let inFlight: Promise<ReadinessReport> | undefined;

  return async (): Promise<ReadinessReport> => {
    const currentTime = now();
    if (cached && cached.expiresAt > currentTime) {
      return cached.report;
    }
    if (inFlight) {
      return inFlight;
    }

    inFlight = probe();
    try {
      const report = await inFlight;
      cached = {
        report,
        expiresAt: now() + cacheTtl()
      };
      return report;
    } finally {
      inFlight = undefined;
    }
  };
};

export const getReadinessReport = createCachedReadinessChecker();
