import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPaidOrderNotification } from './notificationMessages';
import type { OrderItemRow, OrderRow } from './db/orders';

const order: OrderRow = {
  id: '00000000-0000-4000-8000-000000000001',
  order_number: '42',
  user_id: '00000000-0000-4000-8000-000000000002',
  status: 'paid',
  full_name: 'Иван Иванов',
  phone: '8 (999) 123-45-67',
  email: 'buyer@example.test',
  pickup_point: null,
  delivery_cost_cents: 50000,
  total_cents: 250000,
  payment_provider: 'yookassa',
  payment_id: 'payment-1',
  payment_idempotency_key: null,
  payment_creation_started_at: null,
  payment_status: 'succeeded',
  payment_confirmed_at: '2026-08-09T00:00:00.000Z',
  payment_anomaly_code: null,
  payment_anomaly_at: null,
  stock_reservation_status: 'consumed',
  stock_reservation_attempt_key: 'attempt-1',
  stock_reserved_at: '2026-08-09T00:00:00.000Z',
  stock_reservation_consumed_at: '2026-08-09T00:00:00.000Z',
  stock_reservation_released_at: null,
  stock_reservation_reason: 'payment_succeeded',
  cart_reconciled_at: null,
  privacy_consent_at: null,
  privacy_policy_version: null,
  privacy_consent_source: null,
  privacy_consent_ip: null,
  privacy_consent_user_agent: null,
  telegram_notification_required_at: '2026-08-09T00:00:00.000Z',
  telegram_notified_at: null,
  telegram_notification_exempted_at: null,
  created_at: '2026-08-09T00:00:00.000Z',
  updated_at: '2026-08-09T00:00:00.000Z'
};

test('paid order notification is an immutable human-readable snapshot', () => {
  const items: OrderItemRow[] = [
    {
      order_id: order.id,
      product_id: '00000000-0000-4000-8000-000000000003',
      name: 'Насос',
      price_cents: 100000,
      quantity: 2,
      created_at: order.created_at
    }
  ];

  const message = buildPaidOrderNotification(order, items);

  assert.match(message, /Номер заказа: 42/);
  assert.match(message, /Телефон: \+79991234567/);
  assert.match(message, /Насос x2/);
  assert.match(message, /Пункт выдачи: не указан/);
});
