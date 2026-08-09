import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advanceState,
  emptyState,
  InvalidMonitorStateError,
  loadState,
  saveState,
  type MonitorState
} from './state';
import type { CheckResult, CheckStatus } from './types';
import { renderTransitionReport } from './report';

const check = (status: CheckStatus, checkedAt: string): CheckResult => ({
  id: 'homepage',
  label: 'Homepage',
  status,
  critical: true,
  detail: status,
  checkedAt
});

test('failure alert is emitted only after the configured consecutive threshold', () => {
  const first = advanceState(emptyState(), [check('failed', '2026-08-08T00:00:00Z')], 2, 1);
  assert.equal(first.transitions.length, 0);
  assert.equal(first.state.checks.homepage?.consecutiveFailures, 1);

  const second = advanceState(first.state, [check('failed', '2026-08-08T00:01:00Z')], 2, 1);
  assert.deepEqual(second.transitions.map((item) => item.type), ['failure']);
  assert.equal(second.state.checks.homepage?.alerting, true);

  const third = advanceState(second.state, [check('failed', '2026-08-08T00:02:00Z')], 2, 1);
  assert.equal(third.transitions.length, 0);
});

test('recovery is emitted once after an alerting check becomes healthy', () => {
  const alertingState: MonitorState = {
    version: 1,
    checks: {
      homepage: {
        alerting: true,
        consecutiveFailures: 3,
        consecutiveSuccesses: 0,
        lastStatus: 'failed',
        updatedAt: '2026-08-08T00:00:00Z'
      }
    }
  };
  const recovered = advanceState(alertingState, [check('ok', '2026-08-08T00:01:00Z')], 2, 1);
  assert.deepEqual(recovered.transitions.map((item) => item.type), ['recovery']);
  assert.equal(recovered.state.checks.homepage?.alerting, false);

  const stillHealthy = advanceState(recovered.state, [check('ok', '2026-08-08T00:02:00Z')], 2, 1);
  assert.equal(stillHealthy.transitions.length, 0);
});

test('a healthy sample resets an unconfirmed failure streak', () => {
  const first = advanceState(emptyState(), [check('failed', '2026-08-08T00:00:00Z')], 2, 1);
  const healthy = advanceState(first.state, [check('ok', '2026-08-08T00:01:00Z')], 2, 1);
  const nextFailure = advanceState(healthy.state, [check('failed', '2026-08-08T00:02:00Z')], 2, 1);

  assert.equal(nextFailure.transitions.length, 0);
  assert.equal(nextFailure.state.checks.homepage?.consecutiveFailures, 1);
});

test('a repeated warning alerts and only a healthy sample recovers it', () => {
  const first = advanceState(emptyState(), [check('warning', '2026-08-08T00:00:00Z')], 2, 1);
  const alerting = advanceState(first.state, [check('warning', '2026-08-08T00:01:00Z')], 2, 1);
  assert.deepEqual(alerting.transitions.map((item) => item.type), ['failure']);
  assert.equal(alerting.transitions[0]?.result.status, 'warning');

  const stillAlerting = advanceState(
    alerting.state,
    [check('failed', '2026-08-08T00:02:00Z')],
    2,
    1
  );
  assert.deepEqual(stillAlerting.transitions.map((item) => item.type), ['failure']);
  assert.equal(stillAlerting.transitions[0]?.result.status, 'failed');
  assert.equal(stillAlerting.state.checks.homepage?.alerting, true);
  assert.equal(stillAlerting.state.checks.homepage?.alertStatus, 'failed');

  const recovered = advanceState(
    stillAlerting.state,
    [check('ok', '2026-08-08T00:03:00Z')],
    2,
    1
  );
  assert.deepEqual(recovered.transitions.map((item) => item.type), ['recovery']);
});

test('transition report distinguishes warning, failure and recovery severity', () => {
  const report = renderTransitionReport([
    { type: 'failure', result: check('warning', '2026-08-08T00:00:00Z') },
    { type: 'failure', result: check('failed', '2026-08-08T00:00:01Z') },
    { type: 'recovery', result: check('ok', '2026-08-08T00:00:02Z') }
  ]);
  assert.match(report, /🟡 WARNING: Homepage/);
  assert.match(report, /🔴 FAIL: Homepage/);
  assert.match(report, /🟢 RECOVERY: Homepage/);
});

test('state update prunes checks that no longer exist', () => {
  const previous: MonitorState = {
    version: 1,
    checks: {
      obsolete: {
        alerting: false,
        consecutiveFailures: 0,
        consecutiveSuccesses: 1,
        lastStatus: 'ok',
        updatedAt: '2026-08-08T00:00:00Z'
      }
    }
  };
  const updated = advanceState(previous, [check('ok', '2026-08-08T00:01:00Z')], 2, 1);
  assert.deepEqual(Object.keys(updated.state.checks), ['homepage']);
});

test('saveState atomically replaces the target without leaving a temporary file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-state-'));
  const filePath = join(directory, 'state.json');
  try {
    const state = advanceState(
      emptyState(),
      [check('ok', '2026-08-08T00:00:00Z')],
      2,
      1
    ).state;
    await saveState(filePath, state);

    assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), state);
    assert.deepEqual(await readdir(directory), ['state.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('loadState classifies corrupted JSON without exposing its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-state-'));
  const filePath = join(directory, 'state.json');
  try {
    await writeFile(filePath, 'not-json-secret', 'utf8');
    await assert.rejects(loadState(filePath), (error: unknown) => {
      assert.ok(error instanceof InvalidMonitorStateError);
      assert.equal(error.message, 'Monitor state file contains invalid JSON');
      assert.equal(error.message.includes('secret'), false);
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
