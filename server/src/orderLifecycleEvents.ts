import { randomUUID } from 'crypto';
import { query } from './db';

type OrderLifecycleEventInput = {
  eventType: string;
  orderId?: string | null;
  orderNumber?: string | number | null;
  paymentId?: string | null;
  oldStatus?: string | null;
  newStatus?: string | null;
  amountCents?: number | null;
  provider?: string | null;
  error?: string | null;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeOrderNumber = (value?: string | number | null) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return trimToUndefined(typeof value === 'string' ? value : undefined);
};

const normalizeAmountCents = (value?: number | null) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
};

const normalizeErrorText = (value?: string | null) => {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return null;
  }
  return trimmed.length > 4000 ? `${trimmed.slice(0, 3997)}...` : trimmed;
};

export const parseYooKassaAmountCents = (value?: string | null) => {
  const parsed =
    typeof value === 'string' ? Number.parseFloat(value.replace(',', '.')) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, Math.round(parsed * 100));
};

export const logOrderLifecycleEvent = async (input: OrderLifecycleEventInput) => {
  try {
    await query(
      `
        INSERT INTO order_lifecycle_events (
          id,
          event_type,
          order_id,
          order_number,
          payment_id,
          old_status,
          new_status,
          amount_cents,
          provider,
          error
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
      `,
      [
        randomUUID(),
        input.eventType,
        trimToUndefined(input.orderId) ?? null,
        normalizeOrderNumber(input.orderNumber) ?? null,
        trimToUndefined(input.paymentId) ?? null,
        trimToUndefined(input.oldStatus) ?? null,
        trimToUndefined(input.newStatus) ?? null,
        normalizeAmountCents(input.amountCents),
        trimToUndefined(input.provider) ?? null,
        normalizeErrorText(input.error)
      ]
    );
  } catch (error) {
    console.error('Failed to write order lifecycle event', error);
  }
};
