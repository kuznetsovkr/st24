import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { query, withClient } from '../db';

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
  payment_status: string | null;
  payment_confirmed_at: string | null;
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

type CreateOrderInput = {
  userId: string;
  fullName: string;
  phone: string;
  email: string;
  pickupPoint: string | null;
  deliveryCostCents: number;
  totalCents: number;
  items: OrderItemInput[];
};

const ORDER_SELECT_FIELDS = `
  id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at
`;

type StockItem = {
  productId: string;
  quantity: number;
};

const loadStockMapForItems = async (
  client: PoolClient,
  items: StockItem[],
  lockRows: boolean
) => {
  if (items.length === 0) {
    return new Map<string, number>();
  }

  const productIds = items.map((item) => item.productId);
  const lockClause = lockRows ? ' FOR UPDATE' : '';
  const stockResult = await client.query(
    `SELECT id, stock FROM products WHERE id = ANY($1::uuid[])${lockClause};`,
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

const debitStockForOrder = async (
  client: PoolClient,
  orderId: string
) => {
  const orderItemsResult = await client.query(
    `
      SELECT product_id, quantity
      FROM order_items
      WHERE order_id = $1;
    `,
    [orderId]
  );

  const items = orderItemsResult.rows.map((row) => ({
    productId: row.product_id as string,
    quantity: row.quantity as number
  }));

  const stockMap = await loadStockMapForItems(client, items, true);
  const issues = collectStockIssues(stockMap, items);
  if (issues.length > 0) {
    throw new InsufficientStockError(issues);
  }

  for (const item of items) {
    await client.query(
      `
        UPDATE products
        SET stock = stock - $2
        WHERE id = $1;
      `,
      [item.productId, item.quantity]
    );
  }
};

const markOrderPaidTransactional = async (
  client: PoolClient,
  order: OrderRow
) => {
  if (order.status === 'paid') {
    return null;
  }

  await debitStockForOrder(client, order.id);

  const result = await client.query(
    `
      UPDATE orders
      SET status = 'paid',
          payment_status = 'succeeded',
          payment_confirmed_at = COALESCE(payment_confirmed_at, NOW()),
          updated_at = NOW()
      WHERE id = $1 AND status <> 'paid'
      RETURNING ${ORDER_SELECT_FIELDS};
    `,
    [order.id]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const createOrder = async (input: CreateOrderInput): Promise<OrderRow> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      if (input.items.length > 0) {
        const stockMap = await loadStockMapForItems(client, input.items, false);
        const issues = collectStockIssues(stockMap, input.items);
        if (issues.length > 0) {
          throw new InsufficientStockError(issues);
        }
      }

      const id = randomUUID();
      const orderResult = await client.query(
        `
          INSERT INTO orders (id, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at;
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
          input.totalCents
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at
      FROM orders
      WHERE payment_id = $1
      ORDER BY updated_at DESC
      LIMIT 1;
    `,
    [paymentId]
  );

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

export const markOrderPaidById = async (id: string): Promise<OrderRow | null> =>
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

      const updated = await markOrderPaidTransactional(client, order);
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

export const updateOrderPayment = async (
  id: string,
  input: UpdateOrderPaymentInput
): Promise<OrderRow | null> => {
  const result = await query(
    `
      UPDATE orders
      SET payment_provider = $2,
          payment_id = $3,
          payment_status = $4,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at;
    `,
    [id, input.provider, input.paymentId, input.paymentStatus]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};

export const updateOrderPaymentStatusById = async (
  id: string,
  paymentStatus: string
): Promise<OrderRow | null> => {
  const result = await query(
    `
      UPDATE orders
      SET payment_status = $2,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, payment_provider, payment_id, payment_status, payment_confirmed_at, created_at, updated_at;
    `,
    [id, paymentStatus]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};
