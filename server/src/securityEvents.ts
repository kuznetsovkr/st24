import { createHash, randomUUID } from 'crypto';
import type { Request } from 'express';
import { query } from './db';

type SecurityEventInput = {
  eventType: string;
  reason: string;
  route: string;
  method: string;
  ip?: string | null;
  phoneMasked?: string | null;
  emailMasked?: string | null;
  userId?: string | null;
};

type SecurityEventFromRequestInput = {
  eventType: string;
  reason: string;
  route?: string;
  method?: string;
  phoneMasked?: string | null;
  emailMasked?: string | null;
  userId?: string | null;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeIp = (value?: string | null) => {
  const normalized = trimToUndefined(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized;
};

const getSecurityLogSalt = () =>
  trimToUndefined(process.env.SECURITY_LOG_SALT) ??
  trimToUndefined(process.env.JWT_SECRET) ??
  'security-log-fallback-salt';

const hashIp = (ip?: string | null) => {
  const normalized = normalizeIp(ip);
  if (!normalized) {
    return undefined;
  }
  return createHash('sha256')
    .update(`${getSecurityLogSalt()}:${normalized}`)
    .digest('hex');
};

const normalizePhoneDigits = (value: string) => value.replace(/\D/g, '');

export const maskPhone = (value?: string | null) => {
  const digits = normalizePhoneDigits(value ?? '');
  if (!digits) {
    return undefined;
  }
  const visiblePart = digits.slice(-4);
  const hiddenLength = Math.max(0, digits.length - visiblePart.length);
  return `${'*'.repeat(hiddenLength)}${visiblePart}`;
};

export const maskEmail = (value?: string | null) => {
  const normalized = trimToUndefined(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const atIndex = normalized.indexOf('@');
  if (atIndex < 0) {
    if (normalized.length <= 2) {
      return '*'.repeat(normalized.length);
    }
    return `${normalized[0]}${'*'.repeat(Math.max(1, normalized.length - 2))}${
      normalized[normalized.length - 1]
    }`;
  }

  const local = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  if (!local || !domain) {
    return undefined;
  }
  const visibleLocal = local[0] ?? '*';
  const maskedLocal = `${visibleLocal}${'*'.repeat(Math.max(1, local.length - 1))}`;
  return `${maskedLocal}@${domain}`;
};

const normalizeRoute = (value: string) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return '/';
  }
  const noQuery = trimmed.split('?')[0];
  return noQuery || '/';
};

const normalizeMethod = (value: string) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return 'UNKNOWN';
  }
  return trimmed.toUpperCase();
};

const resolveRequestRoute = (req: Request) =>
  normalizeRoute(trimToUndefined(req.originalUrl) ?? trimToUndefined(req.path) ?? '/');

export const getRequestIp = (req: Request) =>
  normalizeIp(trimToUndefined(req.ip) ?? trimToUndefined(req.socket.remoteAddress));

export const logSecurityEvent = async (input: SecurityEventInput) => {
  try {
    await query(
      `
        INSERT INTO security_events (
          id,
          event_type,
          ip_hash,
          phone_masked,
          email_masked,
          reason,
          route,
          method,
          user_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9);
      `,
      [
        randomUUID(),
        input.eventType,
        hashIp(input.ip) ?? null,
        trimToUndefined(input.phoneMasked) ?? null,
        trimToUndefined(input.emailMasked) ?? null,
        input.reason,
        normalizeRoute(input.route),
        normalizeMethod(input.method),
        trimToUndefined(input.userId) ?? null
      ]
    );
  } catch (error) {
    console.error('Failed to write security event', error);
  }
};

export const logSecurityEventFromRequest = (
  req: Request,
  input: SecurityEventFromRequestInput
) => {
  void logSecurityEvent({
    eventType: input.eventType,
    reason: input.reason,
    route: input.route ?? resolveRequestRoute(req),
    method: input.method ?? req.method,
    ip: getRequestIp(req),
    phoneMasked: input.phoneMasked,
    emailMasked: input.emailMasked,
    userId: input.userId
  });
};
