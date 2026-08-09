import { Resolver } from 'node:dns/promises';
import { connect as tlsConnect, type DetailedPeerCertificate } from 'node:tls';
import { performance } from 'node:perf_hooks';
import type { CheckResult, HttpClient, MonitorConfig } from './types';
import { safeErrorDetail } from './http';

const nowIso = (): string => new Date().toISOString();
const elapsedMs = (startedAt: number): number => Math.round(performance.now() - startedAt);

const result = (
  values: Omit<CheckResult, 'checkedAt'> & { checkedAt?: string }
): CheckResult => ({
  ...values,
  checkedAt: values.checkedAt ?? nowIso()
});

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout?: () => void
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      onTimeout?.();
      const error = new Error('Timed out') as Error & { code: string };
      error.code = 'ETIMEDOUT';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

export interface DnsResolver {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  cancel(): void;
}

export const checkDns = async (
  hostname: string,
  timeoutMs: number,
  resolver: DnsResolver = new Resolver()
): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    const firstAvailableAddress = new Promise<string[]>((resolvePromise, reject) => {
      let completed = 0;
      let firstError: unknown;
      const settleWithoutAddress = (error?: unknown) => {
        completed += 1;
        firstError ??= error;
        if (completed === 2) {
          if (firstError) reject(firstError);
          else resolvePromise([]);
        }
      };
      for (const resolution of [resolver.resolve4(hostname), resolver.resolve6(hostname)]) {
        void resolution.then((addresses) => {
          if (addresses.length > 0) resolvePromise(addresses);
          else settleWithoutAddress();
        }, settleWithoutAddress);
      }
    });
    let addresses: string[];
    try {
      addresses = await withTimeout(firstAvailableAddress, timeoutMs, () => resolver.cancel());
    } finally {
      resolver.cancel();
    }
    const latencyMs = elapsedMs(startedAt);
    if (addresses.length === 0) {
      return result({
        id: 'dns',
        label: 'DNS',
        status: 'failed',
        critical: true,
        detail: 'hostname resolved to no addresses',
        latencyMs
      });
    }
    return result({
      id: 'dns',
      label: 'DNS',
      status: 'ok',
      critical: true,
      detail: `${addresses.length} address(es) resolved`,
      latencyMs
    });
  } catch (error) {
    return result({
      id: 'dns',
      label: 'DNS',
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt)
    });
  }
};

export interface TlsSnapshot {
  validTo: string;
  protocol: string;
}

export const fetchTlsSnapshot = (
  hostname: string,
  port: number,
  timeoutMs: number
): Promise<TlsSnapshot> =>
  new Promise((resolvePromise, reject) => {
    const socket = tlsConnect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: true
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', () => {
      const error = new Error('Timed out') as Error & { code: string };
      error.code = 'ETIMEDOUT';
      socket.destroy(error);
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate() as DetailedPeerCertificate;
      const snapshot = {
        validTo: certificate.valid_to,
        protocol: socket.getProtocol() ?? 'unknown TLS'
      };
      socket.end();
      resolvePromise(snapshot);
    });
  });

export const classifyTlsExpiry = (
  validTo: string,
  warnDays: number,
  criticalDays: number,
  now = Date.now()
): Pick<CheckResult, 'status' | 'detail'> => {
  const expiresAt = Date.parse(validTo);
  if (!Number.isFinite(expiresAt)) {
    return { status: 'failed', detail: 'certificate has an invalid expiry date' };
  }
  const daysRemaining = (expiresAt - now) / 86_400_000;
  const roundedDays = Math.floor(daysRemaining);
  if (daysRemaining <= criticalDays) {
    return {
      status: 'failed',
      detail: daysRemaining <= 0 ? 'certificate has expired' : `certificate expires in ${roundedDays} day(s)`
    };
  }
  if (daysRemaining <= warnDays) {
    return { status: 'warning', detail: `certificate expires in ${roundedDays} day(s)` };
  }
  return { status: 'ok', detail: `certificate expires in ${roundedDays} day(s)` };
};

export const checkTls = async (
  hostname: string,
  port: number,
  timeoutMs: number,
  warnDays: number,
  criticalDays: number,
  snapshotLoader = fetchTlsSnapshot
): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    const snapshot = await snapshotLoader(hostname, port, timeoutMs);
    const expiry = classifyTlsExpiry(snapshot.validTo, warnDays, criticalDays);
    return result({
      id: 'tls',
      label: 'TLS certificate',
      status: expiry.status,
      critical: true,
      detail: `${expiry.detail}; ${snapshot.protocol}`,
      latencyMs: elapsedMs(startedAt)
    });
  } catch (error) {
    return result({
      id: 'tls',
      label: 'TLS certificate',
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt)
    });
  }
};

export interface HttpCheckOptions {
  id: string;
  label: string;
  url: URL;
  client: HttpClient;
  maxResponseMs: number;
  marker?: string;
  requireJson?: boolean;
  validateJson?: (payload: unknown) => string | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

export const validateHealthPayload = (
  payload: unknown,
  requireDependencyChecks = false,
  maxAgeMs = 60_000,
  now = Date.now()
): string | undefined => {
  if (!isRecord(payload) || payload.status !== 'ok') {
    return 'health response status is not ok';
  }
  const checkedAt = typeof payload.checkedAt === 'string' ? Date.parse(payload.checkedAt) : Number.NaN;
  if (!Number.isFinite(checkedAt)) {
    return 'health response has an invalid checkedAt';
  }
  if (now - checkedAt > maxAgeMs || checkedAt - now > maxAgeMs) {
    return 'health response checkedAt is outside the allowed window';
  }
  if (!isRecord(payload.checks)) {
    return requireDependencyChecks
      ? 'readiness response has no dependency checks'
      : 'liveness response has no process check';
  }
  if (!requireDependencyChecks) {
    const processCheck = payload.checks.process;
    if (
      !isRecord(processCheck) ||
      processCheck.status !== 'ok' ||
      !isNonNegativeFiniteNumber(processCheck.latencyMs)
    ) {
      return 'process liveness check is not ok';
    }
    return undefined;
  }
  if (!isNonNegativeFiniteNumber(payload.durationMs)) {
    return 'readiness response has an invalid duration';
  }
  const postgres = payload.checks.postgres;
  const uploads = payload.checks.uploads;
  if (
    !isRecord(postgres) ||
    postgres.status !== 'ok' ||
    !isNonNegativeFiniteNumber(postgres.latencyMs)
  ) {
    return 'PostgreSQL readiness check is not ok';
  }
  if (
    !isRecord(uploads) ||
    uploads.status !== 'ok' ||
    !isNonNegativeFiniteNumber(uploads.latencyMs)
  ) {
    return 'uploads readiness check is not ok';
  }
  return undefined;
};

export const validateCatalogPayload = (
  payload: unknown,
  minimumItems: number
): string | undefined => {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return 'catalog response has no items array';
  }
  if (payload.items.length < minimumItems) {
    return `catalog contains fewer than ${minimumItems} item(s)`;
  }
  if (
    payload.items.some(
      (item) =>
        !isRecord(item) ||
        typeof item.slug !== 'string' ||
        item.slug.trim().length === 0 ||
        typeof item.name !== 'string' ||
        item.name.trim().length === 0
    )
  ) {
    return 'catalog contains an invalid item';
  }
  return undefined;
};

export const checkHttpEndpoint = async ({
  id,
  label,
  url,
  client,
  maxResponseMs,
  marker,
  requireJson = false,
  validateJson
}: HttpCheckOptions): Promise<CheckResult> => {
  const startedAt = performance.now();
  try {
    const response = await client.request(url, {
      headers: {
        accept: 'application/json, text/html;q=0.9',
        'cache-control': 'no-cache',
        pragma: 'no-cache'
      }
    });
    const latencyMs = elapsedMs(startedAt);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      return result({
        id,
        label,
        status: 'failed',
        critical: true,
        detail: `HTTP ${response.statusCode}`,
        latencyMs
      });
    }
    if (marker && !response.body.includes(marker)) {
      return result({
        id,
        label,
        status: 'failed',
        critical: true,
        detail: 'expected response marker is missing',
        latencyMs
      });
    }
    if (requireJson || validateJson) {
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        return result({
          id,
          label,
          status: 'failed',
          critical: true,
          detail: 'response is not valid JSON',
          latencyMs
        });
      }
      const validationError = validateJson?.(payload);
      if (validationError) {
        return result({
          id,
          label,
          status: 'failed',
          critical: true,
          detail: validationError,
          latencyMs
        });
      }
    }
    const status = latencyMs > maxResponseMs ? 'warning' : 'ok';
    return result({
      id,
      label,
      status,
      critical: true,
      detail:
        status === 'warning'
          ? `HTTP ${response.statusCode}; response is slower than ${maxResponseMs} ms`
          : `HTTP ${response.statusCode}`,
      latencyMs
    });
  } catch (error) {
    return result({
      id,
      label,
      status: 'failed',
      critical: true,
      detail: safeErrorDetail(error),
      latencyMs: elapsedMs(startedAt)
    });
  }
};

export const createSiteChecks = (config: MonitorConfig, client: HttpClient): Array<Promise<CheckResult>> => [
  checkDns(config.dnsHost, config.timeoutMs),
  checkTls(
    config.tlsHost,
    config.tlsPort,
    config.timeoutMs,
    config.tlsWarnDays,
    config.tlsCriticalDays
  ),
  checkHttpEndpoint({
    id: 'homepage',
    label: 'Homepage',
    url: config.siteUrl,
    client,
    maxResponseMs: config.maxResponseMs,
    marker: config.homepageMarker
  }),
  checkHttpEndpoint({
    id: 'health-live',
    label: 'API liveness',
    url: config.liveUrl,
    client,
    maxResponseMs: config.maxResponseMs,
    requireJson: true,
    validateJson: (payload) => validateHealthPayload(payload, false, config.healthMaxAgeMs)
  }),
  checkHttpEndpoint({
    id: 'health-ready',
    label: 'API readiness',
    url: config.readyUrl,
    client,
    maxResponseMs: config.maxResponseMs,
    requireJson: true,
    validateJson: (payload) => validateHealthPayload(payload, true, config.healthMaxAgeMs)
  }),
  checkHttpEndpoint({
    id: 'catalog',
    label: 'DB-backed catalog',
    url: config.catalogUrl,
    client,
    maxResponseMs: config.maxResponseMs,
    marker: config.catalogMarker,
    requireJson: true,
    validateJson: (payload) => validateCatalogPayload(payload, config.catalogMinItems)
  })
];
