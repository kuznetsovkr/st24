import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPostgresCommand } from '../postgres-command.mjs';

const require = createRequire(import.meta.url);

const assertSafeTarget = () => {
  if (process.env.POSTGRES_SMOKE_ALLOW !== '1') {
    throw new Error('POSTGRES_SMOKE_ALLOW=1 is required');
  }
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');

  const url = new URL(raw);
  const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !localHosts.has(url.hostname) ||
    !url.pathname.endsWith('_smoke')
  ) {
    throw new Error('PostgreSQL smoke requires a local *_smoke database');
  }
};

assertSafeTarget();
const schemaOnly = process.argv.length === 3 && process.argv[2] === '--schema-only';
if (process.argv.length > 2 && !schemaOnly) {
  throw new Error('usage: postgres-smoke.mjs [--schema-only]');
}

const db = require('../../server/dist/db.js');
const { initDb } = require('../../server/dist/db/init.js');
const orders = require('../../server/dist/db/orders.js');
const outbox = require('../../server/dist/db/telegramOutbox.js');

const scalar = async (sql, params = []) => {
  const result = await db.query(sql, params);
  return result.rows[0];
};

const verifyBackupRestore = async (orderId) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'her-postgres-restore-'));
  const databaseName = `her_restore_${randomUUID().replaceAll('-', '')}_smoke`;
  const originalUrl = process.env.DATABASE_URL;
  const restored = new URL(originalUrl);
  restored.pathname = `/${databaseName}`;
  let created = false;
  try {
    runPostgresCommand('pg_dump', ['--no-password', '--format=custom',
      `--file=${path.join(directory, 'backup.dump')}`], originalUrl);
    runPostgresCommand('createdb', ['--no-password', databaseName], originalUrl);
    created = true;
    runPostgresCommand('pg_restore', ['--no-password', '--exit-on-error', '--no-owner', '--no-privileges',
      path.join(directory, 'backup.dump')], restored.toString());
    // Assert actual restored rows before initDb could create an empty schema.
    const { Client } = require('pg');
    const client = new Client({ connectionString: restored.toString() });
    await client.connect();
    try {
      const row = await client.query('SELECT status FROM orders WHERE id = $1', [orderId]);
      assert.equal(row.rows[0]?.status, 'paid', 'backup must restore the paid order');
    } finally {
      await client.end();
    }
    const result = spawnSync(process.execPath, ['-e', `
      const {initDb} = require('./server/dist/db/init');
      const {closeDatabasePools} = require('./server/dist/db');
      (async () => { try { await initDb(); await initDb(); }
      finally { await closeDatabasePools(); } })().catch(() => {process.exitCode=1});
    `], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      env: { ...process.env, DATABASE_URL: restored.toString(), DOTENV_CONFIG_PATH: '' },
      stdio: 'inherit', timeout: 120_000
    });
    assert.equal(result.status, 0, 'restored database initialization must be idempotent');
  } finally {
    if (created) runPostgresCommand('dropdb', ['--no-password', '--if-exists', databaseName], originalUrl);
    await rm(directory, { recursive: true, force: true });
  }
};

const main = async () => {
  const existing = await scalar(
    `SELECT to_regclass('public.application_schema_migrations') AS table_name;`
  );
  assert.equal(existing.table_name, null, 'smoke database must start empty');

  await initDb();
  await initDb();

  const schema = await scalar(`
    SELECT
      to_regclass('public.telegram_outbox_events') IS NOT NULL AS has_outbox,
      to_regclass('public.order_stock_reservation_events') IS NOT NULL AS has_stock_audit,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'telegram_update_state'
          AND column_name = 'update_offset'
      ) AS has_update_offset;
  `);
  assert.deepEqual(schema, {
    has_outbox: true,
    has_stock_audit: true,
    has_update_offset: true
  });

  const userId = randomUUID();
  const productId = randomUUID();
  const orderId = randomUUID();
  await db.query(
    `INSERT INTO users (id, phone, role, email, full_name)
     VALUES ($1, '+79990000001', 'client', 'ci-smoke@example.test', 'CI Smoke');`,
    [userId]
  );
  await db.query(
    `INSERT INTO products (
       id, name, sku, sku_normalized, price_cents, category_slug, stock
     )
     SELECT $1, 'CI smoke product', $2, $2, 10000, slug, 2
     FROM categories
     ORDER BY slug
     LIMIT 1;`,
    [productId, `CI-${productId.slice(0, 8)}`]
  );
  await db.query(
    `INSERT INTO orders (
       id, user_id, status, full_name, phone, email, total_cents,
       cart_reconciled_at
     )
     VALUES (
       $1, $2, 'pending', 'CI Smoke', '+79990000001',
       'ci-smoke@example.test', 10000, NOW()
     );`,
    [orderId, userId]
  );
  await db.query(
    `INSERT INTO order_items (order_id, product_id, name, price_cents, quantity)
     VALUES ($1, $2, 'CI smoke product', 10000, 1);`,
    [orderId, productId]
  );

  const first = await orders.reserveOrderPaymentCreation(orderId, userId);
  assert.equal(first?.state, 'create');
  assert.equal(
    Number((await scalar('SELECT stock FROM products WHERE id = $1;', [productId])).stock),
    1
  );

  const repeated = await orders.reserveOrderPaymentCreation(orderId, userId);
  assert.equal(repeated?.state, 'create');
  assert.equal(repeated?.idempotencyKey, first.idempotencyKey);
  assert.equal(
    Number((await scalar('SELECT stock FROM products WHERE id = $1;', [productId])).stock),
    1
  );

  await orders.completeOrderPaymentCreation(orderId, first.idempotencyKey, {
    provider: 'yookassa',
    paymentId: 'ci-canceled-payment',
    paymentStatus: 'canceled'
  });
  assert.equal(
    Number((await scalar('SELECT stock FROM products WHERE id = $1;', [productId])).stock),
    2
  );

  const second = await orders.reserveOrderPaymentCreation(orderId, userId);
  assert.equal(second?.state, 'create');
  await orders.completeOrderPaymentCreation(orderId, second.idempotencyKey, {
    provider: 'yookassa',
    paymentId: 'ci-succeeded-payment',
    paymentStatus: 'pending'
  });
  const paid = await orders.markOrderPaidById(orderId, {
    provider: 'yookassa',
    paymentId: 'ci-succeeded-payment'
  });
  assert.equal(paid?.status, 'paid');
  assert.equal(paid?.stock_reservation_status, 'consumed');
  assert.equal(
    Number((await scalar('SELECT stock FROM products WHERE id = $1;', [productId])).stock),
    1
  );

  const eventCount = await scalar(
    `SELECT COUNT(*)::int AS count
     FROM telegram_outbox_events
     WHERE event_type = 'order_paid' AND aggregate_id = $1;`,
    [orderId]
  );
  assert.equal(eventCount.count, 1);

  const firstBotKey = 'a'.repeat(32);
  const secondBotKey = 'b'.repeat(32);
  await outbox.saveTelegramUpdateOffset('main', firstBotKey, 5);
  await outbox.saveTelegramUpdateOffset('main', firstBotKey, 3);
  assert.equal(
    (await outbox.loadTelegramUpdateCursor('main', firstBotKey)).offset,
    5
  );
  assert.equal(
    (await outbox.loadTelegramUpdateCursor('main', secondBotKey)).offset,
    0
  );

  if (!schemaOnly) await verifyBackupRestore(orderId);
  process.stdout.write(schemaOnly
    ? 'PostgreSQL fresh/idempotent/transaction smoke passed (restore not requested).\n'
    : 'PostgreSQL fresh/idempotent/transaction/restore smoke passed.\n');
};

main()
  .catch((error) => {
    process.stderr.write(
      `PostgreSQL smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.closeDatabasePools();
  });
