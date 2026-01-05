import { randomUUID } from 'crypto';
import { query } from '../db';

export type ProductRow = {
  id: string;
  name: string;
  sku: string;
  description: string | null;
  price_cents: number;
  category_slug: string;
  images: string[];
  show_in_slider: boolean;
  slider_order: number;
  stock: number;
  created_at: string;
  updated_at: string;
};

type ProductInput = {
  name: string;
  sku: string;
  description: string | null;
  priceCents: number;
  category: string;
  images: string[];
  showInSlider: boolean;
  sliderOrder: number;
  stock: number;
};

export const listProducts = async (
  category?: string,
  featured?: boolean
): Promise<ProductRow[]> => {
  const conditions: string[] = [];
  const values: Array<string | number | string[] | null> = [];

  if (category) {
    values.push(category);
    conditions.push(`category_slug = $${values.length}`);
  }

  if (featured) {
    conditions.push('show_in_slider = TRUE');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = featured
    ? 'ORDER BY slider_order ASC, created_at DESC'
    : 'ORDER BY created_at DESC';
  const result = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at
      FROM products
      ${whereClause}
      ${orderBy};
    `,
    values
  );

  return result.rows as ProductRow[];
};

export const findProductById = async (id: string): Promise<ProductRow | null> => {
  const result = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at
      FROM products
      WHERE id = $1;
    `,
    [id]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};

export const findProductBySku = async (sku: string): Promise<ProductRow | null> => {
  const result = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at
      FROM products
      WHERE sku = $1;
    `,
    [sku]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};

export const createProduct = async (input: ProductInput): Promise<ProductRow> => {
  const id = randomUUID();
  const result = await query(
    `
      INSERT INTO products (id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at;
    `,
    [
      id,
      input.name,
      input.sku,
      input.description,
      input.priceCents,
      input.category,
      input.images,
      input.showInSlider,
      input.sliderOrder,
      input.stock
    ]
  );

  return result.rows[0] as ProductRow;
};

export const updateProduct = async (
  id: string,
  input: ProductInput
): Promise<ProductRow | null> => {
  const result = await query(
    `
      UPDATE products
      SET name = $2,
          sku = $3,
          description = $4,
          price_cents = $5,
          category_slug = $6,
          images = $7,
          show_in_slider = $8,
          slider_order = $9,
          stock = $10,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at;
    `,
    [
      id,
      input.name,
      input.sku,
      input.description,
      input.priceCents,
      input.category,
      input.images,
      input.showInSlider,
      input.sliderOrder,
      input.stock
    ]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};

export const deleteProduct = async (id: string): Promise<ProductRow | null> => {
  const result = await query(
    `
      DELETE FROM products
      WHERE id = $1
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, stock, created_at, updated_at;
    `,
    [id]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};
