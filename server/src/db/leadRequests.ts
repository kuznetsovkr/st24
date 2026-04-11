import { randomUUID } from 'crypto';
import { query } from '../db';

export type LeadRequestKind = 'b2b' | 'need_part' | 'need_part_catalog';

export type LeadRequestTelegramStatus = 'pending' | 'sent' | 'failed';

export type LeadRequestRow = {
  id: string;
  kind: LeadRequestKind;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  payload: Record<string, unknown>;
  telegram_status: LeadRequestTelegramStatus;
  telegram_error: string | null;
  telegram_sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type CreateLeadRequestInput = {
  kind: LeadRequestKind;
  fullName?: string | null;
  phone?: string | null;
  email?: string | null;
  payload?: Record<string, unknown>;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const trimToNull = (value?: string | null) => trimToUndefined(value) ?? null;

const normalizePhone = (value?: string | null) => {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits || null;
};

const normalizeEmail = (value?: string | null) => {
  const normalized = trimToUndefined(value)?.toLowerCase();
  return normalized ?? null;
};

const normalizeTelegramError = (value?: string | null) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 3997)}...` : trimmed;
};

export const createLeadRequest = async (input: CreateLeadRequestInput): Promise<LeadRequestRow> => {
  const result = await query(
    `
      INSERT INTO lead_requests (
        id,
        kind,
        full_name,
        phone,
        email,
        payload,
        telegram_status
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING id, kind, full_name, phone, email, payload, telegram_status, telegram_error, telegram_sent_at, created_at, updated_at;
    `,
    [
      randomUUID(),
      input.kind,
      trimToNull(input.fullName),
      normalizePhone(input.phone),
      normalizeEmail(input.email),
      JSON.stringify(input.payload ?? {}),
      'pending'
    ]
  );

  return result.rows[0] as LeadRequestRow;
};

export const markLeadRequestTelegramSent = async (id: string) => {
  await query(
    `
      UPDATE lead_requests
      SET telegram_status = 'sent',
          telegram_error = NULL,
          telegram_sent_at = NOW(),
          updated_at = NOW()
      WHERE id = $1;
    `,
    [id]
  );
};

export const markLeadRequestTelegramFailed = async (id: string, error?: string | null) => {
  await query(
    `
      UPDATE lead_requests
      SET telegram_status = 'failed',
          telegram_error = $2,
          updated_at = NOW()
      WHERE id = $1;
    `,
    [id, normalizeTelegramError(error)]
  );
};

