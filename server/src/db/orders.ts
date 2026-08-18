import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, withClient } from '../db';
import { buildPaidOrderNotification } from '../notificationMessages';
import {
  type StockReservationStatus,
  StockReservationInvariantError,
  decidePaymentCancellationStockAction,
  decidePaymentCompletionStockAction,
  decidePaymentCreationStockAction,
  selectPaymentCancellationAttemptKey
} from '../stockReservation';
import { enqueueTelegramOutboxEvent } from './telegramOutbox';

export type OrderRow = {
  id: string;
  order_number: string;
  user_id: string;
  status: string;
  full_name: string;
  phone: string;
  email: string;
  pickup_point: string | null;
  delivery_cost_cents: number;
  total_cents: number;
  payment_provider: string | null;
  payment_id: string | null;
  payment_idempotency_key: string | null;
  payment_creation_started_at: string | null;
  payment_status: string | null;
  payment_confirmed_at: string | null;
  payment_anomaly_code: string | null;
  payment_anomaly_at: string | null;
  stock_reservation_status: StockReservationStatus | null;
  stock_reservation_attempt_key: string | null;
  stock_reserved_at: string | null;
  stock_reservation_consumed_at: string | null;
  stock_reservation_released_at: string | null;
  stock_reservation_reason: string | null;
  cart_reconciled_at: string | null;
  privacy_consent_at: string | null;
  privacy_policy_version: string | null;
  privacy_consent_source: string | null;
  privacy_consent_ip: string | null;
  privacy_consent_user_agent: string | null;
  telegram_notification_required_at: string | null;
  telegram_notified_at: string | null;
  telegram_notification_exempted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrderItemInput = {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
};

export type OrderItemRow = {
  order_id: string;
  product_id: string;
  name: string;
  price_cents: number;
  quantity: number;
  created_at: string;
};

export type StockIssue = {
  productId: string;
  available: number;
  requested: number;
};

export class InsufficientStockError extends Error {
  issues: StockIssue[];

  constructor(issues: StockIssue[]) {
    super('Insufficient stock');
    this.issues = issues;
  }
}

export class CartChangedError extends Error {
  constructor() {
    super('Cart changed while creating the order');
    this.name = 'CartChangedError';
  }
}

type CreateOrderInput = {
  userId: string;
  fullName: string;
  phone: string;
  email: string;
  pickupPoint: string | null;
  deliveryCostCents: number;
  totalCents: number;
  privacyConsentAt: string;
  privacyPolicyVersion: string;
  privacyConsentSource: string;
  privacyConsentIp: string | null;
  privacyConsentUserAgent: string | null;
  items: OrderItemInput[];
};

const ORDER_SELECT_FIELDS = `
  id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_idempotency_key, payment_creation_started_at, payment_status, payment_confirmed_at, payment_anomaly_code, payment_anomaly_at, stock_reservation_status, stock_reservation_attempt_key, stock_reserved_at, stock_reservation_consumed_at, stock_reservation_released_at, stock_reservation_reason, cart_reconciled_at, privacy_consent_at, privacy_policy_version, privacy_consent_source, privacy_consent_ip, privacy_consent_user_agent, telegram_notification_required_at, telegram_notified_at, telegram_notification_exempted_at, created_at, updated_at
`;

type StockItem = {
  productId: string;
  quantity: number;
};

type StockReservationEventType = 'reserved' | 'consumed' | 'released';

const getStockReservationSnapshot = (order: OrderRow) => ({
  status: order.stock_reservation_status,
  attemptKey: order.stock_reservation_attempt_key
});

const normalizeStockItems = (items: StockItem[]) => {
  const quantities = new Map<string, number>();
  for (const item of items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new StockReservationInvariantError();
    }
    quantities.set(
      item.productId,
      (quantities.get(item.productId) ?? 0) + item.quantity
    );
  }
  return [...quantities.entries()]
    .map(([productId, quantity]) => ({ productId, quantity }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
};

const loadStockMapForItems = async (
  client: PoolClient,
  items: StockItem[],
  lockRows: boolean
) => {
  if (items.length === 0) {
    return new Map<string, number>();
  }

  const productIds = [...new Set(items.map((item) => item.productId))].sort();
  const lockClause = lockRows ? ' FOR UPDATE' : '';
  const stockResult = await client.query(
    `SELECT id, stock FROM products WHERE id = ANY($1::uuid[]) ORDER BY id${lockClause};`,
    [productIds]
  );

  return new Map<string, number>(stockResult.rows.map((row) => [row.id as string, row.stock as number]));
};

const collectStockIssues = (
  stockMap: Map<string, number>,
  items: StockItem[]
) => {
  const issues: StockIssue[] = [];
  for (const item of items) {
    const available = stockMap.get(item.productId) ?? 0;
    if (available < item.quantity) {
      issues.push({
        productId: item.productId,
        available,
        requested: item.quantity
      });
    }
  }
  return issues;
};

const loadStockItemsForOrder = async (
  client: PoolClient,
  orderId: string
) => {
  const orderItemsResult = await client.query(
    `
      SELECT product_id, quantity
      FROM order_items
      WHERE order_id = $1
      ORDER BY product_id;
    `,
    [orderId]
  );

  return normalizeStockItems(
    orderItemsResult.rows.map((row) => ({
      productId: row.product_id as string,
      quantity: Number(row.quantity)
    }))
  );
};

const appendStockReservationEvent = async (
  client: PoolClient,
  input: {
    orderId: string;
    attemptKey: string;
    eventType: StockReservationEventType;
    previousStatus: StockReservationStatus | null;
    newStatus: StockReservationStatus;
    reason: string;
    items: StockItem[];
  }
) => {
  await client.query(
    `
      INSERT INTO order_stock_reservation_events (
        id,
        order_id,
        attempt_key,
        event_type,
        previous_status,
        new_status,
        reason,
        items
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb);
    `,
    [
      randomUUID(),
      input.orderId,
      input.attemptKey,
      input.eventType,
      input.previousStatus,
      input.newStatus,
      input.reason,
      JSON.stringify(input.items)
    ]
  );
};

const debitStockItems = async (
  client: PoolClient,
  items: StockItem[]
) => {
  if (items.length === 0) {
    return;
  }

  const stockMap = await loadStockMapForItems(client, items, true);
  const issues = collectStockIssues(stockMap, items);
  if (issues.length > 0) {
    throw new InsufficientStockError(issues);
  }

  for (const item of items) {
    const result = await client.query(
      `
        UPDATE products
        SET stock = stock - $2
        WHERE id = $1
          AND stock >= $2;
      `,
      [item.productId, item.quantity]
    );
    if (result.rowCount !== 1) {
      throw new StockReservationInvariantError();
    }
  }
};

const restoreStockItems = async (
  client: PoolClient,
  items: StockItem[]
) => {
  if (items.length === 0) {
    return;
  }

  const stockMap = await loadStockMapForItems(client, items, true);
  if (stockMap.size !== items.length) {
    throw new StockReservationInvariantError();
  }

  for (const item of items) {
    const result = await client.query(
      `
        UPDATE products
        SET stock = stock + $2
        WHERE id = $1;
      `,
      [item.productId, item.quantity]
    );
    if (result.rowCount !== 1) {
      throw new StockReservationInvariantError();
    }
  }
};

const reserveStockForPaymentAttempt = async (
  client: PoolClient,
  order: OrderRow,
  attemptKey: string,
  isNewAttempt: boolean
): Promise<OrderRow> => {
  const action = decidePaymentCreationStockAction(
    getStockReservationSnapshot(order),
    attemptKey,
    isNewAttempt
  );
  if (action === 'reuse') {
    return order;
  }

  const items = await loadStockItemsForOrder(client, order.id);
  await debitStockItems(client, items);
  const result = await client.query(
    `
      UPDATE orders
      SET stock_reservation_status = 'reserved',
          stock_reservation_attempt_key = $2,
          stock_reserved_at = NOW(),
          stock_reservation_consumed_at = NULL,
          stock_reservation_released_at = NULL,
          stock_reservation_reason = 'payment_creation',
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [order.id, attemptKey]
  );
  const updated = result.rows[0] as OrderRow | undefined;
  if (!updated) {
    throw new StockReservationInvariantError();
  }
  await appendStockReservationEvent(client, {
    orderId: order.id,
    attemptKey,
    eventType: 'reserved',
    previousStatus: order.stock_reservation_status,
    newStatus: 'reserved',
    reason: 'payment_creation',
    items
  });
  return updated;
};

const releaseStockForCanceledPayment = async (
  client: PoolClient,
  order: OrderRow,
  attemptKey: string
): Promise<OrderRow> => {
  const action = decidePaymentCancellationStockAction(
    getStockReservationSnapshot(order),
    attemptKey
  );
  if (action === 'nothing') {
    return order;
  }

  const items = await loadStockItemsForOrder(client, order.id);
  await restoreStockItems(client, items);
  const result = await client.query(
    `
      UPDATE orders
      SET stock_reservation_status = 'released',
          stock_reservation_released_at = NOW(),
          stock_reservation_consumed_at = NULL,
          stock_reservation_reason = 'payment_canceled',
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [order.id]
  );
  const updated = result.rows[0] as OrderRow | undefined;
  if (!updated) {
    throw new StockReservationInvariantError();
  }
  await appendStockReservationEvent(client, {
    orderId: order.id,
    attemptKey,
    eventType: 'released',
    previousStatus: order.stock_reservation_status,
    newStatus: 'released',
    reason: 'payment_canceled',
    items
  });
  return updated;
};

const consumeStockForPaidOrder = async (
  client: PoolClient,
  order: OrderRow,
  payment?: { paymentId: string }
): Promise<OrderRow> => {
  const action = decidePaymentCompletionStockAction(
    getStockReservationSnapshot(order)
  );
  const items = await loadStockItemsForOrder(client, order.id);
  if (action === 'debit_and_consume') {
    await debitStockItems(client, items);
  }

  const attemptKey =
    order.stock_reservation_status === 'reserved'
      ? order.stock_reservation_attempt_key
      : order.payment_idempotency_key ??
        (payment ? `payment:${payment.paymentId}` : `manual:${randomUUID()}`);
  if (!attemptKey) {
    throw new StockReservationInvariantError();
  }
  const reason = payment ? 'payment_succeeded' : 'manual_payment';
  const result = await client.query(
    `
      UPDATE orders
      SET stock_reservation_status = 'consumed',
          stock_reservation_attempt_key = $2,
          stock_reserved_at = CASE
            WHEN stock_reservation_status = 'reserved' THEN stock_reserved_at
            ELSE NOW()
          END,
          stock_reservation_consumed_at = NOW(),
          stock_reservation_released_at = NULL,
          stock_reservation_reason = $3,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [order.id, attemptKey, reason]
  );
  const updated = result.rows[0] as OrderRow | undefined;
  if (!updated) {
    throw new StockReservationInvariantError();
  }
  await appendStockReservationEvent(client, {
    orderId: order.id,
    attemptKey,
    eventType: 'consumed',
    previousStatus: order.stock_reservation_status,
    newStatus: 'consumed',
    reason,
    items
  });
  return updated;
};

const ensurePaidOrderNotificationTransactional = async (
  client: PoolClient,
  order: OrderRow
): Promise<OrderRow> => {
  if (
    order.status !== 'paid' ||
    order.telegram_notified_at !== null ||
    order.telegram_notification_exempted_at !== null
  ) {
    return order;
  }

  const itemsResult = await client.query(
    `
      SELECT order_id, product_id, name, price_cents, quantity, created_at
      FROM order_items
      WHERE order_id = $1
      ORDER BY created_at ASC;
    `,
    [order.id]
  );
  const notification = buildPaidOrderNotification(
    order,
    itemsResult.rows as OrderItemRow[]
  );
  await enqueueTelegramOutboxEvent(client, {
    eventKey: `order-paid:${order.id}`,
    eventType: 'order_paid',
    botKind: 'orders',
    aggregateType: 'order',
    aggregateId: order.id,
    payload: { version: 1, text: notification }
  });

  const refreshed = await client.query(
    `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1;`,
    [order.id]
  );
  return (refreshed.rows[0] as OrderRow | undefined) ?? order;
};

const markOrderPaidTransactional = async (
  client: PoolClient,
  order: OrderRow,
  payment?: {
    provider: string;
    paymentId: string;
  }
) => {
  if (order.status === 'paid') {
    return null;
  }

  await consumeStockForPaidOrder(client, order, payment);

  const result = await client.query(
    `
      UPDATE orders
      SET status = 'paid',
          payment_provider = COALESCE($2, payment_provider),
          payment_id = COALESCE($3, payment_id),
          payment_status = 'succeeded',
          payment_confirmed_at = COALESCE(payment_confirmed_at, NOW()),
          updated_at = NOW()
      WHERE id = $1 AND status <> 'paid'
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [order.id, payment?.provider ?? null, payment?.paymentId ?? null]
  );

  const updated = (result.rows[0] as OrderRow | undefined) ?? null;
  if (!updated) {
    return null;
  }

  return ensurePaidOrderNotificationTransactional(client, updated);
};

export const ensurePaidOrderNotification = async (
  id: string
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1 FOR UPDATE;`,
        [id]
      );
      const order = (result.rows[0] as OrderRow | undefined) ?? null;
      if (!order) {
        await client.query('COMMIT');
        return null;
      }
      const ensured = await ensurePaidOrderNotificationTransactional(client, order);
      await client.query('COMMIT');
      return ensured;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const createOrder = async (input: CreateOrderInput): Promise<OrderRow> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      if (input.items.length > 0) {
        const productIds = input.items.map((item) => item.productId);
        const cartResult = await client.query(
          `
            SELECT product_id, quantity
            FROM cart_items
            WHERE user_id = $1
              AND product_id = ANY($2::uuid[])
            FOR UPDATE;
          `,
          [input.userId, productIds]
        );
        const cartQuantities = new Map<string, number>(
          cartResult.rows.map((row) => [
            String(row.product_id),
            Number(row.quantity)
          ])
        );
        if (
          input.items.some(
            (item) => cartQuantities.get(item.productId) !== item.quantity
          )
        ) {
          throw new CartChangedError();
        }
        const stockMap = await loadStockMapForItems(client, input.items, false);
        const issues = collectStockIssues(stockMap, input.items);
        if (issues.length > 0) {
          throw new InsufficientStockError(issues);
        }
      }

      const id = randomUUID();
      const orderResult = await client.query(
        `
          INSERT INTO orders (
            id,
            user_id,
            status,
            full_name,
            phone,
            email,
            pickup_point,
            delivery_cost_cents,
            total_cents,
            privacy_consent_at,
            privacy_policy_version,
            privacy_consent_source,
            privacy_consent_ip,
            privacy_consent_user_agent,
            cart_reconciled_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
          RETURNING ${ORDER_SELECT_FIELDS};
        `,
        [
          id,
          input.userId,
          'pending',
          input.fullName,
          input.phone,
          input.email,
          input.pickupPoint,
          input.deliveryCostCents,
          input.totalCents,
          input.privacyConsentAt,
          input.privacyPolicyVersion,
          input.privacyConsentSource,
          input.privacyConsentIp,
          input.privacyConsentUserAgent
        ]
      );

      const order = orderResult.rows[0] as OrderRow;

      if (input.items.length > 0) {
        const values: Array<string | number> = [];
        const rows = input.items.map((item, index) => {
          const offset = index * 5;
          values.push(order.id, item.productId, item.name, item.priceCents, item.quantity);
          return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${
            offset + 5
          })`;
        });

        await client.query(
          `
            INSERT INTO order_items (order_id, product_id, name, price_cents, quantity)
            VALUES ${rows.join(', ')};
          `,
          values
        );
        await client.query(
          `
            DELETE FROM cart_items
            WHERE user_id = $1
              AND product_id = ANY($2::uuid[]);
          `,
          [input.userId, input.items.map((item) => item.productId)]
        );
      }

      await client.query('COMMIT');
      return order;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const findOrderByIdForUser = async (
  id: string,
  userId: string
): Promise<OrderRow | null> => {
  const result = await query(
    `
      SELECT ${ORDER_SELECT_FIELDS}
      FROM orders
      WHERE id = $1 AND user_id = $2;
    `,
    [id, userId]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const listOrdersByUser = async (userId: string): Promise<OrderRow[]> => {
  const result = await query(
    `
      SELECT ${ORDER_SELECT_FIELDS}
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC;
    `,
    [userId]
  );

  return result.rows as OrderRow[];
};

export const findOrderById = async (id: string): Promise<OrderRow | null> => {
  const result = await query(
    `
      SELECT ${ORDER_SELECT_FIELDS}
      FROM orders
      WHERE id = $1;
    `,
    [id]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const findOrderByPaymentId = async (paymentId: string): Promise<OrderRow | null> => {
  const result = await query(
    `
      SELECT ${ORDER_SELECT_FIELDS}
      FROM orders
      WHERE payment_id = $1
      LIMIT 2;
    `,
    [paymentId]
  );

  if (result.rows.length > 1) {
    throw new Error('Duplicate order payment identifiers require reconciliation');
  }
  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const listOrderItemsForUser = async (
  orderId: string,
  userId: string
): Promise<OrderItemRow[]> => {
  const result = await query(
    `
      SELECT order_items.order_id,
             order_items.product_id,
             order_items.name,
             order_items.price_cents,
             order_items.quantity,
             order_items.created_at
      FROM order_items
      JOIN orders ON orders.id = order_items.order_id
      WHERE order_items.order_id = $1
        AND orders.user_id = $2
      ORDER BY order_items.created_at ASC;
    `,
    [orderId, userId]
  );

  return result.rows as OrderItemRow[];
};

export const markOrderPaid = async (
  id: string,
  userId: string
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `
          SELECT ${ORDER_SELECT_FIELDS}
          FROM orders
          WHERE id = $1 AND user_id = $2
          FOR UPDATE;
        `,
        [id, userId]
      );
      const order = (orderResult.rows[0] as OrderRow | undefined) ?? null;
      if (!order) {
        await client.query('COMMIT');
        return null;
      }

      const updated = await markOrderPaidTransactional(client, order);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const markOrderPaidById = async (
  id: string,
  payment?: {
    provider: string;
    paymentId: string;
  }
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `
          SELECT ${ORDER_SELECT_FIELDS}
          FROM orders
          WHERE id = $1
          FOR UPDATE;
        `,
        [id]
      );
      const order = (orderResult.rows[0] as OrderRow | undefined) ?? null;
      if (!order) {
        await client.query('COMMIT');
        return null;
      }

      if (order.status === 'paid') {
        const ensured = await ensurePaidOrderNotificationTransactional(client, order);
        await client.query('COMMIT');
        return ensured;
      }

      const updated = await markOrderPaidTransactional(client, order, payment);
      await client.query('COMMIT');
      return updated;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

type UpdateOrderPaymentInput = {
  provider: string;
  paymentId: string;
  paymentStatus: string;
};

export type OrderPaymentReservation =
  | { state: 'paid'; order: OrderRow }
  | { state: 'existing'; order: OrderRow; paymentId: string }
  | { state: 'reconcile'; order: OrderRow }
  | { state: 'create'; order: OrderRow; idempotencyKey: string };

export const reserveOrderPaymentCreation = async (
  id: string,
  userId: string
): Promise<OrderPaymentReservation | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE;`,
        [id, userId]
      );
      const order = (result.rows[0] as OrderRow | undefined) ?? null;
      if (!order) {
        await client.query('COMMIT');
        return null;
      }
      if (order.status === 'paid') {
        const ensured = await ensurePaidOrderNotificationTransactional(client, order);
        await client.query('COMMIT');
        return { state: 'paid', order: ensured };
      }
      if (order.payment_id && order.payment_status !== 'canceled') {
        const attemptKey =
          order.stock_reservation_attempt_key ??
          order.payment_idempotency_key ??
          `legacy-payment:${order.payment_id}`;
        const stockReservedOrder = await reserveStockForPaymentAttempt(
          client,
          order,
          attemptKey,
          false
        );
        await client.query('COMMIT');
        return {
          state: 'existing',
          order: stockReservedOrder,
          paymentId: order.payment_id
        };
      }

      if (order.payment_status === 'creating' && order.payment_idempotency_key) {
        const startedAt = Date.parse(order.payment_creation_started_at ?? '');
        const remainsInsideProviderWindow =
          Number.isFinite(startedAt) && Date.now() - startedAt < 23 * 60 * 60_000;
        if (remainsInsideProviderWindow) {
          const stockReservedOrder = await reserveStockForPaymentAttempt(
            client,
            order,
            order.payment_idempotency_key,
            false
          );
          await client.query('COMMIT');
          return {
            state: 'create',
            order: stockReservedOrder,
            idempotencyKey: order.payment_idempotency_key
          };
        }
        const anomalyResult = await client.query(
          `
            UPDATE orders
            SET payment_anomaly_code = 'payment_reconciliation_required',
                payment_anomaly_at = COALESCE(payment_anomaly_at, NOW()),
                updated_at = NOW()
            WHERE id = $1
            RETURNING ${ORDER_SELECT_FIELDS};
          `,
          [order.id]
        );
        await client.query('COMMIT');
        return {
          state: 'reconcile',
          order: (anomalyResult.rows[0] as OrderRow | undefined) ?? order
        };
      }

      if (order.payment_status !== 'canceled' && order.payment_idempotency_key) {
        const anomalyResult = await client.query(
          `
            UPDATE orders
            SET payment_anomaly_code = 'payment_reconciliation_required',
                payment_anomaly_at = COALESCE(payment_anomaly_at, NOW()),
                updated_at = NOW()
            WHERE id = $1
            RETURNING ${ORDER_SELECT_FIELDS};
          `,
          [order.id]
        );
        await client.query('COMMIT');
        return {
          state: 'reconcile',
          order: (anomalyResult.rows[0] as OrderRow | undefined) ?? order
        };
      }

      const idempotencyKey = randomUUID();
      const stockReservedOrder = await reserveStockForPaymentAttempt(
        client,
        order,
        idempotencyKey,
        true
      );
      const reserved = await client.query(
        `
          UPDATE orders
          SET payment_provider = 'yookassa',
              payment_id = NULL,
              payment_idempotency_key = $2,
              payment_creation_started_at = NOW(),
              payment_status = 'creating',
              updated_at = NOW()
          WHERE id = $1
          RETURNING ${ORDER_SELECT_FIELDS};
        `,
        [order.id, idempotencyKey]
      );
      await client.query('COMMIT');
      return {
        state: 'create',
        order:
          (reserved.rows[0] as OrderRow | undefined) ?? stockReservedOrder,
        idempotencyKey
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const completeOrderPaymentCreation = async (
  id: string,
  idempotencyKey: string,
  input: UpdateOrderPaymentInput
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1 FOR UPDATE;`,
        [id]
      );
      const order = (orderResult.rows[0] as OrderRow | undefined) ?? null;
      if (
        !order ||
        order.payment_idempotency_key !== idempotencyKey ||
        order.status === 'paid' ||
        order.payment_id !== null ||
        order.payment_status !== 'creating'
      ) {
        await client.query('COMMIT');
        return null;
      }

      if (input.paymentStatus === 'canceled') {
        await releaseStockForCanceledPayment(client, order, idempotencyKey);
      }
      const result = await client.query(
        `
          UPDATE orders
          SET payment_provider = $2,
              payment_id = $3,
              payment_status = $4,
              updated_at = NOW()
          WHERE id = $1
          RETURNING ${ORDER_SELECT_FIELDS};
        `,
        [id, input.provider, input.paymentId, input.paymentStatus]
      );
      await client.query('COMMIT');
      return (result.rows[0] as OrderRow | undefined) ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const recordOrderPaymentAnomaly = async (
  id: string,
  code:
    | 'multiple_succeeded_payments'
    | 'stale_succeeded_payment'
    | 'paid_stock_unavailable'
    | 'payment_invariant_violation'
    | 'payment_reconciliation_required'
): Promise<OrderRow | null> => {
  const result = await query(
    `
      UPDATE orders
      SET payment_anomaly_code = $2,
          payment_anomaly_at = COALESCE(payment_anomaly_at, NOW()),
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [id, code]
  );
  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const updateOrderPayment = async (
  id: string,
  input: UpdateOrderPaymentInput
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1 FOR UPDATE;`,
        [id]
      );
      const order = (orderResult.rows[0] as OrderRow | undefined) ?? null;
      const isCurrentPayment =
        order !== null &&
        order.status !== 'paid' &&
        ((order.payment_id === null && order.payment_status === 'creating') ||
          (order.payment_id === input.paymentId &&
            (order.payment_status === null ||
              !['succeeded', 'canceled'].includes(order.payment_status))));
      if (!order || !isCurrentPayment) {
        await client.query('COMMIT');
        return null;
      }

      if (input.paymentStatus === 'canceled') {
        const attemptKey = selectPaymentCancellationAttemptKey(
          order.payment_idempotency_key,
          order.stock_reservation_attempt_key
        );
        if (!attemptKey) {
          if (order.stock_reservation_status !== null) {
            throw new StockReservationInvariantError();
          }
        } else {
          await releaseStockForCanceledPayment(client, order, attemptKey);
        }
      }
      const result = await client.query(
        `
          UPDATE orders
          SET payment_provider = $2,
              payment_id = $3,
              payment_status = $4,
              updated_at = NOW()
          WHERE id = $1
          RETURNING ${ORDER_SELECT_FIELDS};
        `,
        [id, input.provider, input.paymentId, input.paymentStatus]
      );
      await client.query('COMMIT');
      return (result.rows[0] as OrderRow | undefined) ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

export const updateOrderPaymentStatusById = async (
  id: string,
  paymentStatus: string
): Promise<OrderRow | null> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `SELECT ${ORDER_SELECT_FIELDS} FROM orders WHERE id = $1 FOR UPDATE;`,
        [id]
      );
      const order = (orderResult.rows[0] as OrderRow | undefined) ?? null;
      if (!order) {
        await client.query('COMMIT');
        return null;
      }
      if (
        order.status === 'paid' ||
        order.payment_status === 'succeeded' ||
        order.payment_status === 'canceled'
      ) {
        await client.query('COMMIT');
        return order;
      }
      if (
        paymentStatus === 'canceled' &&
        order.status !== 'paid'
      ) {
        const attemptKey = selectPaymentCancellationAttemptKey(
          order.payment_idempotency_key,
          order.stock_reservation_attempt_key
        );
        if (!attemptKey) {
          if (order.stock_reservation_status !== null) {
            throw new StockReservationInvariantError();
          }
        } else {
          await releaseStockForCanceledPayment(client, order, attemptKey);
        }
      }
      const result = await client.query(
        `
          UPDATE orders
          SET payment_status = $2,
              updated_at = NOW()
          WHERE id = $1
          RETURNING ${ORDER_SELECT_FIELDS};
        `,
        [id, paymentStatus]
      );
      await client.query('COMMIT');
      return (result.rows[0] as OrderRow | undefined) ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
