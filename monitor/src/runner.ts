import type { CheckResult, MonitorConfig } from './types';
import { createHttpClient } from './http';
import { createSiteChecks } from './checks';
import { checkTelegramBot, checkTelegramProxy } from './telegram';

export const runChecks = async (config: MonitorConfig): Promise<CheckResult[]> => {
  const siteClient = createHttpClient({
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes
  });
  const telegramClient = createHttpClient({
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    proxyUrl: config.telegramProxyUrl
  });

  try {
    return await Promise.all([
      ...createSiteChecks(config, siteClient),
      checkTelegramProxy(telegramClient, config.maxResponseMs),
      ...config.telegramBots.map((bot) =>
        checkTelegramBot(bot, telegramClient, config.maxResponseMs)
      )
    ]);
  } finally {
    await Promise.allSettled([siteClient.close(), telegramClient.close()]);
  }
};
