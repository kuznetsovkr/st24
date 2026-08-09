import {
  ProxyAgent,
  Socks5ProxyAgent,
  request,
  type Dispatcher
} from 'undici';
import type { HttpClient, HttpRequestOptions, HttpResponseData } from './types';

class ResponseBodyTooLargeError extends Error {
  readonly code = 'RESPONSE_BODY_TOO_LARGE';
}

const createProxyDispatcher = (proxyUrl: string): Dispatcher => {
  const protocol = new URL(proxyUrl).protocol;
  if (protocol === 'socks:' || protocol === 'socks5:') {
    return new Socks5ProxyAgent(proxyUrl);
  }
  return new ProxyAgent(proxyUrl);
};

export const assertSafeRedirect = (currentUrl: URL, nextUrl: URL): void => {
  if (!['http:', 'https:'].includes(nextUrl.protocol) || nextUrl.username || nextUrl.password) {
    throw new Error('Unsafe redirect');
  }
  if (nextUrl.origin !== currentUrl.origin) {
    throw new Error('Redirect changed origin');
  }
};

const readBody = async (
  body: Dispatcher.ResponseData['body'],
  maxBodyBytes: number
): Promise<string> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of body) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.length;
    if (totalBytes > maxBodyBytes) {
      body.destroy(new ResponseBodyTooLargeError());
      throw new ResponseBodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes).toString('utf8');
};

export interface HttpClientOptions {
  timeoutMs: number;
  maxBodyBytes: number;
  proxyUrl?: string;
}

export const createHttpClient = ({
  timeoutMs,
  maxBodyBytes,
  proxyUrl
}: HttpClientOptions): HttpClient => {
  const dispatcher = proxyUrl ? createProxyDispatcher(proxyUrl) : undefined;

  return {
    async request(url: URL, options: HttpRequestOptions = {}): Promise<HttpResponseData> {
      const method = options.method ?? 'GET';
      let currentUrl = url;
      const signal = AbortSignal.timeout(timeoutMs);
      for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
        const response = await request(currentUrl, {
          method,
          headers: options.headers,
          body: options.body,
          dispatcher,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          signal
        });
        const locationHeader = response.headers.location;
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        const isRedirect =
          method === 'GET' &&
          [301, 302, 303, 307, 308].includes(response.statusCode) &&
          typeof location === 'string';
        if (isRedirect && options.followRedirects !== false && redirectCount < 5) {
          await response.body.dump();
          const nextUrl = new URL(location, currentUrl);
          assertSafeRedirect(currentUrl, nextUrl);
          currentUrl = nextUrl;
          continue;
        }
        return {
          statusCode: response.statusCode,
          body: await readBody(response.body, maxBodyBytes)
        };
      }
      throw new Error('Too many redirects');
    },

    async close(): Promise<void> {
      if (dispatcher) {
        await dispatcher.close();
      }
    }
  };
};

interface ErrorLike {
  code?: unknown;
  name?: unknown;
  cause?: unknown;
}

const findErrorCode = (error: unknown, depth = 0): string | undefined => {
  if (!error || typeof error !== 'object' || depth > 4) {
    return undefined;
  }
  const value = error as ErrorLike;
  if (typeof value.code === 'string' && /^[A-Z0-9_]+$/.test(value.code)) {
    return value.code;
  }
  return findErrorCode(value.cause, depth + 1);
};

export const safeErrorDetail = (error: unknown): string => {
  if (error instanceof ResponseBodyTooLargeError) {
    return 'response body exceeded the configured limit';
  }
  const message = error instanceof Error ? error.message : '';
  const proxyStatus = message.match(/^Proxy response \((\d{3})\)/)?.[1];
  if (proxyStatus) {
    return `proxy returned HTTP ${proxyStatus}`;
  }
  const safeMessage =
    /^Missing required environment variable: [A-Z0-9_]+$/.test(message) ||
    /^[A-Z0-9_]+ must (?:be |use |not contain |be less than ).+$/.test(message) ||
    /^MONITOR_DNS_HOST and MONITOR_TLS_HOST must be hostnames$/.test(message) ||
    message === 'MONITOR_TELEGRAM_BOT_TOKEN must not match a production bot token' ||
    message === 'Production Telegram bot tokens must be unique' ||
    message === 'MONITOR_HEARTBEAT_URL must use https' ||
    message === 'MONITOR_TELEGRAM_PROXY_URL must differ from TELEGRAM_OUTBOUND_PROXY_URL' ||
    message === 'Another monitor process is already running' ||
    message === 'Monitor lock file contains invalid JSON' ||
    /^Usage: monitor <check\|summary>$/.test(message) ||
    /^Monitor state file (?:contains|has) .+$/.test(message) ||
    /^Notifier (?:returned HTTP \d{3}|returned invalid JSON|rejected sendMessage)$/.test(message) ||
    /^Heartbeat returned HTTP \d{3}$/.test(message) ||
    message === 'Unsafe redirect' ||
    message === 'Redirect changed origin' ||
    message === 'Too many redirects';
  if (safeMessage) {
    return message;
  }
  const name = error && typeof error === 'object' ? String((error as ErrorLike).name) : '';
  const code = findErrorCode(error);
  if (
    name === 'TimeoutError' ||
    ['ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(
      code ?? ''
    )
  ) {
    return 'request timed out';
  }
  if (name === 'AbortError' || code === 'UND_ERR_ABORTED') {
    return 'request aborted';
  }
  return code ? `network error (${code})` : 'request failed';
};
