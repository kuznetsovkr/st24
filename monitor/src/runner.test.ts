import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSendSuccessHeartbeat } from './runner';
import type { CheckResult } from './types';

const result = (
  id: string,
  status: CheckResult['status'],
  critical = true
): CheckResult => ({
  id,
  label: id,
  status,
  critical,
  detail: 'safe test detail',
  checkedAt: '2026-08-18T00:00:00.000Z'
});

test('success heartbeat is suppressed only when the critical notifier check failed', () => {
  assert.equal(shouldSendSuccessHeartbeat([result('homepage', 'failed')]), true);
  assert.equal(shouldSendSuccessHeartbeat([result('telegram-notifier', 'warning')]), true);
  assert.equal(shouldSendSuccessHeartbeat([result('telegram-notifier', 'failed', false)]), true);
  assert.equal(shouldSendSuccessHeartbeat([result('telegram-notifier', 'failed')]), false);
});
