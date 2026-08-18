export type StockReservationStatus = 'reserved' | 'consumed' | 'released';

export type StockReservationSnapshot = {
  status: StockReservationStatus | null;
  attemptKey: string | null;
};

export type PaymentCreationStockAction = 'reserve' | 'reuse';
export type PaymentCompletionStockAction = 'consume' | 'debit_and_consume';
export type PaymentCancellationStockAction = 'release' | 'nothing';

export class StockReservationInvariantError extends Error {
  readonly code = 'stock_reservation_invariant_violation';

  constructor() {
    super('Stock reservation requires reconciliation');
    this.name = 'StockReservationInvariantError';
  }
}

const failInvariant = (): never => {
  throw new StockReservationInvariantError();
};

export const decidePaymentCreationStockAction = (
  snapshot: StockReservationSnapshot,
  attemptKey: string,
  isNewAttempt: boolean
): PaymentCreationStockAction => {
  if (!attemptKey) {
    return failInvariant();
  }

  if (isNewAttempt) {
    if (snapshot.status === null) {
      return 'reserve';
    }
    if (snapshot.status === 'released' && snapshot.attemptKey) {
      return 'reserve';
    }
    return failInvariant();
  }

  if (snapshot.status === null) {
    // A pre-migration attempt can be retried safely only after stock is reserved.
    return 'reserve';
  }
  if (
    snapshot.status === 'reserved' &&
    snapshot.attemptKey === attemptKey
  ) {
    return 'reuse';
  }
  return failInvariant();
};

export const decidePaymentCompletionStockAction = (
  snapshot: StockReservationSnapshot
): PaymentCompletionStockAction => {
  if (snapshot.status === 'reserved' && snapshot.attemptKey) {
    return 'consume';
  }
  if (snapshot.status === null) {
    return 'debit_and_consume';
  }
  if (snapshot.status === 'released' && snapshot.attemptKey) {
    return 'debit_and_consume';
  }
  return failInvariant();
};

export const decidePaymentCancellationStockAction = (
  snapshot: StockReservationSnapshot,
  attemptKey: string
): PaymentCancellationStockAction => {
  if (snapshot.status === null) {
    // Legacy attempts did not decrement stock, so there is nothing to restore.
    return 'nothing';
  }
  if (!attemptKey) {
    return failInvariant();
  }
  if (
    snapshot.status === 'reserved' &&
    snapshot.attemptKey === attemptKey
  ) {
    return 'release';
  }
  if (
    snapshot.status === 'released' &&
    snapshot.attemptKey === attemptKey
  ) {
    return 'nothing';
  }
  return failInvariant();
};

export const selectPaymentCancellationAttemptKey = (
  paymentAttemptKey: string | null,
  reservationAttemptKey: string | null
) => paymentAttemptKey ?? reservationAttemptKey;
