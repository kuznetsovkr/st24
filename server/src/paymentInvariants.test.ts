import assert from 'node:assert/strict';
import test from 'node:test';
import type { OrderRow } from './db/orders';
import type { YooKassaPayment } from './yookassa';
import {
  hasPaymentOrderAssociationConflict,
  isYooKassaPaymentForCurrentAttempt,
  isYooKassaPaymentSucceeded,
  isSupportedYooKassaPaymentEvent,
  validateYooKassaPaymentForOrder,
  YooKassaPaymentInvariantError
} from './paymentInvariants';

const order = {
  id: '00000000-0000-4000-8000-000000000001',
  total_cents: 12345,
  payment_id: 'payment-1'
} as OrderRow;

const payment = (overrides: Partial<YooKassaPayment> = {}): YooKassaPayment => ({
  id: 'payment-1',
  status: 'succeeded',
  paid: true,
  amount: { value: '123.45', currency: 'RUB' },
  metadata: { orderId: order.id },
  ...overrides
});

test('accepts a payment linked to the order with the exact RUB amount', () => {
  assert.deepEqual(validateYooKassaPaymentForOrder(order, payment()), {
    amountCents: 12345
  });
});

test('binds webhook updates to the persisted payment attempt', () => {
  const creatingOrder = {
    ...order,
    payment_id: null,
    payment_idempotency_key: 'attempt-current'
  } as OrderRow;
  assert.equal(
    isYooKassaPaymentForCurrentAttempt(
      creatingOrder,
      payment({ metadata: { orderId: order.id, paymentAttemptId: 'attempt-current' } })
    ),
    true
  );
  assert.equal(
    isYooKassaPaymentForCurrentAttempt(
      creatingOrder,
      payment({ metadata: { orderId: order.id, paymentAttemptId: 'attempt-old' } })
    ),
    false
  );
  assert.equal(
    isYooKassaPaymentForCurrentAttempt(
      { ...creatingOrder, payment_id: 'payment-1' },
      payment({ metadata: { orderId: order.id } })
    ),
    true
  );
  assert.equal(
    isYooKassaPaymentForCurrentAttempt(
      { ...creatingOrder, payment_id: 'payment-current' },
      payment({ id: 'payment-old', metadata: { orderId: order.id } })
    ),
    false
  );
});

test('does not finalize a waiting_for_capture payment even when YooKassa marks it paid', () => {
  assert.equal(
    isYooKassaPaymentSucceeded(
      payment({ status: 'waiting_for_capture', paid: true })
    ),
    false
  );
  assert.equal(isYooKassaPaymentSucceeded(payment()), true);
});

test('detects a conflict between metadata order and persisted payment owner', () => {
  assert.equal(
    hasPaymentOrderAssociationConflict(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002'
    ),
    true
  );
  assert.equal(
    hasPaymentOrderAssociationConflict(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001'
    ),
    false
  );
  assert.equal(hasPaymentOrderAssociationConflict(null, order.id), false);
});

test('accepts only payment lifecycle webhook events', () => {
  assert.equal(isSupportedYooKassaPaymentEvent('payment.succeeded'), true);
  assert.equal(isSupportedYooKassaPaymentEvent('payment.canceled'), true);
  assert.equal(isSupportedYooKassaPaymentEvent('refund.succeeded'), false);
  assert.equal(isSupportedYooKassaPaymentEvent(undefined), false);
});

for (const [name, snapshot, expectedCode] of [
  [
    'rejects a payment linked to another order',
    payment({ metadata: { orderId: '00000000-0000-4000-8000-000000000099' } }),
    'payment_metadata_order_mismatch'
  ],
  [
    'rejects another currency',
    payment({ amount: { value: '123.45', currency: 'USD' } }),
    'payment_currency_mismatch'
  ],
  [
    'rejects another amount',
    payment({ amount: { value: '1.00', currency: 'RUB' } }),
    'payment_amount_mismatch'
  ]
] as const) {
  test(name, () => {
    assert.throws(
      () => validateYooKassaPaymentForOrder(order, snapshot),
      (error: unknown) =>
        error instanceof YooKassaPaymentInvariantError && error.code === expectedCode
    );
  });
}
