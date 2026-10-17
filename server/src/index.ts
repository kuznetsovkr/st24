import 'dotenv/config';
import type { Server } from 'node:http';
import { createApp } from './app';
import { closeDatabasePools } from './db';
import { initDb } from './db/init';
import { ensureUploadsDir } from './uploads';
import {
  startLogRetentionScheduler,
  type StopLogRetentionScheduler
} from './logRetention';
import { closeRateLimiterRedis } from './rateLimiter';
import {
  startTelegramB2BPolling,
  startTelegramBotSupervision,
  startTelegramOrderPolling,
  startTelegramPolling,
  stopTelegramBotSupervision,
  stopTelegramPolling
} from './telegram';
import {
  startTelegramOutboxWorker,
  stopTelegramOutboxWorker
} from './telegramOutboxWorker';
import { closeTelegramOutboundDispatcher } from './telegramProxy';
import {
  assertSupportedNodeVersion,
  validateServerStartupConfig
} from './startupConfig';
import {
  closeHttpServer,
  createShutdownCoordinator,
  forceCloseHttpServer
} from './shutdown';

assertSupportedNodeVersion();
const { port: PORT, bindHost: BIND_HOST } = validateServerStartupConfig();
const app = createApp();
let httpServer: Server | null = null;
let stopLogRetention: StopLogRetentionScheduler = async () => undefined;
let shutdownRequested = false;
let requestedExitCode = 0;
let startupPromise: Promise<void> = Promise.resolve();

const listen = async (): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const server = app.listen(PORT, BIND_HOST);
    httpServer = server;
    let settled = false;

    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
      server.off('close', onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    const onListening = () => {
      console.log(`API server listening on http://${BIND_HOST}:${PORT}`);
      finish();
    };
    const onError = () => finish(new Error('HTTP server failed to listen'));
    const onClose = () => {
      if (shutdownRequested) {
        finish();
        return;
      }
      finish(new Error('HTTP server closed during startup'));
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.once('close', onClose);
  });
};

const start = async () => {
  await initDb();
  if (shutdownRequested) return;

  ensureUploadsDir();
  stopLogRetention = startLogRetentionScheduler();
  startTelegramOutboxWorker();
  startTelegramBotSupervision();
  startTelegramPolling();
  startTelegramOrderPolling();
  startTelegramB2BPolling();
  await listen();
};

const shutdownCoordinator = createShutdownCoordinator({
  drainTasks: [
    {
      name: 'startup',
      run: async () => {
        await startupPromise.catch(() => undefined);
      }
    },
    { name: 'http', run: () => closeHttpServer(httpServer) },
    { name: 'log-retention', run: () => stopLogRetention() },
    { name: 'telegram-outbox', run: stopTelegramOutboxWorker },
    { name: 'telegram-supervision', run: stopTelegramBotSupervision },
    { name: 'telegram-polling', run: stopTelegramPolling }
  ],
  releaseTasks: [
    { name: 'telegram-dispatcher', run: closeTelegramOutboundDispatcher },
    { name: 'rate-limit-redis', run: closeRateLimiterRedis },
    { name: 'database', run: closeDatabasePools }
  ],
  onDrainTimeout: () => forceCloseHttpServer(httpServer),
  onTimeout: () => forceCloseHttpServer(httpServer)
});

type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'startup_failure';

const requestShutdown = (reason: ShutdownReason, exitCode: number) => {
  requestedExitCode = Math.max(requestedExitCode, exitCode);
  if (shutdownRequested) return;
  shutdownRequested = true;
  console.log(`[shutdown] ${reason}: stopping service`);

  void shutdownCoordinator.shutdown().then(
    (result) => {
      const failed = result.failedTasks.length > 0;
      const unsuccessful = result.timedOut || result.drainTimedOut || failed;
      if (unsuccessful) {
        const taskNames = result.failedTasks.join(',') || 'deadline';
        console.error(`[shutdown] incomplete cleanup: ${taskNames}`);
      } else {
        console.log('[shutdown] service stopped cleanly');
      }
      process.exit(unsuccessful ? 1 : requestedExitCode);
    },
    () => {
      console.error('[shutdown] coordinator failed');
      process.exit(1);
    }
  );
};

process.once('SIGTERM', () => requestShutdown('SIGTERM', 0));
process.once('SIGINT', () => requestShutdown('SIGINT', 0));

startupPromise = start();
void startupPromise.catch(() => {
  console.error('Failed to start server');
  requestShutdown('startup_failure', 1);
});
