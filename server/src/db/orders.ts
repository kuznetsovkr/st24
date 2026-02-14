import { randomUUID } from 'crypto';
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

export const createOrder = async (input: CreateOrderInput): Promise<OrderRow> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const productIds = input.items.map((item) => item.productId);
      if (productIds.length > 0) {
        const stockResult = await client.query(
          `SELECT id, stock FROM products WHERE id = ANY($1::uuid[]) FOR UPDATE;`,
          [productIds]
        );
        const stockMap = new Map<string, number>(
          stockResult.rows.map((row) => [row.id as string, row.stock as number])
        );
        const issues: StockIssue[] = [];

        for (const item of input.items) {
          const available = stockMap.get(item.productId) ?? 0;
          if (available < item.quantity) {
            issues.push({
              productId: item.productId,
              available,
              requested: item.quantity
            });
          }
        }

        if (issues.length > 0) {
          throw new InsufficientStockError(issues);
        }
      }

      const id = randomUUID();
      const orderResult = await client.query(
        `
          INSERT INTO orders (id, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          RETURNING id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, created_at, updated_at;
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

        for (const item of input.items) {
          await client.query(
            `
              UPDATE products
              SET stock = stock - $2
              WHERE id = $1;
            `,
            [item.productId, item.quantity]
          );
        }
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, created_at, updated_at
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
      SELECT id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, created_at, updated_at
      FROM orders
      WHERE user_id = $1
      ORDER BY created_at DESC;
    `,
    [userId]
  );

  return result.rows as OrderRow[];
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
): Promise<OrderRow | null> => {
  const result = await query(
    `
      UPDATE orders
      SET status = 'paid',
          updated_at = NOW()
      WHERE id = $1 AND user_id = $2
      RETURNING id, order_number, user_id, status, full_name, phone, email, pickup_point, delivery_cost_cents, total_cents, created_at, updated_at;
    `,
    [id, userId]
  );

  return (result.rows[0] as OrderRow | undefined) ?? null;
};
