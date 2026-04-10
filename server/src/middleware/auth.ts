import { NextFunction, Request, Response } from 'express';
import {
  CSRF_COOKIE_NAME,
  getCookieValue,
  getRequestAuthToken,
  verifyToken
} from '../auth';
import { logSecurityEventFromRequest, maskPhone } from '../securityEvents';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const normalizePhone = (value?: string | null) => (value ?? '').replace(/\D/g, '');

const getSuperAdminPhone = () =>
  normalizePhone(process.env.SUPER_ADMIN_PHONE ?? process.env.ADMIN_PHONE ?? '79964292550');

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
    logSecurityEventFromRequest(req, {
      eventType: 'auth_csrf_failed',
      reason: 'csrf_token_mismatch',
      userId: req.user?.userId,
      phoneMasked: maskPhone(req.user?.phone)
    });
    res.status(403).json({ error: 'Недействительный CSRF-токен' });
    return false;
  }

  return true;
};

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
  const { token, source } = getRequestAuthToken(req);
  if (!token || !source) {
    logSecurityEventFromRequest(req, {
      eventType: 'auth_unauthorized',
      reason: 'missing_auth_token'
    });
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
    logSecurityEventFromRequest(req, {
      eventType: 'auth_unauthorized',
      reason: 'invalid_or_expired_token'
    });
    res.status(401).json({ error: 'Требуется авторизация' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    logSecurityEventFromRequest(req, {
      eventType: 'auth_forbidden',
      reason: 'admin_role_required',
      userId: req.user?.userId,
      phoneMasked: maskPhone(req.user?.phone)
    });
    res.status(403).json({ error: 'Доступ запрещен' });
    return;
  }

  next();
};

export const requireSuperAdmin = (req: Request, res: Response, next: NextFunction) => {
  const superAdminPhone = getSuperAdminPhone();
  const userPhone = normalizePhone(req.user?.phone);
  const hasSuperAdminAccess =
    Boolean(req.user) &&
    req.user?.role === 'admin' &&
    Boolean(superAdminPhone) &&
    userPhone === superAdminPhone;

  if (!hasSuperAdminAccess) {
    logSecurityEventFromRequest(req, {
      eventType: 'auth_forbidden',
      reason: 'super_admin_required',
      userId: req.user?.userId,
      phoneMasked: maskPhone(req.user?.phone)
    });
    res.status(403).json({ error: 'Доступ запрещен' });
    return;
  }

  next();
};
