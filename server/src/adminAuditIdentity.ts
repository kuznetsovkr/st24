import { hostname, userInfo } from 'os';

export const getOperatingSystemAuditActor = () => {
  const login = (process.env.SUDO_USER ?? userInfo().username).trim();
  const host = hostname().trim();
  if (!login || !host) {
    throw new Error('Unable to determine OS audit identity');
  }
  return `${login}@${host}`;
};
