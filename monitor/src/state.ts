import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CheckResult, CheckStatus } from './types';

export interface StoredCheckState {
  alerting: boolean;
  alertStatus?: 'warning' | 'failed';
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastStatus: CheckStatus;
  updatedAt: string;
}

export interface MonitorState {
  version: 1;
  checks: Record<string, StoredCheckState>;
}

export interface StateTransition {
  type: 'failure' | 'recovery';
  result: CheckResult;
}

export interface StateUpdate {
  state: MonitorState;
  transitions: StateTransition[];
}

export class InvalidMonitorStateError extends Error {}

export const emptyState = (): MonitorState => ({ version: 1, checks: {} });

const isCheckStatus = (value: unknown): value is CheckStatus =>
  value === 'ok' || value === 'warning' || value === 'failed';

const isStoredCheckState = (value: unknown): value is StoredCheckState => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const item = value as Partial<StoredCheckState>;
  return (
    typeof item.alerting === 'boolean' &&
    (item.alertStatus === undefined || item.alertStatus === 'warning' || item.alertStatus === 'failed') &&
    Number.isInteger(item.consecutiveFailures) &&
    Number(item.consecutiveFailures) >= 0 &&
    Number.isInteger(item.consecutiveSuccesses) &&
    Number(item.consecutiveSuccesses) >= 0 &&
    isCheckStatus(item.lastStatus) &&
    typeof item.updatedAt === 'string'
  );
};

export const loadState = async (filePath: string): Promise<MonitorState> => {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyState();
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new InvalidMonitorStateError('Monitor state file contains invalid JSON');
  }
  if (!value || typeof value !== 'object') {
    throw new InvalidMonitorStateError('Monitor state file has an invalid structure');
  }
  const candidate = value as Partial<MonitorState>;
  if (
    candidate.version !== 1 ||
    !candidate.checks ||
    typeof candidate.checks !== 'object' ||
    Array.isArray(candidate.checks)
  ) {
    throw new InvalidMonitorStateError('Monitor state file has an unsupported structure or version');
  }
  for (const item of Object.values(candidate.checks)) {
    if (!isStoredCheckState(item)) {
      throw new InvalidMonitorStateError('Monitor state file has an invalid check entry');
    }
  }
  return candidate as MonitorState;
};

export const saveState = async (filePath: string, state: MonitorState): Promise<void> => {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  try {
    await rename(temporaryPath, filePath);
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (
        !error ||
        typeof error !== 'object' ||
        (error as NodeJS.ErrnoException).code !== 'ENOENT'
      ) {
        throw error;
      }
    });
  }
};

export const advanceState = (
  previous: MonitorState,
  results: CheckResult[],
  failureThreshold: number,
  recoveryThreshold: number
): StateUpdate => {
  const next: MonitorState = {
    version: 1,
    checks: {}
  };
  const transitions: StateTransition[] = [];

  for (const checkResult of results) {
    const old = previous.checks[checkResult.id];
    const isProblem = checkResult.status !== 'ok';
    let alerting = old?.alerting ?? false;
    let alertStatus = old?.alertStatus ??
      (old?.alerting ? (old.lastStatus === 'warning' ? 'warning' : 'failed') : undefined);
    let consecutiveFailures = isProblem
      ? (old && old.lastStatus !== 'ok' ? old.consecutiveFailures : 0) + 1
      : 0;
    let consecutiveSuccesses = isProblem
      ? 0
      : (old?.lastStatus === 'ok' ? old.consecutiveSuccesses : 0) + 1;

    if (isProblem && !alerting && consecutiveFailures >= failureThreshold) {
      alerting = true;
      alertStatus = checkResult.status === 'failed' ? 'failed' : 'warning';
      transitions.push({ type: 'failure', result: checkResult });
    } else if (alerting && alertStatus === 'warning' && checkResult.status === 'failed') {
      alertStatus = 'failed';
      transitions.push({ type: 'failure', result: checkResult });
    } else if (!isProblem && alerting && consecutiveSuccesses >= recoveryThreshold) {
      alerting = false;
      alertStatus = undefined;
      transitions.push({ type: 'recovery', result: checkResult });
      consecutiveSuccesses = 0;
    }

    const storedCheck: StoredCheckState = {
      alerting,
      consecutiveFailures,
      consecutiveSuccesses,
      lastStatus: checkResult.status,
      updatedAt: checkResult.checkedAt
    };
    if (alertStatus) storedCheck.alertStatus = alertStatus;
    next.checks[checkResult.id] = storedCheck;
  }

  return { state: next, transitions };
};
