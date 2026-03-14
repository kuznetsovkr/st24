import { randomBytes } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export type AuthPayload = {
  userId: string;
  phone: string;
  role: string;
  csrfToken: string;
};

export type AuthTokenSource = 'cookie' | 'header';

export type AuthTokenLookupResult = {
  token: string | null;
  source: AuthTokenSource | null;
};

export const AUTH_COOKIE_NAME = 'her_auth_token';
export const CSRF_COOKIE_NAME = 'her_csrf_token';
const AUTH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

const getJwtSecret = () => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET is required');
  }
  return jwtSecret;
};

const parseBooleanEnv = (value: string | undefined, fallback: boolean) => {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  return fallback;
};

const getCookieSameSite = (): CookieOptions['sameSite'] => {
  const value = (process.env.AUTH_COOKIE_SAMESITE ?? 'lax').trim().toLowerCase();
  if (value === 'none' || value === 'strict' || value === 'lax') {
    return value;
  }
  return 'lax';
};

const isCookieSecure = () =>
  parseBooleanEnv(process.env.AUTH_COOKIE_SECURE, process.env.NODE_ENV === 'production');

const getCookieBaseOptions = (): Pick<CookieOptions, 'path' | 'sameSite' | 'secure'> => ({
  path: '/',
  sameSite: getCookieSameSite(),
  secure: isCookieSecure()
});

const parseCookieHeader = (cookieHeader: string | undefined) => {
  const cookies = new Map<string, string>();
  if (!cookieHeader) {
    return cookies;
  }

  for (const chunk of cookieHeader.split(';')) {
    const separatorIndex = chunk.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const name = chunk.slice(0, separatorIndex).trim();
    if (!name) {
      continue;
    }
    const rawValue = chunk.slice(separatorIndex + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(rawValue));
    } catch {
      cookies.set(name, rawValue);
    }
  }

  return cookies;
};

export const getCookieValue = (req: Request, name: string) => {
  const cookies = parseCookieHeader(req.headers.cookie);
  return cookies.get(name);
};

export const getRequestAuthToken = (req: Request): AuthTokenLookupResult => {
  const cookieToken = getCookieValue(req, AUTH_COOKIE_NAME);
  if (cookieToken) {
    return {
      token: cookieToken,
      source: 'cookie'
    };
  }

  const header = req.headers.authorization;
  if (!header) {
    return { token: null, source: null };
  }

  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return { token: null, source: null };
  }

  return {
    token: match[1].trim(),
    source: 'header'
  };
};

export const createCsrfToken = () => randomBytes(32).toString('hex');

export const signToken = (payload: AuthPayload) =>
  jwt.sign(payload, getJwtSecret(), { expiresIn: `${AUTH_TOKEN_TTL_SECONDS}s` });

export const verifyToken = (token: string) => jwt.verify(token, getJwtSecret()) as AuthPayload;

export const setAuthCookies = (res: Response, token: string, csrfToken: string) => {
  const baseOptions = getCookieBaseOptions();
  const maxAge = AUTH_TOKEN_TTL_SECONDS * 1000;

  res.cookie(AUTH_COOKIE_NAME, token, {
    ...baseOptions,
    httpOnly: true,
    maxAge
  });
  res.cookie(CSRF_COOKIE_NAME, csrfToken, {
    ...baseOptions,
    httpOnly: false,
    maxAge
  });
};

export const clearAuthCookies = (res: Response) => {
  const baseOptions = getCookieBaseOptions();
  res.clearCookie(AUTH_COOKIE_NAME, {
    ...baseOptions,
    httpOnly: true
  });
  res.clearCookie(CSRF_COOKIE_NAME, {
    ...baseOptions,
    httpOnly: false
  });
};
