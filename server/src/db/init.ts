import { categories } from '../data/categories';
import { query } from '../db';
import { getTelegramOutboxMaxRetryAgeDays } from '../telegramOutboxConfig';

export const initDb = async () => {
  const telegramOutboxMaxRetryAgeDays =
    getTelegramOutboxMaxRetryAgeDays();
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
      sku_normalized TEXT,
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
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sku_normalized TEXT;
  `);

  await query(`
    CREATE OR REPLACE FUNCTION products_normalize_sku_fn()
    RETURNS TRIGGER
    AS $$
    BEGIN
      NEW.sku_normalized := regexp_replace(lower(COALESCE(NEW.sku, '')), '[^[:alnum:]]+', '', 'g');
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await query(`
    DROP TRIGGER IF EXISTS products_normalize_sku_trigger ON products;
  `);

  await query(`
    CREATE TRIGGER products_normalize_sku_trigger
    BEFORE INSERT OR UPDATE OF sku
    ON products
    FOR EACH ROW
    EXECUTE FUNCTION products_normalize_sku_fn();
  `);

  await query(`
    UPDATE products
    SET sku_normalized = regexp_replace(lower(sku), '[^[:alnum:]]+', '', 'g')
    WHERE sku_normalized IS NULL;
  `);

  await query(`
    ALTER TABLE products
    ALTER COLUMN sku_normalized SET NOT NULL;
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
    CREATE TABLE IF NOT EXISTS security_events (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      ip_hash TEXT,
      phone_masked TEXT,
      email_masked TEXT,
      reason TEXT NOT NULL,
      route TEXT NOT NULL,
      method TEXT NOT NULL,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS order_lifecycle_events (
      id UUID PRIMARY KEY,
      event_type TEXT NOT NULL,
      order_id UUID,
      order_number TEXT,
      payment_id TEXT,
      old_status TEXT,
      new_status TEXT,
      amount_cents INTEGER,
      provider TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_audit_events (
      id UUID PRIMARY KEY,
      actor_user_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      action TEXT NOT NULL,
      before_json JSONB,
      after_json JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS integration_events (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      operation TEXT NOT NULL,
      attempt INTEGER,
      status_code INTEGER,
      latency_ms INTEGER,
      fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS error_events (
      id UUID PRIMARY KEY,
      error_class TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      request_id TEXT,
      route TEXT NOT NULL,
      user_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS phone_code_delivery_events (
      id UUID PRIMARY KEY,
      phone TEXT NOT NULL,
      channel TEXT NOT NULL,
      context TEXT NOT NULL,
      status TEXT NOT NULL,
      preferred_channel TEXT,
      fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
      provider_request_id TEXT,
      provider_message_id TEXT,
      error TEXT,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS phone_code_delivery_stats (
      phone TEXT PRIMARY KEY,
      telegram_sent_count INTEGER NOT NULL DEFAULT 0,
      sms_sent_count INTEGER NOT NULL DEFAULT 0,
      last_action TEXT NOT NULL,
      last_channel TEXT,
      last_context TEXT,
      last_event_status TEXT,
      last_event_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS lead_requests (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      full_name TEXT,
      phone TEXT,
      email TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      telegram_status TEXT NOT NULL DEFAULT 'pending',
      telegram_error TEXT,
      telegram_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS auth_codes (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      delivery_channel TEXT,
      provider_request_id TEXT,
      provider_message_id TEXT,
      call_check_status TEXT,
      call_check_status_text TEXT,
      call_verified_at TIMESTAMPTZ,
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
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS call_check_status TEXT;
  `);

  await query(`
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS call_check_status_text TEXT;
  `);

  await query(`
    ALTER TABLE auth_codes
    ADD COLUMN IF NOT EXISTS call_verified_at TIMESTAMPTZ;
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
      payment_idempotency_key TEXT,
      payment_creation_started_at TIMESTAMPTZ,
      payment_status TEXT,
      payment_confirmed_at TIMESTAMPTZ,
      payment_anomaly_code TEXT,
      payment_anomaly_at TIMESTAMPTZ,
      stock_reservation_status TEXT,
      stock_reservation_attempt_key TEXT,
      stock_reserved_at TIMESTAMPTZ,
      stock_reservation_consumed_at TIMESTAMPTZ,
      stock_reservation_released_at TIMESTAMPTZ,
      stock_reservation_reason TEXT,
      cart_reconciled_at TIMESTAMPTZ,
      privacy_consent_at TIMESTAMPTZ,
      privacy_policy_version TEXT,
      privacy_consent_source TEXT,
      privacy_consent_ip TEXT,
      privacy_consent_user_agent TEXT,
      telegram_notification_required_at TIMESTAMPTZ,
      telegram_notified_at TIMESTAMPTZ,
      telegram_notification_exempted_at TIMESTAMPTZ,
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
    ADD COLUMN IF NOT EXISTS payment_idempotency_key TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_creation_started_at TIMESTAMPTZ;
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
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_anomaly_code TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS payment_anomaly_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reservation_status TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reservation_attempt_key TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reserved_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reservation_consumed_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reservation_released_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS stock_reservation_reason TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS cart_reconciled_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS privacy_consent_source TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS privacy_consent_ip TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS privacy_consent_user_agent TEXT;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS telegram_notification_required_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS telegram_notified_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS telegram_notification_exempted_at TIMESTAMPTZ;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS application_schema_migrations (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    WITH applied AS (
      INSERT INTO application_schema_migrations (migration_key)
      VALUES ('telegram_outbox_paid_baseline_v1')
      ON CONFLICT (migration_key) DO NOTHING
      RETURNING applied_at
    )
    UPDATE orders
    SET telegram_notification_exempted_at = applied.applied_at,
        updated_at = NOW()
    FROM applied
    WHERE orders.status = 'paid'
      AND orders.telegram_notification_required_at IS NULL
      AND orders.telegram_notified_at IS NULL
      AND orders.telegram_notification_exempted_at IS NULL;
  `);

  await query(`
    WITH applied AS (
      INSERT INTO application_schema_migrations (migration_key)
      VALUES ('order_cart_reconciliation_baseline_v1')
      ON CONFLICT (migration_key) DO NOTHING
      RETURNING applied_at
    )
    UPDATE orders
    SET cart_reconciled_at = applied.applied_at,
        updated_at = NOW()
    FROM applied
    WHERE orders.cart_reconciled_at IS NULL;
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
    CREATE TABLE IF NOT EXISTS order_stock_reservation_events (
      id UUID PRIMARY KEY,
      order_id UUID NOT NULL,
      attempt_key TEXT NOT NULL,
      event_type TEXT NOT NULL
        CHECK (event_type IN ('reserved', 'consumed', 'released', 'baseline')),
      previous_status TEXT
        CHECK (
          previous_status IS NULL
          OR previous_status IN ('reserved', 'consumed', 'released')
        ),
      new_status TEXT NOT NULL
        CHECK (new_status IN ('reserved', 'consumed', 'released')),
      reason TEXT NOT NULL CHECK (
        reason IN (
          'payment_creation',
          'payment_canceled',
          'payment_succeeded',
          'manual_payment',
          'legacy_paid_baseline'
        )
      ),
      items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    CREATE OR REPLACE FUNCTION reject_order_stock_reservation_event_mutation()
    RETURNS TRIGGER AS $function$
    BEGIN
      RAISE EXCEPTION 'order stock reservation events are immutable';
    END
    $function$ LANGUAGE plpgsql;
  `);

  await query(`
    DO $trigger$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext('order_stock_reservation_events_immutable_trigger_v1')
      );
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'order_stock_reservation_events_immutable'
          AND tgrelid = 'order_stock_reservation_events'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER order_stock_reservation_events_immutable
        BEFORE UPDATE OR DELETE ON order_stock_reservation_events
        FOR EACH ROW
        EXECUTE FUNCTION reject_order_stock_reservation_event_mutation();
      END IF;
    END
    $trigger$;
  `);

  await query(`
    DO $migration$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext('stock_reservation_paid_baseline_v1'));
      IF NOT EXISTS (
        SELECT 1
        FROM application_schema_migrations
        WHERE migration_key = 'stock_reservation_paid_baseline_v1'
      ) THEN
        WITH transitioned AS (
          UPDATE orders
          SET stock_reservation_status = 'consumed',
              stock_reservation_attempt_key = COALESCE(
                payment_idempotency_key,
                'baseline:' || id::text
              ),
              stock_reserved_at = COALESCE(
                payment_confirmed_at,
                updated_at,
                created_at,
                NOW()
              ),
              stock_reservation_consumed_at = COALESCE(
                payment_confirmed_at,
                updated_at,
                created_at,
                NOW()
              ),
              stock_reservation_released_at = NULL,
              stock_reservation_reason = 'legacy_paid_baseline'
          WHERE status = 'paid'
            AND stock_reservation_status IS NULL
          RETURNING id, stock_reservation_attempt_key
        )
        INSERT INTO order_stock_reservation_events (
          id,
          order_id,
          attempt_key,
          event_type,
          previous_status,
          new_status,
          reason,
          items
        )
        SELECT
          md5('stock-reservation-paid-baseline-v1:' || transitioned.id::text)::uuid,
          transitioned.id,
          transitioned.stock_reservation_attempt_key,
          'baseline',
          NULL,
          'consumed',
          'legacy_paid_baseline',
          COALESCE(
            (
              SELECT jsonb_agg(
                jsonb_build_object(
                  'productId', order_items.product_id::text,
                  'quantity', order_items.quantity
                )
                ORDER BY order_items.product_id
              )
              FROM order_items
              WHERE order_items.order_id = transitioned.id
            ),
            '[]'::jsonb
          )
        FROM transitioned
        ON CONFLICT (id) DO NOTHING;

        INSERT INTO application_schema_migrations (migration_key)
        VALUES ('stock_reservation_paid_baseline_v1')
        ON CONFLICT (migration_key) DO NOTHING;
      END IF;
    END
    $migration$;
  `);

  await query(`
    ALTER TABLE orders
    DROP CONSTRAINT IF EXISTS orders_stock_reservation_state_check;
    ALTER TABLE orders
    ADD CONSTRAINT orders_stock_reservation_state_check
    CHECK (
      (
        stock_reservation_status IS NULL
        AND stock_reservation_attempt_key IS NULL
        AND stock_reserved_at IS NULL
        AND stock_reservation_consumed_at IS NULL
        AND stock_reservation_released_at IS NULL
        AND stock_reservation_reason IS NULL
      )
      OR (
        stock_reservation_status = 'reserved'
        AND stock_reservation_attempt_key IS NOT NULL
        AND stock_reserved_at IS NOT NULL
        AND stock_reservation_consumed_at IS NULL
        AND stock_reservation_released_at IS NULL
        AND stock_reservation_reason IS NOT NULL
      )
      OR (
        stock_reservation_status = 'consumed'
        AND stock_reservation_attempt_key IS NOT NULL
        AND stock_reserved_at IS NOT NULL
        AND stock_reservation_consumed_at IS NOT NULL
        AND stock_reservation_released_at IS NULL
        AND stock_reservation_reason IS NOT NULL
      )
      OR (
        stock_reservation_status = 'released'
        AND stock_reservation_attempt_key IS NOT NULL
        AND stock_reserved_at IS NOT NULL
        AND stock_reservation_consumed_at IS NULL
        AND stock_reservation_released_at IS NOT NULL
        AND stock_reservation_reason IS NOT NULL
      )
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS payment_anomalies (
      id BIGSERIAL PRIMARY KEY,
      provider TEXT NOT NULL,
      external_payment_id TEXT NOT NULL,
      anomaly_code TEXT NOT NULL,
      payment_status TEXT,
      amount_cents INTEGER,
      metadata_order_id UUID,
      linked_order_id UUID,
      resolved_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      seen_count INTEGER NOT NULL DEFAULT 1 CHECK (seen_count > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (provider, external_payment_id),
      CHECK (amount_cents IS NULL OR amount_cents >= 0)
    );
  `);

  await query(`
    ALTER TABLE payment_anomalies
    ADD COLUMN IF NOT EXISTS metadata_order_id UUID;
  `);

  await query(`
    ALTER TABLE payment_anomalies
    ADD COLUMN IF NOT EXISTS linked_order_id UUID;
  `);

  await query(`
    ALTER TABLE payment_anomalies
    ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  await query(`
    ALTER TABLE payment_anomalies
    ADD COLUMN IF NOT EXISTS seen_count INTEGER NOT NULL DEFAULT 1;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS payment_anomaly_resolutions (
      id BIGSERIAL PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('order', 'provider_payment')),
      order_id UUID,
      provider_payment_anomaly_id BIGINT
        REFERENCES payment_anomalies(id) ON DELETE RESTRICT,
      original_anomaly_code TEXT NOT NULL,
      external_payment_id TEXT,
      resolved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      resolved_by TEXT NOT NULL
        CHECK (char_length(resolved_by) BETWEEN 1 AND 256),
      source TEXT NOT NULL CHECK (source = 'cli'),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
      CHECK (
        (scope = 'order' AND order_id IS NOT NULL
          AND provider_payment_anomaly_id IS NULL)
        OR
        (scope = 'provider_payment' AND order_id IS NULL
          AND provider_payment_anomaly_id IS NOT NULL)
      )
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
    CREATE TABLE IF NOT EXISTS telegram_outbox_events (
      id UUID PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL CHECK (event_type IN ('order_paid', 'lead_created')),
      bot_kind TEXT NOT NULL CHECK (bot_kind IN ('main', 'orders', 'b2b')),
      aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('order', 'lead')),
      aggregate_id UUID NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 1 CHECK (payload_version > 0),
      payload JSONB NOT NULL,
      payload_scrubbed_at TIMESTAMPTZ,
      attachment_count INTEGER NOT NULL DEFAULT 0 CHECK (attachment_count >= 0),
      attachments_expired_at TIMESTAMPTZ,
      retry_expires_at TIMESTAMPTZ NOT NULL DEFAULT (
        NOW() + INTERVAL '${telegramOutboxMaxRetryAgeDays} days'
      ),
      deliveries_expired_at TIMESTAMPTZ,
      terminal_delivery_count INTEGER CHECK (terminal_delivery_count >= 0),
      terminal_sent_part_count INTEGER CHECK (terminal_sent_part_count >= 0),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      lease_owner TEXT,
      lease_until TIMESTAMPTZ,
      target_count INTEGER NOT NULL DEFAULT 0 CHECK (target_count >= 0),
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN (
          'no_targets',
          'config_missing',
          'timeout',
          'network_error',
          'proxy_error',
          'telegram_api_error',
          'telegram_auth_error',
          'telegram_rate_limited',
          'telegram_chat_blocked',
          'telegram_chat_not_found',
          'subscriber_inactive',
          'invalid_payload',
          'attachment_missing',
          'retry_window_expired',
          'lease_lost',
          'max_attempts',
          'unknown_error'
        )
      ),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (
        (event_type = 'order_paid' AND bot_kind = 'orders' AND aggregate_type = 'order')
        OR
        (event_type = 'lead_created' AND bot_kind IN ('main', 'b2b') AND aggregate_type = 'lead')
      ),
      CONSTRAINT telegram_outbox_events_lease_pair_check
        CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
      CONSTRAINT telegram_outbox_events_lease_state_check
        CHECK ((status = 'processing') = (lease_owner IS NOT NULL)),
      CHECK (jsonb_typeof(payload) = 'object'),
      CHECK (payload ? 'version' AND payload ? 'text'),
      CHECK ((payload->>'version') ~ '^[1-9][0-9]*$'),
      CHECK (payload_version = (payload->>'version')::integer),
      CHECK (jsonb_typeof(payload->'text') = 'string')
    );
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS payload_scrubbed_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS attachment_count INTEGER NOT NULL DEFAULT 0;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS attachments_expired_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS retry_expires_at TIMESTAMPTZ;
  `);

  await query(
    `
      UPDATE telegram_outbox_events
      SET retry_expires_at =
            created_at + ($1::int * INTERVAL '1 day')
      WHERE retry_expires_at IS NULL;
    `,
    [telegramOutboxMaxRetryAgeDays]
  );

  await query(`
    ALTER TABLE telegram_outbox_events
    ALTER COLUMN retry_expires_at SET NOT NULL;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ALTER COLUMN retry_expires_at
    SET DEFAULT (
      NOW() + INTERVAL '${telegramOutboxMaxRetryAgeDays} days'
    );
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS deliveries_expired_at TIMESTAMPTZ;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS terminal_delivery_count INTEGER;
  `);

  await query(`
    ALTER TABLE telegram_outbox_events
    ADD COLUMN IF NOT EXISTS terminal_sent_part_count INTEGER;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_outbox_attachments (
      id UUID PRIMARY KEY,
      event_id UUID NOT NULL REFERENCES telegram_outbox_events(id) ON DELETE CASCADE,
      part_no INTEGER NOT NULL CHECK (part_no >= 1),
      file_name TEXT NOT NULL CHECK (char_length(file_name) BETWEEN 1 AND 255),
      mime_type TEXT NOT NULL CHECK (char_length(mime_type) BETWEEN 1 AND 127),
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      bytes BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (event_id, part_no),
      CHECK (octet_length(bytes) = size_bytes)
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_outbox_deliveries (
      event_id UUID NOT NULL REFERENCES telegram_outbox_events(id) ON DELETE CASCADE,
      chat_id BIGINT NOT NULL,
      part_no INTEGER NOT NULL CHECK (part_no >= 0),
      delivery_kind TEXT NOT NULL CHECK (delivery_kind IN ('text', 'document')),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sent', 'skipped', 'dead')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      telegram_message_id BIGINT,
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN (
          'no_targets',
          'config_missing',
          'timeout',
          'network_error',
          'proxy_error',
          'telegram_api_error',
          'telegram_auth_error',
          'telegram_rate_limited',
          'telegram_chat_blocked',
          'telegram_chat_not_found',
          'subscriber_inactive',
          'invalid_payload',
          'attachment_missing',
          'retry_window_expired',
          'lease_lost',
          'max_attempts',
          'unknown_error'
        )
      ),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (event_id, chat_id, part_no),
      CHECK (
        (part_no = 0 AND delivery_kind = 'text')
        OR
        (part_no >= 1 AND delivery_kind = 'document')
      )
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_outbox_acknowledgements (
      event_id UUID PRIMARY KEY
        REFERENCES telegram_outbox_events(id) ON DELETE RESTRICT,
      event_key TEXT NOT NULL,
      acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_by TEXT NOT NULL
        CHECK (char_length(acknowledged_by) BETWEEN 1 AND 256),
      source TEXT NOT NULL CHECK (source = 'cli'),
      reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 10 AND 1000),
      terminal_error_code TEXT NOT NULL,
      target_count INTEGER NOT NULL CHECK (target_count >= 0),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 0)
    );
  `);

  await query(`
    CREATE OR REPLACE FUNCTION reject_telegram_outbox_acknowledgement_mutation()
    RETURNS TRIGGER AS $function$
    BEGIN
      RAISE EXCEPTION 'Telegram outbox acknowledgements are immutable'
        USING ERRCODE = '55000';
      RETURN OLD;
    END;
    $function$ LANGUAGE plpgsql;
  `);

  await query(`
    DO $trigger$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'telegram_outbox_acknowledgements_immutable'
          AND tgrelid = 'telegram_outbox_acknowledgements'::regclass
          AND NOT tgisinternal
      ) THEN
        CREATE TRIGGER telegram_outbox_acknowledgements_immutable
        BEFORE UPDATE OR DELETE ON telegram_outbox_acknowledgements
        FOR EACH ROW
        EXECUTE FUNCTION reject_telegram_outbox_acknowledgement_mutation();
      END IF;
    END
    $trigger$;
  `);

  await query(`
    DO $migration$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext('telegram_outbox_privacy_ack_v2')
      );
      IF NOT EXISTS (
        SELECT 1
        FROM application_schema_migrations
        WHERE migration_key = 'telegram_outbox_privacy_ack_v2'
      ) THEN
        UPDATE telegram_outbox_events AS events
        SET attachment_count = stored.attachment_count
        FROM (
          SELECT event_id, COUNT(*)::int AS attachment_count
          FROM (
            SELECT event_id, part_no
            FROM telegram_outbox_attachments
            UNION
            SELECT event_id, part_no
            FROM telegram_outbox_deliveries
            WHERE delivery_kind = 'document'
          ) AS attachment_parts
          GROUP BY event_id
        ) AS stored
        WHERE events.id = stored.event_id
          AND events.attachment_count = 0
          AND stored.attachment_count > 0;

        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_attachment_count_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_attachment_count_check
          CHECK (attachment_count >= 0);

        INSERT INTO application_schema_migrations (migration_key)
        VALUES ('telegram_outbox_privacy_ack_v2')
        ON CONFLICT (migration_key) DO NOTHING;
      END IF;
    END
    $migration$;
  `);

  await query(`
    DO $migration$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext('telegram_outbox_retry_expiry_v1')
      );
      IF NOT EXISTS (
        SELECT 1
        FROM application_schema_migrations
        WHERE migration_key = 'telegram_outbox_retry_expiry_v1'
      ) THEN
        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_last_error_code_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_last_error_code_check
          CHECK (
            last_error_code IS NULL OR last_error_code IN (
              'no_targets', 'config_missing', 'timeout', 'network_error',
              'proxy_error', 'telegram_api_error', 'telegram_auth_error',
              'telegram_rate_limited', 'telegram_chat_blocked',
              'telegram_chat_not_found', 'subscriber_inactive',
              'invalid_payload', 'attachment_missing',
              'retry_window_expired', 'lease_lost', 'max_attempts',
              'unknown_error'
            )
          );
        ALTER TABLE telegram_outbox_deliveries
          DROP CONSTRAINT IF EXISTS telegram_outbox_deliveries_last_error_code_check;
        ALTER TABLE telegram_outbox_deliveries
          ADD CONSTRAINT telegram_outbox_deliveries_last_error_code_check
          CHECK (
            last_error_code IS NULL OR last_error_code IN (
              'no_targets', 'config_missing', 'timeout', 'network_error',
              'proxy_error', 'telegram_api_error', 'telegram_auth_error',
              'telegram_rate_limited', 'telegram_chat_blocked',
              'telegram_chat_not_found', 'subscriber_inactive',
              'invalid_payload', 'attachment_missing',
              'retry_window_expired', 'lease_lost', 'max_attempts',
              'unknown_error'
            )
          );
        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_terminal_delivery_count_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_terminal_delivery_count_check
          CHECK (
            terminal_delivery_count IS NULL OR terminal_delivery_count >= 0
          );
        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_terminal_sent_part_count_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_terminal_sent_part_count_check
          CHECK (
            terminal_sent_part_count IS NULL OR terminal_sent_part_count >= 0
          );
        INSERT INTO application_schema_migrations (migration_key)
        VALUES ('telegram_outbox_retry_expiry_v1')
        ON CONFLICT (migration_key) DO NOTHING;
      END IF;
    END
    $migration$;
  `);

  await query(`
    DO $migration$
    BEGIN
      PERFORM pg_advisory_xact_lock(
        hashtext('telegram_outbox_lease_state_v1')
      );
      IF NOT EXISTS (
        SELECT 1
        FROM application_schema_migrations
        WHERE migration_key = 'telegram_outbox_lease_state_v1'
      ) THEN
        UPDATE telegram_outbox_events
        SET status = 'retry',
            next_attempt_at = NOW(),
            lease_owner = NULL,
            lease_until = NULL,
            last_error_code = COALESCE(last_error_code, 'lease_lost'),
            updated_at = NOW()
        WHERE status = 'processing'
          AND (lease_owner IS NULL OR lease_until IS NULL);

        UPDATE telegram_outbox_events
        SET lease_owner = NULL,
            lease_until = NULL,
            updated_at = NOW()
        WHERE status <> 'processing'
          AND (lease_owner IS NOT NULL OR lease_until IS NOT NULL);

        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_lease_pair_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_lease_pair_check
          CHECK ((lease_owner IS NULL) = (lease_until IS NULL));
        ALTER TABLE telegram_outbox_events
          DROP CONSTRAINT IF EXISTS telegram_outbox_events_lease_state_check;
        ALTER TABLE telegram_outbox_events
          ADD CONSTRAINT telegram_outbox_events_lease_state_check
          CHECK ((status = 'processing') = (lease_owner IS NOT NULL));

        INSERT INTO application_schema_migrations (migration_key)
        VALUES ('telegram_outbox_lease_state_v1')
        ON CONFLICT (migration_key) DO NOTHING;
      END IF;
    END
    $migration$;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_update_state (
      bot_kind TEXT PRIMARY KEY CHECK (bot_kind IN ('main', 'orders', 'b2b')),
      bot_instance_key TEXT NOT NULL DEFAULT 'legacy',
      update_offset BIGINT NOT NULL DEFAULT 0 CHECK (update_offset >= 0),
      last_update_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await query(`
    ALTER TABLE telegram_update_state
    ADD COLUMN IF NOT EXISTS bot_instance_key TEXT NOT NULL DEFAULT 'legacy';
  `);

  await query(`
    ALTER TABLE telegram_update_state
    ADD COLUMN IF NOT EXISTS last_update_at TIMESTAMPTZ;
  `);

  await query(`
    UPDATE telegram_update_state
    SET last_update_at = updated_at
    WHERE update_offset > 0
      AND last_update_at IS NULL;
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS telegram_update_inbox (
      bot_kind TEXT NOT NULL CHECK (bot_kind IN ('main', 'orders', 'b2b')),
      bot_instance_key TEXT NOT NULL DEFAULT 'legacy',
      update_id BIGINT NOT NULL CHECK (update_id >= 0),
      status TEXT NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'processed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      last_error_code TEXT CHECK (
        last_error_code IS NULL OR last_error_code IN (
          'no_targets',
          'config_missing',
          'timeout',
          'network_error',
          'proxy_error',
          'telegram_api_error',
          'telegram_auth_error',
          'telegram_rate_limited',
          'telegram_chat_blocked',
          'telegram_chat_not_found',
          'subscriber_inactive',
          'invalid_payload',
          'attachment_missing',
          'lease_lost',
          'max_attempts',
          'unknown_error'
        )
      ),
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (bot_kind, update_id)
    );
  `);

  await query(`
    ALTER TABLE telegram_update_inbox
    ADD COLUMN IF NOT EXISTS bot_instance_key TEXT NOT NULL DEFAULT 'legacy';
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
  await query(`
    CREATE INDEX IF NOT EXISTS products_sku_normalized_created_idx
    ON products (sku_normalized text_pattern_ops, created_at DESC)
    WHERE is_hidden = FALSE;
  `);
  await query(`CREATE INDEX IF NOT EXISTS box_types_sort_idx ON box_types (sort_order);`);
  await query(`CREATE INDEX IF NOT EXISTS delivery_providers_sort_idx ON delivery_providers (sort_order);`);
  await query(`CREATE INDEX IF NOT EXISTS cart_items_user_idx ON cart_items (user_id);`);
  await query(`CREATE INDEX IF NOT EXISTS orders_user_idx ON orders (user_id);`);
  const duplicatePaymentIds = await query(`
    SELECT 1
    FROM orders
    WHERE payment_id IS NOT NULL
    GROUP BY payment_id
    HAVING COUNT(*) > 1
    LIMIT 1;
  `);
  if ((duplicatePaymentIds.rowCount ?? 0) > 0) {
    throw new Error('Duplicate order payment identifiers require reconciliation');
  }
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_id_unique
    ON orders (payment_id)
    WHERE payment_id IS NOT NULL;
  `);
  await query(`CREATE INDEX IF NOT EXISTS security_events_created_idx ON security_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS security_events_type_created_idx ON security_events (event_type, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS security_events_user_created_idx ON security_events (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS order_lifecycle_events_created_idx ON order_lifecycle_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS order_lifecycle_events_type_created_idx ON order_lifecycle_events (event_type, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS order_lifecycle_events_order_created_idx ON order_lifecycle_events (order_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS order_lifecycle_events_payment_created_idx ON order_lifecycle_events (payment_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx ON admin_audit_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS admin_audit_events_actor_created_idx ON admin_audit_events (actor_user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS admin_audit_events_entity_created_idx ON admin_audit_events (entity_type, entity_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS integration_events_created_idx ON integration_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS integration_events_provider_operation_idx ON integration_events (provider, operation, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS integration_events_fallback_idx ON integration_events (fallback_used, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS error_events_created_idx ON error_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS error_events_request_created_idx ON error_events (request_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS error_events_user_created_idx ON error_events (user_id, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS phone_code_delivery_events_created_idx ON phone_code_delivery_events (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS phone_code_delivery_events_phone_created_idx ON phone_code_delivery_events (phone, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS phone_code_delivery_events_channel_created_idx ON phone_code_delivery_events (channel, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS phone_code_delivery_stats_updated_idx ON phone_code_delivery_stats (updated_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS lead_requests_created_idx ON lead_requests (created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS lead_requests_kind_created_idx ON lead_requests (kind, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS lead_requests_telegram_status_created_idx ON lead_requests (telegram_status, created_at DESC);`);
  await query(`CREATE INDEX IF NOT EXISTS lead_requests_phone_created_idx ON lead_requests (phone, created_at DESC);`);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_outbox_events_claim_idx
    ON telegram_outbox_events (next_attempt_at, created_at)
    WHERE status IN ('pending', 'retry');
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_outbox_events_stale_lease_idx
    ON telegram_outbox_events (lease_until, created_at)
    WHERE status = 'processing';
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_outbox_events_expiry_idx
    ON telegram_outbox_events (retry_expires_at, created_at)
    WHERE status IN ('pending', 'processing', 'retry');
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_outbox_deliveries_due_idx
    ON telegram_outbox_deliveries (event_id, next_attempt_at)
    WHERE status = 'pending';
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_outbox_events_aggregate_idx
    ON telegram_outbox_events (aggregate_type, aggregate_id, event_type);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS orders_telegram_notification_pending_idx
    ON orders (telegram_notification_required_at)
    WHERE telegram_notification_required_at IS NOT NULL AND telegram_notified_at IS NULL;
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_payment_idempotency_key_unique
    ON orders (payment_idempotency_key)
    WHERE payment_idempotency_key IS NOT NULL;
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS orders_stock_reservation_status_idx
    ON orders (stock_reservation_status, stock_reserved_at)
    WHERE stock_reservation_status IS NOT NULL;
  `);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_stock_reservation_attempt_key_unique
    ON orders (stock_reservation_attempt_key)
    WHERE stock_reservation_attempt_key IS NOT NULL;
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS order_stock_reservation_events_order_created_idx
    ON order_stock_reservation_events (order_id, created_at DESC);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS order_stock_reservation_events_attempt_created_idx
    ON order_stock_reservation_events (attempt_key, created_at DESC);
  `);
  await query(`
    CREATE INDEX IF NOT EXISTS telegram_update_inbox_processing_idx
    ON telegram_update_inbox (updated_at)
    WHERE status = 'processing';
  `);
  await query(`CREATE INDEX IF NOT EXISTS auth_codes_provider_request_idx ON auth_codes (provider_request_id);`);
  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
    ON users (email)
    WHERE email IS NOT NULL;
  `);

  const categoriesCountResult = await query(
    `SELECT COUNT(*)::int AS count FROM categories;`
  );
  const categoriesCount = Number(categoriesCountResult.rows[0]?.count ?? 0);
  if (categoriesCount === 0) {
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
