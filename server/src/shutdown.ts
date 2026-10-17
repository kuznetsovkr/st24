export const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 20_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 27_000;

export type ShutdownTask = {
  name: string;
  run: () => void | Promise<void>;
};

export type ShutdownResult = {
  timedOut: boolean;
  drainTimedOut: boolean;
  failedTasks: string[];
};

export type ShutdownCoordinatorOptions = {
  drainTasks: readonly ShutdownTask[];
  releaseTasks: readonly ShutdownTask[];
  drainTimeoutMs?: number;
  timeoutMs?: number;
  onDrainTimeout?: () => void;
  onTimeout?: () => void;
};

export type HttpServerForShutdown = {
  close: (callback: (error?: Error) => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

const isServerNotRunningError = (error: Error) =>
  (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING';

export const closeHttpServer = async (
  server: HttpServerForShutdown | null
): Promise<void> => {
  if (!server) return;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (!error || isServerNotRunningError(error)) {
        resolve();
        return;
      }
      reject(new Error('http_server_close_failed'));
    };

    try {
      server.close(finish);
      server.closeIdleConnections?.();
    } catch {
      finish(new Error('http_server_close_failed'));
    }
  });
};

export const forceCloseHttpServer = (server: HttpServerForShutdown | null): void => {
  try {
    server?.closeAllConnections?.();
  } catch {
    // The process-level hard deadline remains the final fallback.
  }
};

const validateTimeouts = (drainTimeoutMs: number, timeoutMs: number) => {
  if (
    !Number.isSafeInteger(drainTimeoutMs) ||
    drainTimeoutMs <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= drainTimeoutMs
  ) {
    throw new Error('Invalid shutdown timeouts');
  }
};

const executeTasks = async (tasks: readonly ShutdownTask[]): Promise<string[]> => {
  const results = await Promise.allSettled(
    tasks.map((task) => Promise.resolve().then(() => task.run()))
  );
  return results.flatMap((result, index) =>
    result.status === 'rejected' ? [tasks[index]?.name ?? 'unknown'] : []
  );
};

const callHook = (hook: (() => void) | undefined): boolean => {
  try {
    hook?.();
    return true;
  } catch {
    return false;
  }
};

export const createShutdownCoordinator = (options: ShutdownCoordinatorOptions) => {
  const drainTimeoutMs =
    options.drainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  validateTimeouts(drainTimeoutMs, timeoutMs);

  let shutdownPromise: Promise<ShutdownResult> | null = null;

  const runShutdown = async (): Promise<ShutdownResult> => {
    const failedTasks: string[] = [];
    let drainTimedOut = false;

    const work = (async (): Promise<ShutdownResult> => {
      const drainPromise = executeTasks(options.drainTasks);
      let drainTimer: NodeJS.Timeout | undefined;
      const drainOutcome = await Promise.race([
        drainPromise.then((failures) => ({ kind: 'done' as const, failures })),
        new Promise<{ kind: 'timeout' }>((resolve) => {
          drainTimer = setTimeout(() => resolve({ kind: 'timeout' }), drainTimeoutMs);
        })
      ]);
      if (drainTimer) clearTimeout(drainTimer);

      if (drainOutcome.kind === 'timeout') {
        drainTimedOut = true;
        if (!callHook(options.onDrainTimeout)) failedTasks.push('force-drain');
      } else {
        failedTasks.push(...drainOutcome.failures);
      }

      failedTasks.push(...(await executeTasks(options.releaseTasks)));
      return {
        timedOut: false,
        drainTimedOut,
        failedTasks
      };
    })();

    let deadlineTimer: NodeJS.Timeout | undefined;
    const deadline = new Promise<ShutdownResult>((resolve) => {
      deadlineTimer = setTimeout(() => {
        if (!callHook(options.onTimeout)) failedTasks.push('force-timeout');
        resolve({
          timedOut: true,
          drainTimedOut,
          failedTasks: [...failedTasks]
        });
      }, timeoutMs);
    });

    const result = await Promise.race([work, deadline]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    return result;
  };

  return {
    shutdown: (): Promise<ShutdownResult> => {
      shutdownPromise ??= runShutdown();
      return shutdownPromise;
    }
  };
};
