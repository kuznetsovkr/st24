import { randomUUID } from 'crypto';
import { query } from './db';

type ErrorEventInput = {
  errorClass: string;
  message: string;
  stack?: string | null;
  requestId?: string | null;
  route: string;
  userId?: string | null;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const trimToNull = (value?: string | null) => trimToUndefined(value) ?? null;

const normalizeMessage = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return 'unknown_error';
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 3997)}...` : trimmed;
};

const normalizeStack = (value?: string | null) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 32000 ? `${trimmed.slice(0, 31997)}...` : trimmed;
};

export const logErrorEvent = async (input: ErrorEventInput) => {
  try {
    await query(
      `
        INSERT INTO error_events (
          id,
          error_class,
          message,
          stack,
          request_id,
          route,
          user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7);
      `,
      [
        randomUUID(),
        trimToUndefined(input.errorClass) ?? 'UnknownError',
        normalizeMessage(input.message),
        normalizeStack(input.stack),
        trimToNull(input.requestId),
        trimToUndefined(input.route) ?? 'unknown_route',
        trimToNull(input.userId)
      ]
    );
  } catch (error) {
    console.error('Failed to write error event', error);
  }
};
