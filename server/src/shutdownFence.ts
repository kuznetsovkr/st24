export type ShutdownFence = {
  isClosing: () => boolean;
  assertOpen: (message: string) => void;
  closeOnce: (close: () => void | Promise<void>) => Promise<void>;
};

/**
 * A terminal lifecycle fence for process-owned resources.
 *
 * The closing flag is raised synchronously, before the cleanup callback gets a
 * chance to yield, and every caller receives the exact same cleanup promise.
 * This prevents a late request from recreating a resource during shutdown.
 */
export const createShutdownFence = (): ShutdownFence => {
  let closing = false;
  let closePromise: Promise<void> | null = null;

  return {
    isClosing: () => closing,
    assertOpen: (message) => {
      if (closing) {
        throw new Error(message);
      }
    },
    closeOnce: (close) => {
      if (closePromise) {
        return closePromise;
      }

      closing = true;
      // Scheduling through Promise.then converts synchronous cleanup failures
      // into a stable rejected promise and assigns it before cleanup begins.
      closePromise = Promise.resolve().then(close);
      return closePromise;
    }
  };
};
