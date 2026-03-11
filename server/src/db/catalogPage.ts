import { query } from '../db';

export type CatalogPageRow = {
  key: string;
  name: string;
  image: string | null;
  created_at: string;
  updated_at: string;
};

export const getCatalogPage = async (): Promise<CatalogPageRow | null> => {
  const result = await query(
    `
      SELECT key, name, image, created_at, updated_at
      FROM catalog_page_settings
      WHERE key = 'catalog'
      LIMIT 1;
    `
  );
  return (result.rows[0] as CatalogPageRow | undefined) ?? null;
};

export const updateCatalogPage = async (input: {
  name: string;
  image?: string | null;
}): Promise<CatalogPageRow> => {
  const result = await query(
    `
      INSERT INTO catalog_page_settings (key, name, image)
      VALUES ('catalog', $1, $2)
      ON CONFLICT (key) DO UPDATE
      SET name = EXCLUDED.name,
          image = COALESCE($2, catalog_page_settings.image),
          updated_at = NOW()
      RETURNING key, name, image, created_at, updated_at;
    `,
    [input.name, input.image ?? null]
  );

  return result.rows[0] as CatalogPageRow;
};
