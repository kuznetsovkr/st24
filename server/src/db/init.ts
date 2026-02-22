import { categories } from '../data/categories';
import { query } from '../db';

export const initDb = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS products (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE,
      description TEXT,
      price_cents INTEGER NOT NULL,
      category_slug TEXT NOT NULL REFERENCES categories(slug),
      images TEXT[] NOT NULL DEFAULT '{}',
      show_in_slider BOOLEAN NOT NULL DEFAULT FALSE,
      slider_order INTEGER NOT NULL DEFAULT 0,
      weight_grams INTEGER NOT NULL DEFAULT 500,
      length_cm INTEGER NOT NULL DEFAULT 10,
      width_cm INTEGER NOT NULL DEFAULT 10,
      height_cm INTEGER NOT NULL DEFAULT 10,
      stock INTEGER NOT NULL DEFAULT 0,
      is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS show_in_slider BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS slider_order INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS weight_grams INTEGER NOT NULL DEFAULT 500;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS length_cm INTEGER NOT NULL DEFAULT 10;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS width_cm INTEGER NOT NULL DEFAULT 10;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS height_cm INTEGER NOT NULL DEFAULT 10;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS box_types (
      id UUID PRIMARY KEY,
      name TEXT NOT NULL,
      length_cm INTEGER NOT NULL,
      width_cm INTEGER NOT NULL,
      height_cm INTEGER NOT NULL,
      max_weight_grams INTEGER NOT NULL,
      empty_weight_grams INTEGER NOT NULL,
      fill_ratio REAL NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE box_types
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      phone TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      email TEXT,
      full_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS email TEXT;
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS full_name TEXT;
  `);

  await query(`
    ALTER TABLE users
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS email_codes (
      email TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY,
      order_number BIGSERIAL UNIQUE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL,
      pickup_point TEXT,
      delivery_cost_cents INTEGER NOT NULL DEFAULT 0,
      total_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS delivery_cost_cents INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_items (
      order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id UUID NOT NULL,
      name TEXT NOT NULL,
      price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (order_id, product_id)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_subscribers (
      chat_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      chat_type TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_order_subscribers (
      chat_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      chat_type TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_b2b_subscribers (
      chat_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      last_name TEXT,
      language_code TEXT,
      chat_type TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, product_id)
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_slug);`);
  await query(`CREATE INDEX IF NOT EXISTS box_types_sort_idx ON box_types (sort_order);`);
  await query(`CREATE INDEX IF NOT EXISTS cart_items_user_idx ON cart_items (user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id);`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
    WHERE email IS NOT NULL;
  `);

  for (const category of categories) {
    await query(
      `
        INSERT INTO categories (slug, name)
        VALUES ($1, $2)
        ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name;
      `,
      [category.slug, category.name]
    );
  }

  const boxTypesCountResult = await query(
    `SELECT COUNT(*)::int AS count FROM box_types;`
  );
  const boxTypesCount = Number(boxTypesCountResult.rows[0]?.count ?? 0);
  if (boxTypesCount === 0) {
    await query(
      `
        INSERT INTO box_types (
          id,
          name,
          length_cm,
          width_cm,
          height_cm,
          max_weight_grams,
          empty_weight_grams,
          fill_ratio,
          sort_order
        )
        VALUES
          ('00000000-0000-0000-0000-000000000101', 'S', 20, 15, 10, 2000, 120, 0.82, 0),
          ('00000000-0000-0000-0000-000000000102', 'M', 30, 22, 14, 5000, 180, 0.82, 1),
          ('00000000-0000-0000-0000-000000000103', 'L', 40, 30, 20, 10000, 260, 0.80, 2),
          ('00000000-0000-0000-0000-000000000104', 'XL', 60, 40, 30, 20000, 420, 0.78, 3);
      `
    );
  }
};
