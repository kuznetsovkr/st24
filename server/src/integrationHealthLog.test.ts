import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntegrationHealthLogger } from './integrationHealthLog';
import { summarizeIntegrations, type IntegrationCheck } from './integrationHealth';

const stamp = '2026-10-31T05:00:00.000Z';
const check = (status: IntegrationCheck['status'], code: string): IntegrationCheck => ({
  status, code, checkedAt: stamp, latencyMs: 15, coverage: 'connectivity'
});

test('health logger records changes, rate-limits ongoing failures and does not repeat unchanged healthy samples', () => {
  let now = 0; const lines: string[] = [];
  const log = createIntegrationHealthLogger({ now: () => now, write: (s) => { lines.push(s); } });
  const good = summarizeIntegrations({ turnstile: check('unverified', 'api_reachable_browser_verification_required') }, stamp, 15);
  const bad = summarizeIntegrations({ turnstile: check('error', 'timeout') }, stamp, 6000);
  log(good); log(good); assert.equal(lines.length, 1);
  log(bad); log(bad); assert.equal(lines.length, 2);
  now = 899_999; log(bad); assert.equal(lines.length, 2);
  now++; log(bad); assert.equal(lines.length, 3);
  log(good); assert.equal(lines.length, 4);
  now += 9_000_000; log(good); assert.equal(lines.length, 4);
  assert.equal(JSON.parse(lines[1]).checks.turnstile.code, 'timeout');
});

test('health log allowlists reject secret-bearing codes, timestamps, unknown IDs and extra properties', () => {
  const lines: string[] = [];
  const log = createIntegrationHealthLogger({ write: (s) => { lines.push(s); } });
  const report = summarizeIntegrations({ turnstile: { ...check('error', 'PRIVATE_SECRET'), checkedAt: 'PRIVATE_TIMESTAMP' },
    PRIVATE_PROVIDER: check('error', 'timeout') }, 'PRIVATE_TIMESTAMP', NaN);
  log({ ...report, privateToken: 'PRIVATE_TOKEN' } as typeof report);
  assert.equal(lines.length, 1); assert.ok(!lines[0].includes('PRIVATE_'));
  assert.equal(JSON.parse(lines[0]).checks.turnstile.code, 'unknown');
});

test('a broken log sink cannot break health checks', () => {
  const log = createIntegrationHealthLogger({ write: () => { throw new Error('PRIVATE_LOG_FAILURE'); } });
  assert.doesNotThrow(() => log(summarizeIntegrations({ turnstile: check('error', 'timeout') }, stamp, 1)));
});
