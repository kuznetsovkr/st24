export const DEFAULT_TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS = 7;
export const DEFAULT_TELEGRAM_OUTBOX_RETENTION_DAYS = 90;

export const parseTelegramOutboxMaxRetryAgeDays = (
  value: string | undefined
): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS;
  }
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error('TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS must be a positive integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > 3_650) {
    throw new Error('TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS must be between 1 and 3650');
  }
  return parsed;
};

export const getTelegramOutboxMaxRetryAgeDays = () =>
  parseTelegramOutboxMaxRetryAgeDays(
    process.env.TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS
  );

export const parseTelegramOutboxRetentionDays = (
  value: string | undefined
): number => {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_TELEGRAM_OUTBOX_RETENTION_DAYS;
  }
  const normalized = value.trim();
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new Error('TELEGRAM_OUTBOX_RETENTION_DAYS must be a positive integer');
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > 3_650) {
    throw new Error('TELEGRAM_OUTBOX_RETENTION_DAYS must be between 1 and 3650');
  }
  return parsed;
};

export const getTelegramOutboxRetentionDays = () =>
  parseTelegramOutboxRetentionDays(
    process.env.TELEGRAM_OUTBOX_RETENTION_DAYS
  );
