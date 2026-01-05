import { query } from '../db';

export type CartItemRow = {
  product_id: string;
  quantity: number;
  name: string;
  price_cents: number;
  images: string[];
  stock: number;
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
           , products.stock
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
