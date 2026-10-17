import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBackupDatabaseUrl } from './read-database-url.mjs';

test('reads literal unquoted and quoted dotenv URLs without evaluating shell syntax', () => {
  const url = 'postgresql://app:p%40ss@127.0.0.1:5432/shop';
  for (const text of [`DATABASE_URL=${url}`, `DATABASE_URL='${url}' # comment`,
    `export DATABASE_URL = "${url}"\r\nOTHER=value`]) {
    assert.equal(parseBackupDatabaseUrl(text), url);
  }
});

test('last DATABASE_URL assignment wins, like dotenv', () => {
  assert.equal(parseBackupDatabaseUrl('DATABASE_URL=postgres://old@localhost/old\nDATABASE_URL=postgres://app@localhost/shop'),
    'postgres://app@localhost/shop');
});

test('does not execute shell substitutions or accept multiline/empty/malformed values', () => {
  for (const contents of ['', 'DATABASE_URL=', 'DATABASE_URL=$(id)',
    'DATABASE_URL="postgres://app@localhost/shop"; touch /tmp/unwanted',
    'DATABASE_URL="postgres://app@localhost/\nshop"', 'DATABASE_URL=https://app@localhost/shop']) {
    assert.throws(() => parseBackupDatabaseUrl(contents));
  }
});

test('invalid credential-bearing values are never included in error messages', () => {
  const secret = 'never-show-this-password';
  assert.throws(() => parseBackupDatabaseUrl(`DATABASE_URL=https://app:${secret}@localhost/shop`),
    (error) => !error.message.includes(secret));
});
