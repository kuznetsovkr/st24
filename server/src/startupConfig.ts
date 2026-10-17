import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { assertPhoneVerificationConfiguration } from './phoneVerification';
import { validateTrustProxyStartupConfig, type TrustProxySetting } from './runtimeConfig';
import { validateTelegramStartupConfig } from './telegram';
import {
  parseTelegramOutboxMaxRetryAgeDays,
  parseTelegramOutboxRetentionDays
} from './telegramOutboxConfig';
import { assertTurnstileConfiguration } from './turnstile';
import { validateYooKassaStartupConfig } from './yookassa';

type Environment = Record<string, string | undefined>;

export type ServerNodeEnvironment = 'development' | 'test' | 'production';

export type ServerStartupConfig = {
  nodeEnvironment: ServerNodeEnvironment;
  port: number;
  bindHost: string;
  trustProxy: TrustProxySetting;
};

export const assertSupportedNodeVersion = (
  version: string = process.versions.node
): void => {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) {
    throw new Error('Node.js version is unsupported');
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const supported =
    (major === 20 && minor >= 19) ||
    (major === 22 && minor >= 13) ||
    major >= 24;
  if (!supported) {
    throw new Error('Node.js 20.19+, 22.13+ or 24+ is required');
  }
};

const CORS_ENVIRONMENT_KEYS = [
  'CORS_ALLOWED_ORIGINS',
  'CORS_ORIGIN',
  'CLIENT_URL',
  'FRONTEND_URL'
] as const;

const required = (environment: Environment, name: string): string => {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const parseNodeEnvironment = (environment: Environment): ServerNodeEnvironment => {
  const value = environment.NODE_ENV;
  if (value !== 'development' && value !== 'test' && value !== 'production') {
    throw new Error('NODE_ENV must be development, test or production');
  }
  return value;
};

const parsePort = (environment: Environment): number => {
  const value = required(environment, 'PORT');
  if (!/^\d+$/.test(value)) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
};

const parseBindHost = (environment: Environment): string => {
  const value = required(environment, 'API_BIND_HOST');
  if (isIP(value)) {
    return value;
  }
  const ascii = domainToASCII(value);
  if (
    !ascii ||
    ascii.length > 253 ||
    ascii !== value.toLowerCase() ||
    !/^(?=.{1,253}$)(?:localhost|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/.test(
      ascii
    )
  ) {
    throw new Error('API_BIND_HOST must be an explicit IP address or hostname');
  }
  return value;
};

const validateDatabaseUrl = (environment: Environment): void => {
  const raw = required(environment, 'DATABASE_URL');
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (
    (value.protocol !== 'postgres:' && value.protocol !== 'postgresql:') ||
    !value.hostname ||
    value.pathname.length <= 1 ||
    value.hash
  ) {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
};

const validateJwtSecret = (
  environment: Environment,
  nodeEnvironment: ServerNodeEnvironment
): void => {
  const value = required(environment, 'JWT_SECRET');
  if (nodeEnvironment !== 'production') {
    return;
  }
  const normalized = value.toLowerCase();
  const placeholder =
    normalized === 'secret' ||
    normalized === 'password' ||
    normalized === 'jwt-secret' ||
    normalized === 'replace-with-a-long-random-secret' ||
    /^(?:change|replace|your)[-_ ]/.test(normalized);
  if (value.length < 32 || new Set(value).size < 8 || placeholder) {
    throw new Error('JWT_SECRET must be a non-placeholder secret of at least 32 characters in production');
  }
};

const validatePrivilegedPhone = (raw: string, name: string): string => {
  if (!/^(?:\+7|7|8)\d{10}$/.test(raw)) {
    throw new Error(`${name} must be a valid Russian phone number`);
  }
  if (raw.startsWith('+7')) return raw.slice(1);
  return raw.startsWith('8') ? `7${raw.slice(1)}` : raw;
};

const validateStrongPassword = (value: string | undefined, name: string): void => {
  const raw = value ?? '';
  const normalized = raw.trim().toLowerCase();
  const placeholder =
    /^(?:admin|password|change|replace|your)(?:$|[-_ ])/i.test(normalized) ||
    normalized === 'qwerty123456';
  if (
    raw !== raw.trim() ||
    raw.length < 12 ||
    new Set(raw).size < 6 ||
    placeholder
  ) {
    throw new Error(`${name} must be a non-placeholder password of at least 12 characters in production`);
  }
};

const validateProductionAdminConfiguration = (
  environment: Environment,
  nodeEnvironment: ServerNodeEnvironment
): void => {
  if (nodeEnvironment !== 'production') return;

  const adminPhone = validatePrivilegedPhone(
    required(environment, 'ADMIN_PHONE'),
    'ADMIN_PHONE'
  );
  const authMode = required(environment, 'ADMIN_AUTH_MODE').toLowerCase();
  if (authMode !== 'password' && authMode !== 'code') {
    throw new Error('ADMIN_AUTH_MODE must be password or code');
  }
  if (authMode === 'password') {
    validateStrongPassword(environment.ADMIN_PASSWORD, 'ADMIN_PASSWORD');
  }

  const superAdminPhoneRaw = environment.SUPER_ADMIN_PHONE?.trim();
  if (!superAdminPhoneRaw) return;
  const superAdminPhone = validatePrivilegedPhone(
    superAdminPhoneRaw,
    'SUPER_ADMIN_PHONE'
  );
  if (superAdminPhone === adminPhone) {
    throw new Error('SUPER_ADMIN_PHONE must differ from ADMIN_PHONE');
  }
  validateStrongPassword(environment.SUPER_ADMIN_PASSWORD, 'SUPER_ADMIN_PASSWORD');
};

const parseBoolean = (
  environment: Environment,
  name: string,
  fallback: boolean
): boolean => {
  const value = environment[name];
  if (value === undefined) return fallback;
  const raw = value.trim().toLowerCase();
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`${name} must be true or false`);
};

const validateProductionWebConfiguration = (
  environment: Environment,
  nodeEnvironment: ServerNodeEnvironment
): void => {
  const cookieSecure = parseBoolean(
    environment,
    'AUTH_COOKIE_SECURE',
    nodeEnvironment === 'production'
  );
  if (nodeEnvironment !== 'production') {
    return;
  }
  if (!cookieSecure) {
    throw new Error('AUTH_COOKIE_SECURE must be true in production');
  }
  const cookieSameSite = environment.AUTH_COOKIE_SAMESITE?.trim() || 'lax';
  if (
    cookieSameSite !== cookieSameSite.toLowerCase() ||
    !['lax', 'strict', 'none'].includes(cookieSameSite)
  ) {
    throw new Error('AUTH_COOKIE_SAMESITE must be lax, strict or none');
  }

  const origins = CORS_ENVIRONMENT_KEYS.flatMap((name) =>
    (environment[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => ({ name, value }))
  );
  if (origins.length === 0) {
    throw new Error(
      'At least one HTTPS CORS_ALLOWED_ORIGINS, CORS_ORIGIN, CLIENT_URL or FRONTEND_URL origin is required in production'
    );
  }
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin.value);
    } catch {
      throw new Error(`${origin.name} must contain only valid HTTPS origins in production`);
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash ||
      origin.value !== parsed.origin
    ) {
      throw new Error(`${origin.name} must contain only valid HTTPS origins in production`);
    }
  }
};

const validateTelegramProxyUrl = (environment: Environment): void => {
  const raw = environment.TELEGRAM_OUTBOUND_PROXY_URL?.trim();
  if (!raw) return;
  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('TELEGRAM_OUTBOUND_PROXY_URL must be a valid proxy URL');
  }
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(value.protocol)) {
    throw new Error('TELEGRAM_OUTBOUND_PROXY_URL must use http, https, socks or socks5');
  }
};

const validateRateLimitRedisConfiguration = (environment: Environment): void => {
  const enabled = parseBoolean(environment, 'RATE_LIMIT_REDIS_ENABLED', true);
  const requiredForRuntime = parseBoolean(
    environment,
    'RATE_LIMIT_REDIS_REQUIRED',
    false
  );
  if (requiredForRuntime && !enabled) {
    throw new Error(
      'RATE_LIMIT_REDIS_ENABLED must be true when RATE_LIMIT_REDIS_REQUIRED is true'
    );
  }

  const raw =
    environment.RATE_LIMIT_REDIS_URL?.trim() || environment.REDIS_URL?.trim();
  if (!raw) {
    if (requiredForRuntime) {
      throw new Error(
        'RATE_LIMIT_REDIS_URL or REDIS_URL is required when RATE_LIMIT_REDIS_REQUIRED is true'
      );
    }
    return;
  }

  let value: URL;
  try {
    value = new URL(raw);
  } catch {
    throw new Error('RATE_LIMIT_REDIS_URL or REDIS_URL must be a valid Redis URL');
  }
  if (
    (value.protocol !== 'redis:' && value.protocol !== 'rediss:') ||
    !value.hostname ||
    value.hash
  ) {
    throw new Error('RATE_LIMIT_REDIS_URL or REDIS_URL must be a valid Redis URL');
  }
};

export const validateServerStartupConfig = (
  environment: Environment = process.env
): ServerStartupConfig => {
  const nodeEnvironment = parseNodeEnvironment(environment);
  const port = parsePort(environment);
  const bindHost = parseBindHost(environment);

  validateDatabaseUrl(environment);
  validateJwtSecret(environment, nodeEnvironment);
  validateProductionAdminConfiguration(environment, nodeEnvironment);
  validateProductionWebConfiguration(environment, nodeEnvironment);
  validateRateLimitRedisConfiguration(environment);
  assertPhoneVerificationConfiguration(environment);
  assertTurnstileConfiguration(environment);
  validateTelegramStartupConfig(environment);
  validateTelegramProxyUrl(environment);
  validateYooKassaStartupConfig(environment);
  const trustProxy = validateTrustProxyStartupConfig(environment);
  parseTelegramOutboxMaxRetryAgeDays(environment.TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS);
  parseTelegramOutboxRetentionDays(environment.TELEGRAM_OUTBOX_RETENTION_DAYS);

  return { nodeEnvironment, port, bindHost, trustProxy };
};
