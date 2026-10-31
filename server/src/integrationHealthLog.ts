import type { IntegrationHealthReport } from './integrationHealth';

const IDS = ['cdek', 'dellin', 'redis', 'russian_post', 'sms_ru', 'telegram_gateway',
  'turnstile', 'yandex_maps', 'yookassa', 'postgres', 'uploads', 'telegram'] as const;
const STATUSES = new Set(['ok', 'error', 'warning', 'disabled', 'unverified']);
const CODES = new Set([
  'invalid_endpoint', 'unsafe_endpoint', 'invalid_response', 'response_too_large', 'invalid_configuration',
  'shipping_state_unavailable', 'timeout', 'check_failed', 'not_configured', 'incomplete_credentials',
  'account_disabled', 'payment_methods_missing', 'provider_rejected', 'balance_empty', 'balance_low',
  'balance_sufficient', 'test_environment', 'authenticated', 'authentication_failed', 'rate_limited',
  'not_used_by_phone_mode', 'gateway_delivery_not_probed', 'disabled_by_configuration',
  'optional_memory_fallback', 'pong', 'disabled_in_store', 'reference_metadata_authenticated',
  'api_reachable_browser_verification_required', 'browser_verification_required', 'recovery_pending',
  'query_succeeded', 'database_check_failed', 'write_read_delete_succeeded', 'uploads_check_failed',
  'runtime_and_delivery_queue_healthy', 'notification_pipeline_failed'
]);
const safeCode = (value: string) => CODES.has(value) || /^http_[1-5]\d{2}$/.test(value) ? value : 'unknown';
const stamp = (value: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ? value : undefined;
const milliseconds = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(60_000, Math.round(value))) : 0;

// Strict allowlists, not arbitrary report serialization: no env, URLs, user data,
// provider response bodies or exception messages can enter this log channel.
export const createIntegrationHealthLogger = (options: {
  now?: () => number;
  write?: (line: string) => void;
  repeatMs?: number;
} = {}) => {
  const now = options.now ?? Date.now;
  const write = options.write ?? ((line) => console.log('[integration-health]', line));
  let previous = '';
  let lastWritten = -Infinity;
  return (report: IntegrationHealthReport): void => {
    const checks = Object.fromEntries(IDS.filter((id) => report.checks[id]).map((id) => {
      const check = report.checks[id];
      return [id, {
        status: STATUSES.has(check.status) ? check.status : 'error', code: safeCode(check.code),
        ...(check.stability ? { recovering: true } : {})
      }];
    }));
    const availability = ['ok', 'warning', 'error'].includes(report.availability) ? report.availability : 'error';
    const signature = JSON.stringify({ availability, checks });
    if (signature === previous && (availability === 'ok' || now() - lastWritten < (options.repeatMs ?? 900_000))) return;
    const measurements = Object.fromEntries(IDS.filter((id) => report.checks[id]).map((id) => {
      const check = report.checks[id];
      return [id, { ...checks[id], checkedAt: stamp(check.checkedAt), latencyMs: milliseconds(check.latencyMs),
        ...(check.stability ? { observedCode: safeCode(check.stability.observedCode),
          lastFailureCode: safeCode(check.stability.lastFailureCode), lastFailureAt: stamp(check.stability.lastFailureAt) } : {}) }];
    }));
    try {
      write(JSON.stringify({ event: 'integration_health', checkedAt: stamp(report.checkedAt), availability,
        durationMs: milliseconds(report.durationMs), checks: measurements }));
      previous = signature;
      lastWritten = now();
    } catch { /* Logging must never change health or throw a secret-bearing error. */ }
  };
};
