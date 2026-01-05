import cors from 'cors';
import express, { Request, Response } from 'express';

export const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'E-commerce API' });
  });

  return app;
};
