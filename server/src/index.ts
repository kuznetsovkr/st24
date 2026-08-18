import 'dotenv/config';
import { createApp } from './app';
import { initDb } from './db/init';
import { assertPhoneVerificationConfiguration } from './phoneVerification';
import { assertTurnstileConfiguration } from './turnstile';
import { ensureUploadsDir } from './uploads';
import { startLogRetentionScheduler } from './logRetention';
import {
  startTelegramB2BPolling,
  startTelegramBotSupervision,
  startTelegramOrderPolling,
  startTelegramPolling,
  validateTelegramStartupConfig
} from './telegram';
import { startTelegramOutboxWorker } from './telegramOutboxWorker';
import { validateYooKassaStartupConfig } from './yookassa';
import { validateTrustProxyStartupConfig } from './runtimeConfig';

assertPhoneVerificationConfiguration();
assertTurnstileConfiguration();
validateTelegramStartupConfig();
validateYooKassaStartupConfig();
validateTrustProxyStartupConfig();

const PORT = Number(process.env.PORT) || 4000;
const app = createApp();

const start = async () => {
  await initDb();
  ensureUploadsDir();
  startLogRetentionScheduler();
  startTelegramOutboxWorker();
  startTelegramBotSupervision();
  startTelegramPolling();
  startTelegramOrderPolling();
  startTelegramB2BPolling();
  app.listen(PORT, () => {
    console.log(`API server listening on http://localhost:${PORT}`);
  });
};

start().catch((error) => {
  console.error('Failed to start server', error);
  process.exit(1);
});
