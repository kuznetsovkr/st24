import dotenv from 'dotenv';
import { createApp } from './app';
import { initDb } from './db/init';
import { ensureUploadsDir } from './uploads';
import {
  startTelegramB2BPolling,
  startTelegramOrderPolling,
  startTelegramPolling
} from './telegram';

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const app = createApp();

const start = async () => {
  await initDb();
  ensureUploadsDir();
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
