// Synthetic public build values only. Never inherit client/.env or real keys.
export const browserOrigin = 'http://127.0.0.1:4178';
export const apiOrigin = 'https://api.browser.test';
export const clientConfig = Object.freeze({
  VITE_API_URL: apiOrigin,
  VITE_SITE_URL: 'https://shop.browser.test',
  VITE_TURNSTILE_SITE_KEY: 'browser-turnstile-public-key',
  VITE_YANDEX_MAPS_API_KEY: 'browser-yandex-public-key',
  VITE_CDEK_FROM_CODE: '123456',
  VITE_CDEK_DEFAULT_LOCATION: 'Krasnoyarsk'
});
