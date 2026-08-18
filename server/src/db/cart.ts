import { query, withClient } from '../db';

export type CartItemRow = {
  product_id: string;
  quantity: number;
  name: string;
  price_cents: number;
  images: string[];
  stock: number;
  weight_grams: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
};

export type CartSyncItem = {
  productId: string;
  quantity: number;
};

export const filterValidCartItems = async (items: CartSyncItem[]) => {
  if (items.length === 0) {
    return [];
  }

  const productIds = Array.from(new Set(items.map((item) => item.productId)));
  const result = await query(`SELECT id FROM products WHERE id = ANY($1::uuid[]);`, [
    productIds
  ]);
  const validIds = new Set(result.rows.map((row) => row.id as string));
  return items.filter((item) => validIds.has(item.productId));
};

export const listCartItems = async (userId: string): Promise<CartItemRow[]> => {
  const result = await query(
    `
      SELECT cart_items.product_id, cart_items.quantity, products.name, products.price_cents, products.images
           , products.stock, products.weight_grams, products.length_cm, products.width_cm, products.height_cm
      FROM cart_items
      JOIN products ON products.id = cart_items.product_id
      WHERE cart_items.user_id = $1
      ORDER BY cart_items.created_at ASC;
    `,
    [userId]
  );

  return result.rows as CartItemRow[];
};

export const mergeCartItems = async (userId: string, items: CartSyncItem[]) => {
  if (items.length === 0) {
    return;
  }

  const values: Array<string | number> = [];
  const rows = items.map((item, index) => {
    const offset = index * 3;
    values.push(userId, item.productId, item.quantity);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  });

  await query(
    `
      INSERT INTO cart_items (user_id, product_id, quantity)
      VALUES ${rows.join(', ')}
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = cart_items.quantity + EXCLUDED.quantity, updated_at = NOW();
    `,
    values
  );
};

export const replaceCartItems = async (userId: string, items: CartSyncItem[]) => {
  if (items.length === 0) {
    await query(`DELETE FROM cart_items WHERE user_id = $1;`, [userId]);
    return;
  }

  const productIds = items.map((item) => item.productId);
  await query(
    `
      DELETE FROM cart_items
      WHERE user_id = $1
        AND NOT (product_id = ANY($2::uuid[]));
    `,
    [userId, productIds]
  );

  const values: Array<string | number> = [];
  const rows = items.map((item, index) => {
    const offset = index * 3;
    values.push(userId, item.productId, item.quantity);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
  });

  await query(
    `
      INSERT INTO cart_items (user_id, product_id, quantity)
      VALUES ${rows.join(', ')}
      ON CONFLICT (user_id, product_id)
      DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW();
    `,
    values
  );
};

export const removeOrderItemsFromCart = async (
  userId: string,
  orderId: string
): Promise<void> =>
  withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const orderResult = await client.query(
        `
          SELECT cart_reconciled_at
          FROM orders
          WHERE id = $2
            AND user_id = $1
            AND status = 'paid'
          FOR UPDATE;
        `,
        [userId, orderId]
      );
      if (!orderResult.rows[0] || orderResult.rows[0].cart_reconciled_at !== null) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `
          SELECT cart.product_id
          FROM cart_items AS cart
          JOIN order_items AS ordered
            ON ordered.product_id = cart.product_id
           AND ordered.order_id = $2
          WHERE cart.user_id = $1
          FOR UPDATE OF cart;
        `,
        [userId, orderId]
      );
      await client.query(
        `
          WITH ordered AS (
            SELECT product_id, SUM(quantity)::int AS quantity
            FROM order_items
            WHERE order_id = $2
            GROUP BY product_id
          )
          DELETE FROM cart_items AS cart
          USING ordered
          WHERE cart.user_id = $1
            AND cart.product_id = ordered.product_id
            AND cart.quantity <= ordered.quantity;
        `,
        [userId, orderId]
      );
      await client.query(
        `
          WITH ordered AS (
            SELECT product_id, SUM(quantity)::int AS quantity
            FROM order_items
            WHERE order_id = $2
            GROUP BY product_id
          )
          UPDATE cart_items AS cart
          SET quantity = cart.quantity - ordered.quantity,
              updated_at = NOW()
          FROM ordered
          WHERE cart.user_id = $1
            AND cart.product_id = ordered.product_id;
        `,
        [userId, orderId]
      );
      await client.query(
        `
          UPDATE orders
          SET cart_reconciled_at = NOW(),
              updated_at = NOW()
          WHERE id = $2
            AND user_id = $1
            AND cart_reconciled_at IS NULL;
        `,
        [userId, orderId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
