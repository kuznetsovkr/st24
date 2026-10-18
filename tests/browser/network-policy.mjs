import {apiOrigin, browserOrigin} from './settings.mjs';

/** @param {string} address @param {string} method */
export function requestTarget(address, method) {
  let url;
  try { url = new URL(address); } catch { return 'blocked'; }
  if (url.username || url.password || !['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'blocked';
  if (url.origin === apiOrigin && url.pathname.startsWith('/api/')) return 'mock-api';
  if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2' && method === 'GET') return 'mock-font';
  if (url.origin === 'https://cdn.jsdelivr.net' && url.pathname === '/npm/@cdek-it/widget@3' && method === 'GET') return 'mock-widget';
  if (url.origin === browserOrigin && !url.pathname.startsWith('/api/')) return 'local-static';
  return 'blocked';
}
