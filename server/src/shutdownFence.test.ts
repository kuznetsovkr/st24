import assert from 'node:assert/strict';
import test from 'node:test';
import { createShutdownFence } from './shutdownFence';

test('shutdown fence closes admission synchronously and runs cleanup once', async () => {
  const fence = createShutdownFence();
  let finishCleanup: (() => void) | undefined;
  let cleanupRuns = 0;

  assert.equal(fence.isClosing(), false);
  assert.doesNotThrow(() => fence.assertOpen('resource is shutting down'));

  const first = fence.closeOnce(
    () =>
      new Promise<void>((resolve) => {
        cleanupRuns += 1;
        finishCleanup = resolve;
      })
  );
  const second = fence.closeOnce(async () => {
    cleanupRuns += 100;
  });

  assert.equal(fence.isClosing(), true);
  assert.throws(() => fence.assertOpen('resource is shutting down'), /resource is shutting down/);
  assert.equal(first, second);

  await Promise.resolve();
  assert.equal(cleanupRuns, 1);
  finishCleanup?.();
  await first;
  assert.equal(cleanupRuns, 1);
});

test('shutdown fence retains a failed cleanup result without retrying', async () => {
  const fence = createShutdownFence();
  let cleanupRuns = 0;
  const failure = new Error('fixed cleanup failure');

  const first = fence.closeOnce(async () => {
    cleanupRuns += 1;
    throw failure;
  });
  await assert.rejects(first, failure);

  const second = fence.closeOnce(async () => {
    cleanupRuns += 100;
  });
  assert.equal(first, second);
  await assert.rejects(second, failure);
  assert.equal(cleanupRuns, 1);
});
