import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createClient } from 'redis';

export type IntegrationStatus = 'ok' | 'error' | 'warning' | 'disabled' | 'unverified';
export type ShippingProvider = 'cdek' | 'dellin' | 'russian_post';
export type IntegrationCheck = {
  status: IntegrationStatus;
  code: string;
  coverage: 'authenticated_read' | 'balance' | 'ping' | 'connectivity' | 'browser' | 'runtime';
  checkedAt: string;
  latencyMs: number;
};
export type IntegrationHealthReport = {
  status: 'ok' | 'partial' | 'warning' | 'error';
  availability: 'ok' | 'warning' | 'error';
  checkedAt: string;
  durationMs: number;
  checks: Record<string, IntegrationCheck>;
  coverage: { complete: boolean; unverified: string[]; disabled: string[] };
};
export type IntegrationEnvironment = Record<string, string | undefined>;
export type ShippingModes = Record<ShippingProvider, boolean>;
export type IntegrationDependencies = {
  environment: () => IntegrationEnvironment;
  shippingModes: (signal: AbortSignal) => Promise<ShippingModes>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  redisPing: (url: string, signal: AbortSignal) => Promise<string>;
  now: () => number;
  monotonicNow: () => number;
  timeoutMs: number;
  cacheTtlMs: number;
};

const MAX_BODY_BYTES = 128 * 1024;
const trim = (value: string | undefined) => value?.trim() ?? '';
const first = (...values: Array<string | undefined>) => values.map(trim).find(Boolean) ?? '';
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return trim(raw) && Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
};

class ProbeError extends Error {
  constructor(readonly code: string) { super(code); }
}

const officialBase = (raw: string | undefined, allowed: string[]): string => {
  let url: URL;
  try { url = new URL(trim(raw) || allowed[0]); } catch { throw new ProbeError('invalid_endpoint'); }
  const normalized = url.origin + url.pathname.replace(/\/$/, '');
  if (url.username || url.password || url.search || url.hash || !allowed.includes(normalized)) {
    throw new ProbeError('unsafe_endpoint');
  }
  return normalized;
};

const readJson = async (response: Response): Promise<unknown> => {
  if (!response.body) throw new ProbeError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new ProbeError('response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ProbeError('invalid_response'); }
};

export const pingIntegrationRedis = async (url: string, signal: AbortSignal): Promise<string> => {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new ProbeError('invalid_configuration'); }
  if (!['redis:', 'rediss:'].includes(parsed.protocol) || parsed.hash) {
    throw new ProbeError('invalid_configuration');
  }
  const client = createClient({ url, socket: { connectTimeout: 3_000, reconnectStrategy: false } });
  client.on('error', () => undefined); // Never log a connection string or raw Redis error.
  const close = () => { if (client.isOpen) void client.disconnect().catch(() => undefined); };
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    await client.connect();
    signal.throwIfAborted();
    return await client.ping();
  } finally {
    signal.removeEventListener('abort', close);
    if (client.isOpen) await client.disconnect().catch(() => undefined);
  }
};

export const summarizeIntegrations = (
  checks: Record<string, IntegrationCheck>, checkedAt: string, durationMs: number
): IntegrationHealthReport => {
  const entries = Object.entries(checks);
  const unverified = entries.filter(([, check]) => check.status === 'unverified').map(([id]) => id);
  const disabled = entries.filter(([, check]) => check.status === 'disabled').map(([id]) => id);
  const availability = entries.some(([, check]) => check.status === 'error') ? 'error'
    : entries.some(([, check]) => check.status === 'warning') ? 'warning' : 'ok';
  return { status: availability === 'ok' && unverified.length ? 'partial' : availability,
    availability, checkedAt, durationMs, checks,
    coverage: { complete: unverified.length === 0, unverified, disabled } };
};

// Own transport, no business circuit breaker, writes, payment/OTP endpoints,
// redirects, raw diagnostics, provider bodies or exact balances in reports.
export const createIntegrationHealthChecker = (overrides: Partial<IntegrationDependencies> = {}) => {
  const settings = (overrides.environment ?? (() => process.env))();
  const dependencies: IntegrationDependencies = {
    environment: () => process.env,
    shippingModes: async () => { throw new ProbeError('shipping_state_unavailable'); },
    fetch: (url, init) => fetch(url, init),
    redisPing: pingIntegrationRedis,
    now: Date.now, monotonicNow: () => performance.now(),
    timeoutMs: integer(settings.INTEGRATION_HEALTH_TIMEOUT_MS, 6_000, 250, 8_000),
    cacheTtlMs: integer(settings.INTEGRATION_HEALTH_CACHE_TTL_MS, 240_000, 60_000, 300_000), ...overrides
  };
  let cached: { report: IntegrationHealthReport; expires: number; scope: string } | undefined;
  let inFlight: { promise: Promise<IntegrationHealthReport>; scope: string } | undefined;
  let cdekToken: { value: string; expires: number; scope: string } | undefined;

  const request = async (url: string, signal: AbortSignal, init: RequestInit = {}, expectedStatuses: number[] = []) => {
    const response = await dependencies.fetch(url, {
      ...init, redirect: 'error', signal,
      headers: { Accept: 'application/json', ...init.headers }
    });
    if (!response.ok && !expectedStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProbeError(response.status === 401 || response.status === 403 ? 'authentication_failed'
        : response.status === 429 ? 'rate_limited' : `http_${response.status}`);
    }
    return readJson(response);
  };

  const probe = async (
    coverage: IntegrationCheck['coverage'], operation: (signal: AbortSignal) => Promise<string>
  ): Promise<IntegrationCheck> => {
    const controller = new AbortController();
    const start = dependencies.monotonicNow();
    const checkedAt = new Date(dependencies.now()).toISOString();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProbeError('timeout')); }, dependencies.timeoutMs);
    });
    try {
      const code = await Promise.race([operation(controller.signal), deadline]);
      return { status: code === 'balance_low' || code === 'test_environment' ? 'warning' : 'ok',
        code, coverage, checkedAt, latencyMs: Math.max(0, Math.round(dependencies.monotonicNow() - start)) };
    } catch (error) {
      return { status: 'error', code: controller.signal.aborted ? 'timeout'
        : error instanceof ProbeError ? error.code : 'check_failed',
        coverage, checkedAt, latencyMs: Math.max(0, Math.round(dependencies.monotonicNow() - start)) };
    } finally { if (timer) clearTimeout(timer); }
  };

  const collect = async (env: IntegrationEnvironment): Promise<IntegrationHealthReport> => {
    const start = dependencies.monotonicNow();
    const checkedAt = new Date(dependencies.now()).toISOString();
    const checks: Record<string, IntegrationCheck> = {};
    const fixed = (status: IntegrationStatus, code: string, coverage: IntegrationCheck['coverage']): IntegrationCheck =>
      ({ status, code, coverage, checkedAt, latencyMs: 0 });
    const tasks: Array<Promise<void>> = [];
    const run = (id: string, coverage: IntegrationCheck['coverage'], operation: (signal: AbortSignal) => Promise<string>) => {
      tasks.push(probe(coverage, operation).then((check) => { checks[id] = check; }));
    };
    const shop = trim(env.YOOKASSA_SHOP_ID), secret = trim(env.YOOKASSA_SECRET_KEY);
    if (!shop && !secret) checks.yookassa = fixed('disabled', 'not_configured', 'authenticated_read');
    else run('yookassa', 'authenticated_read', async (signal) => {
      if (!shop || !secret) throw new ProbeError('incomplete_credentials');
      const base = officialBase(env.YOOKASSA_API_BASE_URL, ['https://api.yookassa.ru/v3']);
      const body = await request(base + '/me', signal, { headers: {
        Authorization: 'Basic ' + Buffer.from(shop + ':' + secret).toString('base64')
      } });
      if (!record(body) || String(body.account_id) !== shop || typeof body.test !== 'boolean'
          || typeof body.status !== 'string' || !Array.isArray(body.payment_methods)) throw new ProbeError('invalid_response');
      if (body.status !== 'enabled') throw new ProbeError('account_disabled');
      if (body.payment_methods.length === 0) throw new ProbeError('payment_methods_missing');
      return body.test ? 'test_environment' : 'authenticated';
    });
    const sms = trim(env.SMS_RU_API_ID);
    if (!sms) checks.sms_ru = fixed(env.NODE_ENV === 'production' ? 'error' : 'disabled', 'not_configured', 'balance');
    else run('sms_ru', 'balance', async (signal) => {
      const body = await request('https://sms.ru/my/balance', signal, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ api_id: sms, json: '1' }).toString() });
      if (!record(body) || body.status !== 'OK' || body.status_code !== 100) throw new ProbeError('provider_rejected');
      if (typeof body.balance !== 'number' || !Number.isFinite(body.balance)) throw new ProbeError('invalid_response');
      if (body.balance <= 0) throw new ProbeError('balance_empty');
      const minimum = integer(env.INTEGRATION_HEALTH_SMS_MIN_BALANCE_RUB, 100, 0, 1_000_000);
      return body.balance < minimum ? 'balance_low' : 'balance_sufficient';
    });

    // Gateway is genuinely unused in sms_only mode, not "healthy because a token exists".
    const phoneMode = trim(env.PHONE_VERIFICATION_MODE).toLowerCase();
    checks.telegram_gateway = ['sms_only', 'sms', 'sms_ru_only'].includes(phoneMode) || !trim(env.TELEGRAM_GATEWAY_TOKEN)
      ? fixed('disabled', 'not_used_by_phone_mode', 'runtime')
      : fixed('unverified', 'gateway_delivery_not_probed', 'runtime');

    const redisEnabled = !['false', '0'].includes(trim(env.RATE_LIMIT_REDIS_ENABLED).toLowerCase());
    const redisUrl = first(env.RATE_LIMIT_REDIS_URL, env.REDIS_URL);
    const redisRequired = ['true', '1'].includes(trim(env.RATE_LIMIT_REDIS_REQUIRED).toLowerCase());
    if (!redisEnabled && !redisRequired) checks.redis = fixed('disabled', 'disabled_by_configuration', 'ping');
    else if (!redisUrl && !redisRequired) checks.redis = fixed('disabled', 'optional_memory_fallback', 'ping');
    else run('redis', 'ping', async (signal) => {
      if (!redisUrl) throw new ProbeError('not_configured');
      if (await dependencies.redisPing(redisUrl, signal) !== 'PONG') throw new ProbeError('invalid_response');
      return 'pong';
    });

    const shippingController = new AbortController();
    let shippingTimer: NodeJS.Timeout | undefined;
    let modes: ShippingModes | undefined;
    try {
      modes = await Promise.race([dependencies.shippingModes(shippingController.signal), new Promise<never>((_, reject) => {
        shippingTimer = setTimeout(() => { shippingController.abort(); reject(new ProbeError('timeout')); }, Math.min(1_000, dependencies.timeoutMs));
      })]);
      if (!modes || ['cdek', 'dellin', 'russian_post'].some((id) => typeof modes?.[id as ShippingProvider] !== 'boolean')) modes = undefined;
    } catch { /* A missing runtime flag is NOT proof that a configured provider is disabled. */ }
    finally { if (shippingTimer) clearTimeout(shippingTimer); }
    for (const id of ['cdek', 'dellin', 'russian_post'] as const) {
      if (!modes) { checks[id] = fixed('error', 'shipping_state_unavailable', 'authenticated_read'); continue; }
      if (!modes[id]) { checks[id] = fixed('disabled', 'disabled_in_store', 'authenticated_read'); continue; }
      run(id, 'authenticated_read', async (signal) => {
        if (id === 'cdek') {
          const client = first(env.CDEK_CLIENT_ID, env.CDEK_ACCOUNT);
          const password = first(env.CDEK_CLIENT_SECRET, env.CDEK_PASSWORD);
          if (!client || !password) throw new ProbeError('incomplete_credentials');
          const base = officialBase(env.CDEK_API_BASE_URL, ['https://api.cdek.ru/v2', 'https://api.edu.cdek.ru/v2']);
          const scope = createHash('sha256').update(base + '\0' + client + '\0' + password).digest('hex');
          if (!cdekToken || cdekToken.scope !== scope || cdekToken.expires <= dependencies.now() + 30_000) {
            const body = await request(base + '/oauth/token', signal, { method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ grant_type: 'client_credentials', client_id: client, client_secret: password }).toString() });
            if (!record(body) || typeof body.access_token !== 'string' || !body.access_token
                || typeof body.expires_in !== 'number' || !Number.isFinite(body.expires_in) || body.expires_in <= 30) throw new ProbeError('invalid_response');
            cdekToken = { value: body.access_token, scope, expires: dependencies.now() + Math.min(body.expires_in, 86400) * 1000 };
          }
          let body: unknown;
          try {
            body = await request(base + '/location/cities?country_codes=RU&size=1', signal, {
              headers: { Authorization: 'Bearer ' + cdekToken.value }
            });
          } catch (error) {
            if (error instanceof ProbeError && error.code === 'authentication_failed') cdekToken = undefined;
            throw error;
          }
          if (!Array.isArray(body) || !body.length || !record(body[0])
              || !Number.isInteger(body[0].code) || typeof body[0].city !== 'string' || !body[0].city) throw new ProbeError('invalid_response');
          return base.includes('api.edu.') ? 'test_environment' : 'authenticated';
        }
        if (id === 'dellin') {
          const key = trim(env.DELLIN_APP_KEY);
          if (!key) throw new ProbeError('incomplete_credentials');
          const base = officialBase(env.DELLIN_API_BASE_URL, ['https://api.dellin.ru']);
          const body = await request(base + '/v3/public/terminals.json', signal, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appkey: key }) });
          const hasErrors = record(body) && body.errors != null && body.errors !== false
            && !(record(body.errors) && Object.keys(body.errors).length === 0)
            && !(Array.isArray(body.errors) && body.errors.length === 0);
          if (!record(body) || hasErrors || body.error || typeof body.hash !== 'string'
              || !/^[a-f0-9]{32,64}$/i.test(body.hash) || typeof body.url !== 'string') throw new ProbeError('provider_rejected');
          let directory: URL;
          try { directory = new URL(body.url); } catch { throw new ProbeError('invalid_response'); }
          if (!['http:', 'https:'].includes(directory.protocol) || directory.hostname !== 'api.dellin.ru'
              || directory.username || directory.password) throw new ProbeError('invalid_response');
          return 'reference_metadata_authenticated'; // Signed URL is never followed or exposed.
        }
        const token = trim(env.RUSSIAN_POST_ACCESS_TOKEN), key = trim(env.RUSSIAN_POST_USER_KEY);
        if (!token || !key) throw new ProbeError('incomplete_credentials');
        const base = officialBase(env.RUSSIAN_POST_API_BASE_URL, ['https://otpravka-api.pochta.ru']);
        const body = await request(base + '/1.0/user-shipping-points', signal, { headers: {
          Authorization: 'AccessToken ' + token, 'X-User-Authorization': 'Basic ' + key.replace(/^Basic\s+/i, '')
        } });
        if (!Array.isArray(body) || !body.every(record)) throw new ProbeError('invalid_response');
        return 'authenticated';
      });
    }

    if (!trim(env.TURNSTILE_SECRET_KEY)) {
      checks.turnstile = fixed(env.NODE_ENV === 'production' ? 'error' : 'disabled', 'not_configured', 'connectivity');
    } else {
      run('turnstile', 'connectivity', async (signal) => {
        // No user token, no production secret: this proves API reachability, NOT CAPTCHA success/authentication.
        const body = await request('https://challenges.cloudflare.com/turnstile/v0/siteverify', signal, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
        }, [400]);
        if (!record(body) || body.success !== false || !Array.isArray(body['error-codes'])
            || !body['error-codes'].includes('missing-input-secret')) throw new ProbeError('invalid_response');
        return 'api_reachable_browser_verification_required';
      });
    }
    checks.yandex_maps = fixed('unverified', 'browser_verification_required', 'browser');
    await Promise.all(tasks);
    if (checks.turnstile?.status === 'ok') checks.turnstile.status = 'unverified';
    return summarizeIntegrations(Object.fromEntries(Object.entries(checks).sort(([a], [b]) => a.localeCompare(b))),
      checkedAt, Math.max(0, Math.round(dependencies.monotonicNow() - start)));
  };

  const check = async (): Promise<IntegrationHealthReport> => {
    const env = { ...dependencies.environment() };
    // Never store environment values in the public report or cache metadata.
    const scope = createHash('sha256').update(JSON.stringify(env)).digest('hex');
    if (cached && cached.scope === scope && cached.expires > dependencies.monotonicNow()) return cached.report;
    if (inFlight) {
      const running = inFlight;
      const report = await running.promise;
      return running.scope === scope ? report : check();
    }
    const promise = collect(env);
    inFlight = { promise, scope };
    try {
      const report = await promise;
      cached = { report, scope, expires: dependencies.monotonicNow() + dependencies.cacheTtlMs };
      return report;
    } finally { inFlight = undefined; }
  };
  return check;
};
