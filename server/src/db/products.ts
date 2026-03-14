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
  weight_grams: number;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  stock: number;
  is_hidden: boolean;
  created_at: string;
  updated_at: string;
};

export type ProductSkuSearchResult = {
  items: ProductRow[];
  total: number;
  usedFallback: boolean;
  fallbackPrefix: string | null;
};

export type ProductListResult = {
  items: ProductRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

type ListProductsInput = {
  category?: string;
  featured?: boolean;
  includeHidden?: boolean;
  limit: number;
  offset: number;
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
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  stock: number;
  isHidden: boolean;
};

export const listProducts = async ({
  category,
  featured,
  includeHidden,
  limit,
  offset
}: ListProductsInput): Promise<ProductListResult> => {
  const conditions: string[] = [];
  const values: Array<string | number | string[] | null> = [];

  if (category) {
    values.push(category);
    conditions.push(`category_slug = $${values.length}`);
  }

  if (featured) {
    conditions.push('show_in_slider = TRUE');
  }

  if (!includeHidden) {
    conditions.push('is_hidden = FALSE');
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderBy = featured
    ? 'ORDER BY slider_order ASC, created_at DESC'
    : 'ORDER BY created_at DESC';

  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM products
      ${whereClause};
    `,
    values
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const rowsParams = [...values, limit, offset];
  const limitParamIndex = values.length + 1;
  const offsetParamIndex = values.length + 2;
  const result = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at
      FROM products
      ${whereClause}
      ${orderBy}
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex};
    `,
    rowsParams
  );

  const items = result.rows as ProductRow[];
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < total;

  return {
    items,
    total,
    limit,
    offset,
    hasMore,
    nextOffset: hasMore ? nextOffset : null
  };
};

export const findProductById = async (id: string): Promise<ProductRow | null> => {
  const result = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at
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
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at
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
      INSERT INTO products (
        id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order,
        weight_grams, length_cm, width_cm, height_cm, stock, is_hidden
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at;
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
      input.weightGrams,
      input.lengthCm,
      input.widthCm,
      input.heightCm,
      input.stock,
      input.isHidden
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
          weight_grams = $10,
          length_cm = $11,
          width_cm = $12,
          height_cm = $13,
          stock = $14,
          is_hidden = $15,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at;
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
      input.weightGrams,
      input.lengthCm,
      input.widthCm,
      input.heightCm,
      input.stock,
      input.isHidden
    ]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};

export const deleteProduct = async (id: string): Promise<ProductRow | null> => {
  const result = await query(
    `
      DELETE FROM products
      WHERE id = $1
      RETURNING id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at;
    `,
    [id]
  );

  return (result.rows[0] as ProductRow | undefined) ?? null;
};

const SKU_NORMALIZED_SQL = `regexp_replace(lower(sku), '[^[:alnum:]]+', '', 'g')`;

const buildLimitClause = (limit?: number) => {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return '';
  }
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
  return `LIMIT ${safeLimit}`;
};

export const searchProductsBySku = async (
  skuQuery: string,
  limit?: number
): Promise<ProductSkuSearchResult> => {
  const normalizedQuery = skuQuery
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  if (!normalizedQuery) {
    return {
      items: [],
      total: 0,
      usedFallback: false,
      fallbackPrefix: null
    };
  }

  const limitClause = buildLimitClause(limit);
  const fallbackPrefix = normalizedQuery.slice(0, 4);

  const exactCountResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM products
      WHERE ${SKU_NORMALIZED_SQL} LIKE $1 || '%'
        AND is_hidden = FALSE;
    `,
    [normalizedQuery]
  );
  const exactTotal = Number(exactCountResult.rows[0]?.count ?? 0);

  if (exactTotal > 0) {
    const exactItemsResult = await query(
      `
        SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at
        FROM products
        WHERE ${SKU_NORMALIZED_SQL} LIKE $1 || '%'
          AND is_hidden = FALSE
        ORDER BY
          CASE WHEN ${SKU_NORMALIZED_SQL} = $1 THEN 0 ELSE 1 END,
          LENGTH(${SKU_NORMALIZED_SQL}) ASC,
          created_at DESC
        ${limitClause};
      `,
      [normalizedQuery]
    );

    return {
      items: exactItemsResult.rows as ProductRow[],
      total: exactTotal,
      usedFallback: false,
      fallbackPrefix: null
    };
  }

  if (fallbackPrefix.length < 4) {
    return {
      items: [],
      total: 0,
      usedFallback: false,
      fallbackPrefix: null
    };
  }

  const fallbackCountResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM products
      WHERE ${SKU_NORMALIZED_SQL} LIKE $1 || '%'
        AND is_hidden = FALSE;
    `,
    [fallbackPrefix]
  );
  const fallbackTotal = Number(fallbackCountResult.rows[0]?.count ?? 0);

  if (fallbackTotal === 0) {
    return {
      items: [],
      total: 0,
      usedFallback: true,
      fallbackPrefix
    };
  }

  const fallbackItemsResult = await query(
    `
      SELECT id, name, sku, description, price_cents, category_slug, images, show_in_slider, slider_order, weight_grams, length_cm, width_cm, height_cm, stock, is_hidden, created_at, updated_at
      FROM products
      WHERE ${SKU_NORMALIZED_SQL} LIKE $1 || '%'
        AND is_hidden = FALSE
      ORDER BY created_at DESC
      ${limitClause};
    `,
    [fallbackPrefix]
  );

  return {
    items: fallbackItemsResult.rows as ProductRow[],
    total: fallbackTotal,
    usedFallback: true,
    fallbackPrefix
  };
};
