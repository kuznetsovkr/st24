#!/usr/bin/env node
import { resolve } from 'node:path';
import { createHttpClient, safeErrorDetail } from './http';
import { loadEnvFile, parseConfig, parseMode } from './config';
import { acquireMonitorLock } from './lock';
import { renderConsoleReport, renderSummaryReport, renderTransitionReport } from './report';
import { runChecks, shouldSendSuccessHeartbeat } from './runner';
import {
  advanceState,
  emptyState,
  InvalidMonitorStateError,
  loadState,
  saveState
} from './state';
import { sendTelegramNotification } from './telegram';

const runMonitor = async (
  config: ReturnType<typeof parseConfig>,
  mode: ReturnType<typeof parseMode>
): Promise<number> => {
  let stateWasReset = false;
  const previousState = await loadState(config.stateFile).catch((error: unknown) => {
    if (!(error instanceof InvalidMonitorStateError)) {
      throw error;
    }
    stateWasReset = true;
    process.stderr.write(`Monitor state reset: ${safeErrorDetail(error)}\n`);
    return emptyState();
  });
  const results = await runChecks(config, mode);
  process.stdout.write(`${renderConsoleReport(results)}\n`);

  const stateUpdate = advanceState(
    previousState,
    results,
    config.failureThreshold,
    config.recoveryThreshold
  );
  const regularNotification =
    mode === 'summary'
      ? renderSummaryReport(results)
      : stateUpdate.transitions.length > 0
        ? renderTransitionReport(stateUpdate.transitions)
        : undefined;
  const notification = stateWasReset
    ? `🟡 HER monitor state was corrupted and reset.\n${regularNotification ?? renderSummaryReport(results)}`
    : regularNotification;

  if (notification) {
    const notifierClient = createHttpClient({
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes,
      proxyUrl: config.notifier.proxyUrl
    });
    try {
      await sendTelegramNotification(
        config.notifier.token,
        config.notifier.chatId,
        notification,
        notifierClient
      );
      process.stdout.write(
        mode === 'summary' || stateWasReset
          ? 'Telegram summary sent.\n'
          : `Telegram transition alert sent (${stateUpdate.transitions.length}).\n`
      );
    } catch (error) {
      process.stderr.write(`Telegram notification failed: ${safeErrorDetail(error)}\n`);
      return 1;
    } finally {
      await notifierClient.close().catch(() => undefined);
    }
  }

  await saveState(config.stateFile, stateUpdate.state);
  if (config.heartbeatUrl && shouldSendSuccessHeartbeat(results)) {
    const heartbeatClient = createHttpClient({
      timeoutMs: config.timeoutMs,
      maxBodyBytes: config.maxBodyBytes
    });
    try {
      const response = await heartbeatClient.request(config.heartbeatUrl, {
        followRedirects: false
      });
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(`Heartbeat returned HTTP ${response.statusCode}`);
      }
      process.stdout.write('Dead-man heartbeat sent.\n');
    } finally {
      await heartbeatClient.close().catch(() => undefined);
    }
  } else if (config.heartbeatUrl) {
    process.stderr.write('Dead-man heartbeat skipped: Telegram notifier check failed.\n');
  }
  return results.some((result) => result.critical && result.status === 'failed') ? 1 : 0;
};

const main = async (): Promise<number> => {
  const defaultEnvFile = resolve(__dirname, '..', '.env');
  loadEnvFile(process.env.MONITOR_ENV_FILE ?? defaultEnvFile);
  const mode = parseMode(process.argv.slice(2));
  const config = parseConfig(process.env);
  const lock = await acquireMonitorLock(config.stateFile);
  try {
    return await runMonitor(config, mode);
  } finally {
    await lock.release();
  }
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`Monitor failed: ${safeErrorDetail(error)}\n`);
    process.exitCode = 1;
  });
