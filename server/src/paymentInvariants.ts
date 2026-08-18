import type { OrderRow } from './db/orders';
import type { YooKassaPayment } from './yookassa';

export type YooKassaPaymentInvariantCode =
  | 'payment_identity_invalid'
  | 'payment_not_linked_to_order'
  | 'payment_metadata_order_mismatch'
  | 'payment_currency_mismatch'
  | 'payment_amount_invalid'
  | 'payment_amount_mismatch';

export class YooKassaPaymentInvariantError extends Error {
  readonly code: YooKassaPaymentInvariantCode;

  constructor(code: YooKassaPaymentInvariantCode) {
    super(code);
    this.name = 'YooKassaPaymentInvariantError';
    this.code = code;
  }
}

const parseExactAmountCents = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }
  const [rubles = '', kopecks = ''] = value.split('.');
  const normalizedKopecks = kopecks.padEnd(2, '0');
  const amount = Number(rubles) * 100 + Number(normalizedKopecks);
  return Number.isSafeInteger(amount) ? amount : null;
};

export const isYooKassaPaymentForCurrentAttempt = (
  order: OrderRow,
  payment: YooKassaPayment
): boolean => {
  const paymentId = payment.id?.trim();
  const paymentAttemptId = payment.metadata?.paymentAttemptId?.trim() || null;
  const paymentIdMismatch = Boolean(
    order.payment_id && order.payment_id !== paymentId
  );
  const attemptMismatch = Boolean(
    order.payment_idempotency_key &&
      paymentAttemptId !== order.payment_idempotency_key &&
      (!order.payment_id || order.payment_id !== paymentId)
  );
  return !paymentIdMismatch && !attemptMismatch;
};

export const isYooKassaPaymentSucceeded = (payment: YooKassaPayment): boolean =>
  payment.status === 'succeeded';

export const hasPaymentOrderAssociationConflict = (
  metadataOrderId: string | null,
  linkedOrderId: string | null
): boolean =>
  Boolean(
    metadataOrderId &&
      linkedOrderId &&
      metadataOrderId !== linkedOrderId
  );

const SUPPORTED_YOOKASSA_PAYMENT_EVENTS = new Set([
  'payment.succeeded',
  'payment.waiting_for_capture',
  'payment.canceled'
]);

export const isSupportedYooKassaPaymentEvent = (value: unknown): value is string =>
  typeof value === 'string' && SUPPORTED_YOOKASSA_PAYMENT_EVENTS.has(value.trim());

export const validateYooKassaPaymentForOrder = (
  order: OrderRow,
  payment: YooKassaPayment
): { amountCents: number } => {
  const paymentId = payment.id?.trim();
  if (!paymentId || !payment.status?.trim()) {
    throw new YooKassaPaymentInvariantError('payment_identity_invalid');
  }

  const metadataOrderId = payment.metadata?.orderId?.trim();
  if (metadataOrderId && metadataOrderId !== order.id) {
    throw new YooKassaPaymentInvariantError('payment_metadata_order_mismatch');
  }
  if (!metadataOrderId && order.payment_id !== paymentId) {
    throw new YooKassaPaymentInvariantError('payment_not_linked_to_order');
  }

  if (payment.amount?.currency !== 'RUB') {
    throw new YooKassaPaymentInvariantError('payment_currency_mismatch');
  }
  const amountCents = parseExactAmountCents(payment.amount?.value);
  if (amountCents === null) {
    throw new YooKassaPaymentInvariantError('payment_amount_invalid');
  }
  if (amountCents !== order.total_cents) {
    throw new YooKassaPaymentInvariantError('payment_amount_mismatch');
  }

  return { amountCents };
};
