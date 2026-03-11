import { query } from '../db';

export type CategoryRow = {
  slug: string;
  name: string;
  image: string | null;
  created_at: string;
  updated_at: string;
};

export const listCategories = async (): Promise<CategoryRow[]> => {
  const result = await query(
    `
      SELECT slug, name, image, created_at, updated_at
      FROM categories
      ORDER BY name;
    `
  );
  return result.rows as CategoryRow[];
};

export const findCategoryBySlug = async (slug: string): Promise<CategoryRow | null> => {
  const result = await query(
    `
      SELECT slug, name, image, created_at, updated_at
      FROM categories
      WHERE slug = $1
      LIMIT 1;
    `,
    [slug]
  );
  return (result.rows[0] as CategoryRow | undefined) ?? null;
};

export const updateCategory = async (
  slug: string,
  input: {
    slug: string;
    name: string;
    image: string | null;
    hasImageUpdate: boolean;
  }
): Promise<CategoryRow | null> => {
  const result = await query(
    `
      UPDATE categories
      SET slug = $2,
          name = $3,
          image = CASE WHEN $4 THEN $5 ELSE image END,
          updated_at = NOW()
      WHERE slug = $1
      RETURNING slug, name, image, created_at, updated_at;
    `,
    [slug, input.slug, input.name, input.hasImageUpdate, input.image]
  );

  return (result.rows[0] as CategoryRow | undefined) ?? null;
};

export const countCategoryProducts = async (slug: string): Promise<number> => {
  const result = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM products
      WHERE category_slug = $1;
    `,
    [slug]
  );

  return Number(result.rows[0]?.count ?? 0);
};

export const deleteCategory = async (slug: string): Promise<CategoryRow | null> => {
  const result = await query(
    `
      DELETE FROM categories
      WHERE slug = $1
      RETURNING slug, name, image, created_at, updated_at;
    `,
    [slug]
  );

  return (result.rows[0] as CategoryRow | undefined) ?? null;
};

export const isValidCategory = async (slug: string) => {
  const result = await query(`SELECT slug FROM categories WHERE slug = $1;`, [slug]);
  return Boolean(result.rows[0]);
};
