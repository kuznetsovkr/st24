import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeHttpServer,
  createShutdownCoordinator,
  DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  forceCloseHttpServer,
  type HttpServerForShutdown
} from './shutdown';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

test('default hard deadline leaves systemd a termination margin', () => {
  assert.ok(DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS < DEFAULT_SHUTDOWN_TIMEOUT_MS);
  assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 30_000);
});

test('shutdown drains work before releasing shared resources', async () => {
  let finishDrain: (() => void) | undefined;
  const order: string[] = [];
  const coordinator = createShutdownCoordinator({
    drainTimeoutMs: 100,
    timeoutMs: 500,
    drainTasks: [
      {
        name: 'http',
        run: () =>
          new Promise<void>((resolve) => {
            order.push('drain-start');
            finishDrain = resolve;
          })
      }
    ],
    releaseTasks: [
      {
        name: 'database',
        run: () => {
          order.push('release');
        }
      }
    ]
  });

  const shutdown = coordinator.shutdown();
  await nextTurn();
  assert.deepEqual(order, ['drain-start']);
  finishDrain?.();

  assert.deepEqual(await shutdown, {
    timedOut: false,
    drainTimedOut: false,
    failedTasks: []
  });
  assert.deepEqual(order, ['drain-start', 'release']);
});

test('shutdown is idempotent while cleanup is in flight', async () => {
  let runs = 0;
  const coordinator = createShutdownCoordinator({
    drainTimeoutMs: 100,
    timeoutMs: 500,
    drainTasks: [
      {
        name: 'worker',
        run: async () => {
          runs += 1;
        }
      }
    ],
    releaseTasks: []
  });

  const first = coordinator.shutdown();
  const second = coordinator.shutdown();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(runs, 1);
});

test('shutdown reports only fixed task names, not rejection details', async () => {
  const coordinator = createShutdownCoordinator({
    drainTimeoutMs: 100,
    timeoutMs: 500,
    drainTasks: [
      {
        name: 'telegram-polling',
        run: async () => {
          throw new Error('socks5://user:raw-secret@proxy.example.test');
        }
      }
    ],
    releaseTasks: []
  });

  const result = await coordinator.shutdown();
  assert.deepEqual(result.failedTasks, ['telegram-polling']);
  assert.equal(JSON.stringify(result).includes('raw-secret'), false);
});

test('drain deadline forces connections and continues resource release', async () => {
  let forceCalls = 0;
  let releases = 0;
  const coordinator = createShutdownCoordinator({
    drainTimeoutMs: 10,
    timeoutMs: 200,
    drainTasks: [{ name: 'stuck-request', run: () => new Promise(() => undefined) }],
    releaseTasks: [{ name: 'database', run: () => void (releases += 1) }],
    onDrainTimeout: () => {
      forceCalls += 1;
    }
  });

  const result = await coordinator.shutdown();
  assert.equal(result.timedOut, false);
  assert.equal(result.drainTimedOut, true);
  assert.equal(forceCalls, 1);
  assert.equal(releases, 1);
});

test('hard deadline returns even when resource release is stuck', async () => {
  let timeoutCalls = 0;
  const coordinator = createShutdownCoordinator({
    drainTimeoutMs: 10,
    timeoutMs: 30,
    drainTasks: [{ name: 'stuck-drain', run: () => new Promise(() => undefined) }],
    releaseTasks: [{ name: 'stuck-release', run: () => new Promise(() => undefined) }],
    onTimeout: () => {
      timeoutCalls += 1;
    }
  });

  const result = await coordinator.shutdown();
  assert.equal(result.timedOut, true);
  assert.equal(result.drainTimedOut, true);
  assert.equal(timeoutCalls, 1);
});

test('HTTP close drains idle connections and ignores an already stopped server', async () => {
  let idleCloseCalls = 0;
  const server: HttpServerForShutdown = {
    close: (callback) => {
      callback(Object.assign(new Error('not running'), { code: 'ERR_SERVER_NOT_RUNNING' }));
    },
    closeIdleConnections: () => {
      idleCloseCalls += 1;
    }
  };

  await closeHttpServer(server);
  assert.equal(idleCloseCalls, 1);
  await closeHttpServer(null);
});

test('forced HTTP close is best effort', () => {
  let forceCalls = 0;
  forceCloseHttpServer({
    close: () => undefined,
    closeAllConnections: () => {
      forceCalls += 1;
      throw new Error('ignored');
    }
  });
  assert.equal(forceCalls, 1);
  assert.doesNotThrow(() => forceCloseHttpServer(null));
});

test('shutdown timeout configuration must leave room for hard cleanup', () => {
  assert.throws(
    () =>
      createShutdownCoordinator({
        drainTasks: [],
        releaseTasks: [],
        drainTimeoutMs: 100,
        timeoutMs: 100
      }),
    /Invalid shutdown timeouts/
  );
});
