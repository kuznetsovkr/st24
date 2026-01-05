import { query } from '../db';
import type { Category } from '../data/categories';

export const listCategories = async (): Promise<Category[]> => {
  const result = await query(`SELECT slug, name FROM categories ORDER BY name;`);
  return result.rows as Category[];
};

export const isValidCategory = async (slug: string) => {
  const result = await query(`SELECT slug FROM categories WHERE slug = $1;`, [slug]);
  return Boolean(result.rows[0]);
};
