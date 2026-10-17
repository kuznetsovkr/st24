import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogRetentionScheduler } from './logRetention';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('retention stop waits for the active cleanup and prevents later runs', async () => {
  let resolveCleanup: (() => void) | undefined;
  let runs = 0;
  const stop = createLogRetentionScheduler(
    () =>
      new Promise<void>((resolve) => {
        runs += 1;
        resolveCleanup = resolve;
      }),
    5
  );

  await nextTurn();
  assert.equal(runs, 1);

  let stopped = false;
  const firstStop = stop().then(() => {
    stopped = true;
  });
  const secondStop = stop();
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(stopped, false);
  assert.equal(runs, 1);

  resolveCleanup?.();
  await Promise.all([firstStop, secondStop]);
  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(runs, 1);
});
