import dotenv from 'dotenv';
import { createApp } from './app';

dotenv.config();

const PORT = Number(process.env.PORT) || 4000;
const app = createApp();

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
