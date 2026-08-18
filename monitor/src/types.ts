export type CheckStatus = 'ok' | 'warning' | 'failed';

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  critical: boolean;
  detail: string;
  latencyMs?: number;
  checkedAt: string;
}

export interface TelegramBotConfig {
  id: 'telegram-main' | 'telegram-orders' | 'telegram-b2b';
  label: string;
  token?: string;
  expectedUsername?: string;
  mode: TelegramBotMode;
  expectedWebhookUrl?: string;
}

export type TelegramBotMode = 'polling' | 'webhook' | 'disabled';

export interface MonitorConfig {
  siteUrl: URL;
  dnsHost: string;
  tlsHost: string;
  tlsPort: number;
  liveUrl: URL;
  readyUrl: URL;
  notificationsUrl: URL;
  catalogUrl: URL;
  catalogMinItems: number;
  homepageMarker: string;
  catalogMarker?: string;
  healthMaxAgeMs: number;
  timeoutMs: number;
  maxResponseMs: number;
  maxBodyBytes: number;
  tlsWarnDays: number;
  tlsCriticalDays: number;
  failureThreshold: number;
  recoveryThreshold: number;
  telegramProxyUrl: string;
  telegramMaxPendingUpdates: number;
  telegramBots: TelegramBotConfig[];
  telegramCanaryChatId?: string;
  notifier: {
    token: string;
    chatId: string;
    expectedUsername?: string;
    proxyUrl?: string;
  };
  heartbeatUrl?: URL;
  stateFile: string;
}

export type MonitorMode = 'check' | 'summary';

export interface HttpResponseData {
  statusCode: number;
  body: string;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  followRedirects?: boolean;
}

export interface HttpClient {
  request(url: URL, options?: HttpRequestOptions): Promise<HttpResponseData>;
  close(): Promise<void>;
}
