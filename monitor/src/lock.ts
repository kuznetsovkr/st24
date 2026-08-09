import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const DEFAULT_MONITOR_LOCK_STALE_MS = 15 * 60 * 1000;

interface LockFileContents {
  version: 1;
  ownerId: string;
  pid: number;
  createdAt: string;
}

export interface MonitorLock {
  path: string;
  release: () => Promise<void>;
}

export interface AcquireMonitorLockOptions {
  staleAfterMs?: number;
  now?: () => number;
  io?: Partial<MonitorLockIo>;
}

export interface MonitorLockIo {
  readText: (filePath: string) => Promise<string>;
  remove: (filePath: string) => Promise<void>;
}

export class MonitorLockHeldError extends Error {
  constructor() {
    super('Another monitor process is already running');
    this.name = 'MonitorLockHeldError';
  }
}

const isErrno = (error: unknown, code: string): boolean =>
  Boolean(
    error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === code
  );

type LockOwner =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'owner'; ownerId: string };

interface LockFingerprint {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}

const defaultIo: MonitorLockIo = {
  readText: (filePath) => readFile(filePath, 'utf8'),
  remove: (filePath) => unlink(filePath)
};

const readOwnerId = async (lockPath: string, io: MonitorLockIo): Promise<LockOwner> => {
  let raw: string;
  try {
    raw = await io.readText(lockPath);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return { kind: 'missing' };
    }
    throw error;
  }

  let parsed: Partial<LockFileContents>;
  try {
    parsed = JSON.parse(raw) as Partial<LockFileContents>;
  } catch {
    return { kind: 'invalid' };
  }
  return typeof parsed.ownerId === 'string'
    ? { kind: 'owner', ownerId: parsed.ownerId }
    : { kind: 'invalid' };
};

const sameOwner = (left: LockOwner, right: LockOwner): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }
  return left.kind !== 'owner' || right.kind !== 'owner' || left.ownerId === right.ownerId;
};

const fingerprint = (value: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): LockFingerprint => ({
  dev: value.dev,
  ino: value.ino,
  mtimeMs: value.mtimeMs,
  size: value.size
});

const sameFingerprint = (left: LockFingerprint, right: LockFingerprint): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.size === right.size;

const restoreMovedLock = async (
  movedPath: string,
  lockPath: string,
  io: MonitorLockIo
): Promise<void> => {
  try {
    await link(movedPath, lockPath);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      return;
    }
    throw error;
  }
  await io.remove(movedPath);
};

const createRelease = (
  lockPath: string,
  ownerId: string,
  io: MonitorLockIo,
  stopLeaseRefresh: () => void
): (() => Promise<void>) => {
  let released = false;
  const markReleased = () => {
    released = true;
    stopLeaseRefresh();
  };
  return async (): Promise<void> => {
    if (released) {
      return;
    }

    const observedOwner = await readOwnerId(lockPath, io);
    if (observedOwner.kind === 'missing') {
      markReleased();
      return;
    }
    if (observedOwner.kind === 'invalid') {
      throw new Error('Monitor lock file contains invalid JSON');
    }
    if (observedOwner.ownerId !== ownerId) {
      markReleased();
      return;
    }

    const confirmedOwner = await readOwnerId(lockPath, io);
    if (confirmedOwner.kind === 'missing') {
      markReleased();
      return;
    }
    if (confirmedOwner.kind === 'invalid') {
      throw new Error('Monitor lock file contains invalid JSON');
    }
    if (confirmedOwner.ownerId !== ownerId) {
      markReleased();
      return;
    }

    try {
      await io.remove(lockPath);
      markReleased();
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        markReleased();
        return;
      }
      throw error;
    }
  };
};

const startLeaseRefresh = (
  lockPath: string,
  ownerId: string,
  staleAfterMs: number,
  io: MonitorLockIo
): (() => void) => {
  let stopped = false;
  let refreshInFlight = false;
  const interval = setInterval(() => {
    if (stopped || refreshInFlight) return;
    refreshInFlight = true;
    void readOwnerId(lockPath, io)
      .then(async (owner) => {
        if (stopped || owner.kind !== 'owner' || owner.ownerId !== ownerId) return;
        const refreshedAt = new Date();
        await utimes(lockPath, refreshedAt, refreshedAt);
      })
      .catch(() => undefined)
      .finally(() => {
        refreshInFlight = false;
      });
  }, Math.max(10, Math.floor(staleAfterMs / 3)));
  interval.unref();

  return () => {
    stopped = true;
    clearInterval(interval);
  };
};

export const acquireMonitorLock = async (
  stateFile: string,
  options: AcquireMonitorLockOptions = {}
): Promise<MonitorLock> => {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_MONITOR_LOCK_STALE_MS;
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new Error('Monitor lock stale duration must be a positive number');
  }

  const now = options.now ?? Date.now;
  const io: MonitorLockIo = { ...defaultIo, ...options.io };
  const lockPath = stateFile + '.lock';
  const ownerId = randomUUID();
  const contents: LockFileContents = {
    version: 1,
    ownerId,
    pid: process.pid,
    createdAt: new Date(now()).toISOString()
  };
  await mkdir(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      await writeFile(lockPath, JSON.stringify(contents) + '\n', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600
      });
      const stopLeaseRefresh = startLeaseRefresh(lockPath, ownerId, staleAfterMs, io);
      return {
        path: lockPath,
        release: createRelease(lockPath, ownerId, io, stopLeaseRefresh)
      };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }
    }

    let lockStat;
    try {
      lockStat = await stat(lockPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }
    const observedFingerprint = fingerprint(lockStat);
    const observedOwner = await readOwnerId(lockPath, io);
    if (observedOwner.kind === 'missing') {
      continue;
    }

    let confirmedStat;
    try {
      confirmedStat = await stat(lockPath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }
    const confirmedFingerprint = fingerprint(confirmedStat);
    const confirmedOwner = await readOwnerId(lockPath, io);
    if (
      confirmedOwner.kind === 'missing' ||
      !sameFingerprint(observedFingerprint, confirmedFingerprint) ||
      !sameOwner(observedOwner, confirmedOwner)
    ) {
      throw new MonitorLockHeldError();
    }
    if (now() - confirmedStat.mtimeMs <= staleAfterMs) {
      throw new MonitorLockHeldError();
    }

    const stalePath = lockPath + '.' + ownerId + '.stale';
    try {
      await rename(lockPath, stalePath);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        continue;
      }
      throw error;
    }

    let movedStat;
    let movedOwner: LockOwner;
    try {
      movedStat = await stat(stalePath);
      movedOwner = await readOwnerId(stalePath, io);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        continue;
      }
      await restoreMovedLock(stalePath, lockPath, io);
      throw error;
    }
    if (
      movedOwner.kind === 'missing' ||
      !sameFingerprint(confirmedFingerprint, fingerprint(movedStat)) ||
      !sameOwner(confirmedOwner, movedOwner)
    ) {
      await restoreMovedLock(stalePath, lockPath, io);
      throw new MonitorLockHeldError();
    }
    await io.remove(stalePath).catch((error: unknown) => {
      if (!isErrno(error, 'ENOENT')) {
        throw error;
      }
    });
  }
};
