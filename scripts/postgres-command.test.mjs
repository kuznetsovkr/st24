import assert from 'node:assert/strict';
import test from 'node:test';
import { preparePostgresCommand } from './postgres-command.mjs';

test('pg_restore always selects direct restoration into the requested database', () => {
  const command = preparePostgresCommand('pg_restore', ['--exit-on-error', 'backup.dump'],
    'postgresql://app:p%40ss@127.0.0.1:5432/restore_smoke?sslmode=require');
  assert.equal(command.password, 'p@ss');
  assert.deepEqual(command.args, ['--dbname=postgresql://app@127.0.0.1:5432/restore_smoke?sslmode=require',
    '--exit-on-error', 'backup.dump']);
  assert.ok(command.args.every((arg) => !arg.includes('p%40ss') && !arg.includes('p@ss')));
});

test('database create/drop select the explicit admin maintenance connection', () => {
  for (const tool of ['createdb', 'dropdb']) {
    const command = preparePostgresCommand(tool, ['new_smoke'], 'postgres://admin:secret@db.example/admin');
    assert.equal(command.args[0], '--maintenance-db=postgres://admin@db.example/admin');
  }
});

test('all database commands strip query passwords and reject unsupported secret parameters', () => {
  for (const tool of ['psql', 'pg_dump', 'pg_restore', 'createdb', 'dropdb']) {
    const command = preparePostgresCommand(tool, [], 'postgres://app:old@db/app?password=final-secret');
    assert.equal(command.password, 'final-secret');
    assert.ok(!command.args.join(' ').includes('secret'));
    assert.ok(!command.args.join(' ').includes('password='));
  }
  assert.throws(() => preparePostgresCommand('pg_restore', [], 'postgres://db/app?sslpassword=secret'));
  assert.throws(() => preparePostgresCommand('sh', [], 'postgres://db/app'));
  assert.throws(() => preparePostgresCommand('pg_restore', ['--dbname=production'], 'postgres://db/app'));
});
