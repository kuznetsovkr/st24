import { NextFunction, Request, Response } from 'express';
import {
  CSRF_COOKIE_NAME,
  getCookieValue,
  getRequestAuthToken,
  verifyToken
} from '../auth';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const getCsrfHeaderValue = (req: Request) => {
  const value = req.header('x-csrf-token');
  return typeof value === 'string' ? value.trim() : '';
};

const ensureCsrfProtection = (req: Request, res: Response) => {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return true;
  }

  if (req.authTokenSource !== 'cookie') {
    return true;
  }

  const csrfHeader = getCsrfHeaderValue(req);
  const csrfCookie = getCookieValue(req, CSRF_COOKIE_NAME) ?? '';
  const csrfFromJwt = req.user?.csrfToken ?? '';

  if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie || csrfHeader !== csrfFromJwt) {
    res.status(403).json({ error: 'Недействительный CSRF-токен' });
    return false;
  }

  return true;
};

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const { token, source } = getRequestAuthToken(req);
  if (!token || !source) {
    res.status(401).json({ error: 'Требуется авторизация' });
    return;
  }

  try {
    const payload = verifyToken(token);
    req.user = payload;
    req.authTokenSource = source;

    if (!ensureCsrfProtection(req, res)) {
      return;
    }

    next();
  } catch {
    res.status(401).json({ error: 'Требуется авторизация' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Доступ запрещен' });
    return;
  }

  next();
};
