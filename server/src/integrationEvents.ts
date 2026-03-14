import { randomUUID } from 'crypto';
import { query } from './db';

type IntegrationEventInput = {
  provider: string;
  operation: string;
  attempt?: number | null;
  statusCode?: number | null;
  latencyMs?: number | null;
  fallbackUsed?: boolean;
  error?: string | null;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeAttempt = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : null;
};

const normalizeStatusCode = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized >= 100 && normalized <= 999 ? normalized : null;
};

const normalizeLatency = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : null;
};

const normalizeErrorText = (value?: string | null) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 3997)}...` : trimmed;
};

export const logIntegrationEvent = async (input: IntegrationEventInput) => {
  try {
    await query(
      `
        INSERT INTO integration_events (
          id,
          provider,
          operation,
          attempt,
          status_code,
          latency_ms,
          fallback_used,
          error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `,
      [
        randomUUID(),
        trimToUndefined(input.provider) ?? 'unknown',
        trimToUndefined(input.operation) ?? 'unknown',
        normalizeAttempt(input.attempt),
        normalizeStatusCode(input.statusCode),
        normalizeLatency(input.latencyMs),
        Boolean(input.fallbackUsed),
        normalizeErrorText(input.error)
      ]
    );
  } catch (error) {
    console.error('Failed to write integration event', error);
  }
};
