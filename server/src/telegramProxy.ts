import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';
import { createShutdownFence } from './shutdownFence';

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

let cachedProxyUrl: string | undefined;
let cachedProxyDispatcher: Dispatcher | undefined;
const dispatcherShutdownFence = createShutdownFence();
const retiredDispatcherCloses = new Set<Promise<void>>();
let retiredDispatcherCloseFailed = false;

const closeDispatcher = async (dispatcher: Dispatcher): Promise<void> => {
  try {
    await dispatcher.close();
    return;
  } catch {
    // Graceful close may fail for a broken proxy connection. Destroy the
    // dispatcher so its sockets cannot keep the process alive.
  }

  try {
    await dispatcher.destroy();
  } catch {
    throw new Error('Failed to close Telegram proxy dispatcher');
  }
};

const trackRetiredDispatcherClose = (dispatcher: Dispatcher) => {
  const closePromise = closeDispatcher(dispatcher);
  retiredDispatcherCloses.add(closePromise);
  void closePromise.then(
    () => {
      retiredDispatcherCloses.delete(closePromise);
    },
    () => {
      retiredDispatcherCloseFailed = true;
      retiredDispatcherCloses.delete(closePromise);
    }
  );
};

const createDispatcher = (proxyUrl: string): Dispatcher => {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks:') {
    return new Socks5ProxyAgent(proxyUrl);
  }
  return new ProxyAgent(proxyUrl);
};

export const getTelegramOutboundDispatcher = (): Dispatcher | undefined => {
  dispatcherShutdownFence.assertOpen('Telegram outbound dispatcher is shutting down');

  const proxyUrl = trimToUndefined(process.env.TELEGRAM_OUTBOUND_PROXY_URL);
  if (!proxyUrl) {
    return undefined;
  }

  if (cachedProxyUrl === proxyUrl && cachedProxyDispatcher) {
    return cachedProxyDispatcher;
  }

  const previousDispatcher = cachedProxyDispatcher;
  cachedProxyDispatcher = createDispatcher(proxyUrl);
  cachedProxyUrl = proxyUrl;
  if (previousDispatcher) {
    trackRetiredDispatcherClose(previousDispatcher);
  }
  return cachedProxyDispatcher;
};

export const closeTelegramOutboundDispatcher = (): Promise<void> => {
  return dispatcherShutdownFence.closeOnce(async () => {
    const dispatcher = cachedProxyDispatcher;
    const pendingRetiredCloses = [...retiredDispatcherCloses];
    cachedProxyDispatcher = undefined;
    cachedProxyUrl = undefined;

    const closes = [...pendingRetiredCloses];
    if (dispatcher) {
      closes.push(closeDispatcher(dispatcher));
    }
    const results = await Promise.allSettled(closes);
    if (
      retiredDispatcherCloseFailed
      || results.some((result) => result.status === 'rejected')
    ) {
      throw new Error('Failed to close Telegram proxy resources');
    }
  });
};
