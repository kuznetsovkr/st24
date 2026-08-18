import assert from 'node:assert/strict';
import test from 'node:test';
import {
  StockReservationInvariantError,
  decidePaymentCancellationStockAction,
  decidePaymentCompletionStockAction,
  decidePaymentCreationStockAction,
  selectPaymentCancellationAttemptKey
} from './stockReservation';

test('payment creation reserves once and reuses the current reservation', () => {
  assert.equal(
    decidePaymentCreationStockAction(
      { status: null, attemptKey: null },
      'attempt-1',
      true
    ),
    'reserve'
  );
  assert.equal(
    decidePaymentCreationStockAction(
      { status: 'reserved', attemptKey: 'attempt-1' },
      'attempt-1',
      false
    ),
    'reuse'
  );
});

test('a new attempt can reserve again only after the previous release', () => {
  assert.equal(
    decidePaymentCreationStockAction(
      { status: 'released', attemptKey: 'attempt-1' },
      'attempt-2',
      true
    ),
    'reserve'
  );
  assert.throws(
    () =>
      decidePaymentCreationStockAction(
        { status: 'reserved', attemptKey: 'attempt-1' },
        'attempt-2',
        true
      ),
    StockReservationInvariantError
  );
});

test('payment completion consumes reserved stock without a second debit', () => {
  assert.equal(
    decidePaymentCompletionStockAction({
      status: 'reserved',
      attemptKey: 'attempt-1'
    }),
    'consume'
  );
  assert.equal(
    decidePaymentCompletionStockAction({ status: null, attemptKey: null }),
    'debit_and_consume'
  );
  assert.equal(
    decidePaymentCompletionStockAction({
      status: 'released',
      attemptKey: 'attempt-1'
    }),
    'debit_and_consume'
  );
});

test('cancellation releases the current reservation exactly once', () => {
  assert.equal(
    decidePaymentCancellationStockAction(
      { status: 'reserved', attemptKey: 'attempt-1' },
      'attempt-1'
    ),
    'release'
  );
  assert.equal(
    decidePaymentCancellationStockAction(
      { status: 'released', attemptKey: 'attempt-1' },
      'attempt-1'
    ),
    'nothing'
  );
  assert.throws(
    () =>
      decidePaymentCancellationStockAction(
        { status: 'reserved', attemptKey: 'attempt-2' },
        'attempt-1'
      ),
    StockReservationInvariantError
  );
});

test('legacy cancellation uses its reservation key but never hides a current-key mismatch', () => {
  const legacyKey = selectPaymentCancellationAttemptKey(
    null,
    'legacy-payment:payment-1'
  );
  assert.equal(legacyKey, 'legacy-payment:payment-1');
  assert.equal(
    decidePaymentCancellationStockAction(
      { status: 'reserved', attemptKey: legacyKey },
      legacyKey ?? ''
    ),
    'release'
  );

  const currentKey = selectPaymentCancellationAttemptKey(
    'current-attempt',
    'stale-reservation'
  );
  assert.throws(
    () =>
      decidePaymentCancellationStockAction(
        { status: 'reserved', attemptKey: 'stale-reservation' },
        currentKey ?? ''
      ),
    StockReservationInvariantError
  );
});

test('ambiguous consumed state is never automatically released or reused', () => {
  assert.throws(
    () =>
      decidePaymentCancellationStockAction(
        { status: 'consumed', attemptKey: 'attempt-1' },
        'attempt-1'
      ),
    StockReservationInvariantError
  );
  assert.throws(
    () =>
      decidePaymentCreationStockAction(
        { status: 'consumed', attemptKey: 'attempt-1' },
        'attempt-2',
        true
      ),
    StockReservationInvariantError
  );
});
