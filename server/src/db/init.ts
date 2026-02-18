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
    ADD COLUMN IF NOT EXISTS stock INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;
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
};
