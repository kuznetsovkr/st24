import { categories } from '../data/categories';
import { query } from '../db';

export const initDb = async () => {
  await query(`
    CREATE TABLE IF NOT EXISTS categories (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS image TEXT;
  `);

  await query(`
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await query(`
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
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
    DO $$
    DECLARE
      has_cascade_fk BOOLEAN := FALSE;
      rec RECORD;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'products'
          AND c.contype = 'f'
          AND c.conname = 'products_category_slug_fkey'
          AND c.confupdtype = 'c'
      )
      INTO has_cascade_fk;

      IF has_cascade_fk THEN
        RETURN;
      END IF;

      FOR rec IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN unnest(c.conkey) AS colnum(attnum) ON true
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = colnum.attnum
        WHERE n.nspname = 'public'
          AND t.relname = 'products'
          AND c.contype = 'f'
          AND a.attname = 'category_slug'
      LOOP
        EXECUTE format('ALTER TABLE public.products DROP CONSTRAINT %I', rec.conname);
      END LOOP;

      ALTER TABLE public.products
      ADD CONSTRAINT products_category_slug_fkey
      FOREIGN KEY (category_slug) REFERENCES public.categories(slug)
      ON UPDATE CASCADE
      ON DELETE RESTRICT;
    END $$;
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
    CREATE TABLE IF NOT EXISTS delivery_providers (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS site_banners (
      key TEXT PRIMARY KEY,
      desktop_image TEXT,
      mobile_image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS catalog_page_settings (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE delivery_providers
    ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE;
  `);

  await query(`
    ALTER TABLE delivery_providers
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE site_banners
    ADD COLUMN IF NOT EXISTS desktop_image TEXT;
  `);

  await query(`
    ALTER TABLE site_banners
    ADD COLUMN IF NOT EXISTS mobile_image TEXT;
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
      delivery_channel TEXT,
      provider_request_id TEXT,
      provider_message_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS delivery_channel TEXT;
  `);

  await query(`
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS provider_request_id TEXT;
  `);

  await query(`
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS provider_message_id TEXT;
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
      payment_provider TEXT,
      payment_id TEXT,
      payment_status TEXT,
      payment_confirmed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS delivery_cost_cents INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_provider TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_id TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_status TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_confirmed_at TIMESTAMPTZ;
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
  await query(`CREATE INDEX IF NOT EXISTS delivery_providers_sort_idx ON delivery_providers (sort_order);`);
  await query(`CREATE INDEX IF NOT EXISTS cart_items_user_idx ON cart_items (user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS orders_payment_id_idx ON orders (payment_id);`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
    WHERE email IS NOT NULL;
  `);

  for (const category of categories) {
    await query(
      `
        INSERT INTO categories (slug, name, image)
        VALUES ($1, $2, $3)
        ON CONFLICT (slug) DO NOTHING;
      `,
      [category.slug, category.name, category.image ?? null]
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

  await query(`
    INSERT INTO delivery_providers (key, name, is_enabled, sort_order)
    VALUES
      ('cdek', 'СДЭК', TRUE, 0),
      ('dellin', 'Деловые линии', FALSE, 1),
      ('russian_post', 'Почта России', FALSE, 2)
    ON CONFLICT (key) DO UPDATE
    SET name = EXCLUDED.name,
        sort_order = EXCLUDED.sort_order;
  `);

  await query(`
    INSERT INTO site_banners (key)
    VALUES ('home')
    ON CONFLICT (key) DO NOTHING;
  `);

  await query(`
    INSERT INTO catalog_page_settings (key, name)
    VALUES ('catalog', 'Разделы каталога')
    ON CONFLICT (key) DO NOTHING;
  `);
};
