import { createHmac, timingSafeEqual } from 'crypto';
import type { DeliveryProviderKey } from './db/deliveryProviders';

type DeliveryQuotePayload = {
  v: 1;
  provider: DeliveryProviderKey;
  costCents: number;
  currency: 'RUB';
  parcelsHash: string;
  destinationCode?: string;
  tariffCode?: number;
  iat: number;
  exp: number;
};

type CreateDeliveryQuoteInput = {
  provider: DeliveryProviderKey;
  costCents: number;
  parcelsHash: string;
  destinationCode?: string;
  tariffCode?: number;
};

type VerifyDeliveryQuoteResult =
  | { ok: true; payload: DeliveryQuotePayload }
  | { ok: false; reason: string };

const DEFAULT_QUOTE_TTL_SECONDS = 20 * 60;

const parsePositiveEnvInt = (value: string | undefined, fallback: number) => {
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

const getQuoteTtlSeconds = () =>
  parsePositiveEnvInt(process.env.SHIPPING_QUOTE_TTL_SECONDS, DEFAULT_QUOTE_TTL_SECONDS);

const getQuoteSecret = () => {
  const explicitSecret = (process.env.SHIPPING_QUOTE_SECRET ?? '').trim();
  if (explicitSecret) {
    return explicitSecret;
  }

  const jwtSecret = (process.env.JWT_SECRET ?? '').trim();
  if (jwtSecret) {
    return jwtSecret;
  }

  throw new Error('SHIPPING_QUOTE_SECRET or JWT_SECRET must be configured');
};

const toBase64Url = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

const fromBase64Url = (value: string) => Buffer.from(value, 'base64url').toString('utf8');

const sign = (payloadPart: string) =>
  createHmac('sha256', getQuoteSecret()).update(payloadPart).digest('base64url');

const isFinitePositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value);

export const createDeliveryQuoteToken = (input: CreateDeliveryQuoteInput): string => {
  const now = Math.floor(Date.now() / 1000);
  const payload: DeliveryQuotePayload = {
    v: 1,
    provider: input.provider,
    costCents: Math.max(0, Math.round(input.costCents)),
    currency: 'RUB',
    parcelsHash: input.parcelsHash,
    destinationCode: input.destinationCode?.trim() || undefined,
    tariffCode:
      typeof input.tariffCode === 'number' && Number.isFinite(input.tariffCode)
        ? Math.round(input.tariffCode)
        : undefined,
    iat: now,
    exp: now + getQuoteTtlSeconds()
  };

  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signaturePart = sign(payloadPart);
  return `${payloadPart}.${signaturePart}`;
};

export const verifyDeliveryQuoteToken = (token: string): VerifyDeliveryQuoteResult => {
  const trimmed = token.trim();
  if (!trimmed) {
    return { ok: false, reason: 'missing' };
  }

  const parts = trimmed.split('.');
  if (parts.length !== 2) {
    return { ok: false, reason: 'malformed' };
  }

  const [payloadPart, signaturePart] = parts;
  const expectedSignature = sign(payloadPart);
  if (signaturePart.length !== expectedSignature.length) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (
    !timingSafeEqual(Buffer.from(signaturePart, 'utf8'), Buffer.from(expectedSignature, 'utf8'))
  ) {
    return { ok: false, reason: 'invalid_signature' };
  }

  let payloadRaw: unknown;
  try {
    payloadRaw = JSON.parse(fromBase64Url(payloadPart)) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }

  if (!payloadRaw || typeof payloadRaw !== 'object' || Array.isArray(payloadRaw)) {
    return { ok: false, reason: 'invalid_payload' };
  }

  const record = payloadRaw as Record<string, unknown>;
  const provider = typeof record.provider === 'string' ? record.provider : '';
  const currency = record.currency;
  const costCents = record.costCents;
  const iat = record.iat;
  const exp = record.exp;
  const version = record.v;
  const parcelsHash = typeof record.parcelsHash === 'string' ? record.parcelsHash.trim() : '';

  if (version !== 1) {
    return { ok: false, reason: 'invalid_version' };
  }
  if (provider !== 'cdek' && provider !== 'dellin' && provider !== 'russian_post') {
    return { ok: false, reason: 'invalid_provider' };
  }
  if (currency !== 'RUB') {
    return { ok: false, reason: 'invalid_currency' };
  }
  if (!isFinitePositiveInt(costCents)) {
    return { ok: false, reason: 'invalid_cost' };
  }
  if (!isFinitePositiveInt(iat) || !isFinitePositiveInt(exp)) {
    return { ok: false, reason: 'invalid_time' };
  }
  if (!parcelsHash) {
    return { ok: false, reason: 'invalid_parcels' };
  }

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) {
    return { ok: false, reason: 'expired' };
  }

  const destinationCode =
    typeof record.destinationCode === 'string' && record.destinationCode.trim()
      ? record.destinationCode.trim()
      : undefined;
  const tariffCode =
    typeof record.tariffCode === 'number' && Number.isFinite(record.tariffCode)
      ? Math.round(record.tariffCode)
      : undefined;

  return {
    ok: true,
    payload: {
      v: 1,
      provider,
      costCents,
      currency: 'RUB',
      parcelsHash,
      destinationCode,
      tariffCode,
      iat,
      exp
    }
  };
};
