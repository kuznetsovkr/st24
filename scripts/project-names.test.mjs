import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const json = name => JSON.parse(readFileSync(new URL(name, root), 'utf8'));

test('package and lockfile names agree on the canonical workspace identity', () => {
  const lock = json('package-lock.json');
  assert.equal(json('package.json').name, 'karcher');
  assert.equal(lock.name, 'karcher');
  assert.equal(lock.packages[''].name, 'karcher');
  assert.equal(json('monitor/package.json').name, 'karcher-external-monitor');
  assert.equal(lock.packages.monitor.name, 'karcher-external-monitor');
  assert.equal(lock.packages['node_modules/karcher-external-monitor'].resolved, 'monitor');
  assert.ok(!lock.packages['node_modules/her-external-monitor']);
});

test('current service files and CI/deployer instructions contain no legacy names', () => {
  for (const folder of ['ops/systemd/', 'ops/tmpfiles/', 'ops/logrotate/']) {
    const names = readdirSync(fileURLToPath(new URL(folder, root)));
    assert.ok(names.every(name => !name.startsWith('her-')));
    assert.ok(names.some(name => name.startsWith('karcher-')));
  }
  for (const name of ['deploy.sh', '.github/workflows/ci.yml', 'ops/README.md',
    'ops/validate-units.mjs', 'docs/monitoring.md', 'README.md']) {
    const source = readFileSync(new URL(name, root), 'utf8');
    assert.doesNotMatch(source, /(?<![A-Za-z0-9])her(?![A-Za-z0-9])/i, name);
  }
});
