import { isIP } from 'net';

export type TrustProxySetting = boolean | number | string;

export const parseTrustProxy = (value: string | undefined): TrustProxySetting => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  if (/^[1-9][0-9]*$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }

  return trimmed;
};

const isExplicitProxyNetwork = (value: string) => {
  const slashIndex = value.lastIndexOf('/');
  const address = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const family = isIP(address);
  if (family === 0) {
    return false;
  }
  if (slashIndex === -1) {
    return true;
  }

  const prefix = value.slice(slashIndex + 1);
  if (!/^[0-9]+$/.test(prefix)) {
    return false;
  }
  const prefixLength = Number(prefix);
  const maximumPrefix = family === 4 ? 32 : 128;
  return prefixLength > 0 && prefixLength <= maximumPrefix;
};

export const validateTrustProxyStartupConfig = (
  env: NodeJS.ProcessEnv = process.env
): TrustProxySetting => {
  const setting = parseTrustProxy(env.TRUST_PROXY);
  const isProduction =
    (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  if (!isProduction || setting === false) {
    return setting;
  }

  if (setting === true || typeof setting === 'number') {
    throw new Error(
      'TRUST_PROXY must list explicit proxy IP addresses or CIDR ranges in production'
    );
  }

  const networks = setting
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (networks.length === 0 || networks.some((item) => !isExplicitProxyNetwork(item))) {
    throw new Error(
      'TRUST_PROXY must list explicit proxy IP addresses or CIDR ranges in production'
    );
  }

  return setting;
};

export const getTrustProxySetting = () => validateTrustProxyStartupConfig();
