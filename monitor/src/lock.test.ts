import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireMonitorLock, MonitorLockHeldError } from './lock';

test('an active lock prevents a concurrent monitor process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  const lock = await acquireMonitorLock(stateFile);
  try {
    await assert.rejects(acquireMonitorLock(stateFile), MonitorLockHeldError);
    assert.equal(JSON.parse(await readFile(lock.path, 'utf8')).pid, process.pid);
  } finally {
    await lock.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an active lock refreshes its lease beyond the stale threshold', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  const lock = await acquireMonitorLock(stateFile, { staleAfterMs: 60 });
  try {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 140));
    await assert.rejects(
      acquireMonitorLock(stateFile, { staleAfterMs: 60 }),
      MonitorLockHeldError
    );
  } finally {
    await lock.release();
    await rm(directory, { recursive: true, force: true });
  }
});

test('release is idempotent and removes the owned lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'nested', 'state.json');
  const lock = await acquireMonitorLock(stateFile);
  try {
    await lock.release();
    await lock.release();
    await assert.rejects(stat(lock.path), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a stale lock is reclaimed before acquiring a new one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  const lockPath = stateFile + '.lock';
  const now = Date.now();
  try {
    await writeFile(lockPath, '{"ownerId":"abandoned"}\n', 'utf8');
    const oldTime = new Date(now - 60_000);
    await utimes(lockPath, oldTime, oldTime);

    const lock = await acquireMonitorLock(stateFile, {
      staleAfterMs: 1_000,
      now: () => now
    });
    try {
      assert.notEqual(JSON.parse(await readFile(lock.path, 'utf8')).ownerId, 'abandoned');
    } finally {
      await lock.release();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release never removes a lock that no longer belongs to its owner', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  const lock = await acquireMonitorLock(stateFile);
  try {
    await writeFile(lock.path, '{"ownerId":"replacement"}\n', 'utf8');
    await lock.release();
    assert.equal(JSON.parse(await readFile(lock.path, 'utf8')).ownerId, 'replacement');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release can be retried after a transient owner read failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  let failRead = true;
  const lock = await acquireMonitorLock(stateFile, {
    io: {
      readText: async (filePath) => {
        if (failRead) {
          failRead = false;
          throw Object.assign(new Error('transient read failure'), { code: 'EIO' });
        }
        return readFile(filePath, 'utf8');
      }
    }
  });
  try {
    await assert.rejects(lock.release(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'EIO');
      return true;
    });
    await lock.release();
    await assert.rejects(stat(lock.path), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('release can be retried after a transient unlink failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  let failRemove = true;
  const lock = await acquireMonitorLock(stateFile, {
    io: {
      remove: async (filePath) => {
        if (failRemove) {
          failRemove = false;
          throw Object.assign(new Error('transient unlink failure'), { code: 'EBUSY' });
        }
        await unlink(filePath);
      }
    }
  });
  try {
    await assert.rejects(lock.release(), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'EBUSY');
      return true;
    });
    await stat(lock.path);
    await lock.release();
    await assert.rejects(stat(lock.path), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('invalid lock JSON is not deleted and release remains retryable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-monitor-lock-'));
  const stateFile = join(directory, 'state.json');
  const lock = await acquireMonitorLock(stateFile);
  try {
    const originalContents = await readFile(lock.path, 'utf8');
    await writeFile(lock.path, '{', 'utf8');
    await assert.rejects(lock.release(), /invalid JSON/);
    await writeFile(lock.path, originalContents, 'utf8');
    await lock.release();
    await assert.rejects(stat(lock.path), (error: unknown) => {
      assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
