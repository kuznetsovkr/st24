import { ProxyAgent, Socks5ProxyAgent, type Dispatcher } from 'undici';

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

let cachedProxyUrl: string | undefined;
let cachedProxyDispatcher: Dispatcher | undefined;

const createDispatcher = (proxyUrl: string): Dispatcher => {
  const parsed = new URL(proxyUrl);
  if (parsed.protocol === 'socks5:' || parsed.protocol === 'socks:') {
    return new Socks5ProxyAgent(proxyUrl);
  }
  return new ProxyAgent(proxyUrl);
};

export const getTelegramOutboundDispatcher = (): Dispatcher | undefined => {
  const proxyUrl = trimToUndefined(process.env.TELEGRAM_OUTBOUND_PROXY_URL);
  if (!proxyUrl) {
    return undefined;
  }

  if (cachedProxyUrl === proxyUrl && cachedProxyDispatcher) {
    return cachedProxyDispatcher;
  }

  cachedProxyDispatcher = createDispatcher(proxyUrl);
  cachedProxyUrl = proxyUrl;
  return cachedProxyDispatcher;
};
