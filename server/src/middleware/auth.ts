import { NextFunction, Request, Response } from 'express';
import {
  CSRF_COOKIE_NAME,
  getCookieValue,
  getRequestAuthToken,
  verifyToken
} from '../auth';
import { logSecurityEventFromRequest, maskPhone } from '../securityEvents';

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
    logSecurityEventFromRequest(req, {
      eventType: 'auth_csrf_failed',
      reason: 'csrf_token_mismatch',
      userId: req.user?.userId,
      phoneMasked: maskPhone(req.user?.phone)
    });
    res.status(403).json({ error: '\u041d\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043b\u044c\u043d\u044b\u0439 CSRF-\u0442\u043e\u043a\u0435\u043d' });
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
    res.status(401).json({ error: '\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f' });
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
    res.status(401).json({ error: '\u0422\u0440\u0435\u0431\u0443\u0435\u0442\u0441\u044f \u0430\u0432\u0442\u043e\u0440\u0438\u0437\u0430\u0446\u0438\u044f' });
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
    res.status(403).json({ error: '\u0414\u043e\u0441\u0442\u0443\u043f \u0437\u0430\u043f\u0440\u0435\u0449\u0435\u043d' });
    return;
  }

  next();
};
