import type { CheckResult, MonitorConfig, MonitorMode } from './types';
import { createHttpClient } from './http';
import { createSiteChecks } from './checks';
import {
  checkTelegramBot,
  checkTelegramCanary,
  checkTelegramNotifier,
  checkTelegramProxy
} from './telegram';

export const shouldSendSuccessHeartbeat = (results: CheckResult[]): boolean =>
  !results.some(
    (result) =>
      result.id === 'telegram-notifier' &&
      result.critical &&
      result.status === 'failed'
  );

export const runChecks = async (
  config: MonitorConfig,
  mode: MonitorMode
): Promise<CheckResult[]> => {
  const outboundBots = config.telegramBots.filter((bot) => Boolean(bot.token));
  if (mode === 'summary' && outboundBots.length > 0 && !config.telegramCanaryChatId) {
    throw new Error('MONITOR_TELEGRAM_CANARY_CHAT_ID is required in summary mode');
  }
  const siteClient = createHttpClient({
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes
  });
  const telegramClient = createHttpClient({
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    proxyUrl: config.telegramProxyUrl
  });
  const notifierClient = createHttpClient({
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    proxyUrl: config.notifier.proxyUrl
  });

  try {
    return await Promise.all([
      ...createSiteChecks(config, siteClient),
      checkTelegramProxy(telegramClient, config.maxResponseMs),
      checkTelegramNotifier(
        config.notifier.token,
        config.notifier.expectedUsername,
        notifierClient,
        config.maxResponseMs
      ),
      ...config.telegramBots.map((bot) =>
        checkTelegramBot(
          bot,
          telegramClient,
          config.maxResponseMs,
          config.healthMaxAgeMs,
          config.telegramMaxPendingUpdates
        )
      ),
      ...(mode === 'summary'
        ? outboundBots
            .map((bot) =>
              checkTelegramCanary(
                bot,
                config.telegramCanaryChatId!,
                telegramClient,
                config.maxResponseMs
              )
            )
        : [])
    ]);
  } finally {
    await Promise.allSettled([
      siteClient.close(),
      telegramClient.close(),
      notifierClient.close()
    ]);
  }
};
