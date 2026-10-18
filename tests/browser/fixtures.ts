import { expect, test as base } from '@playwright/test';
import type { Category, Product } from '../../client/src/api.ts';
import { browserOrigin } from './settings.mjs';
import { requestTarget } from './network-policy.mjs';

const timestamp = '2026-01-01T00:00:00.000Z';
export const category: Category = {
  slug: 'browser-test-parts', name: 'Тестовые запчасти', image: null,
  createdAt: timestamp, updatedAt: timestamp
};
export const product: Product = {
  id: '00000000-0000-4000-8000-000000000001', name: 'Тестовое уплотнение Karcher',
  sku: 'TEST-100', description: 'Синтетический товар для браузерных тестов.',
  priceCents: 125000, category: category.slug, images: [],
  showInSlider: true, sliderOrder: 0, weightGrams: 100,
  lengthCm: 5, widthCm: 5, heightCm: 2, stock: 3, isHidden: false,
  createdAt: timestamp, updatedAt: timestamp
};
export const unavailableProduct: Product = {
  ...product, id: '00000000-0000-4000-8000-000000000002',
  name: 'Тестовая деталь без остатка', sku: 'TEST-200', stock: 0
};

type Reply = {status?: number; json: unknown};
type BrowserHarness = {
  overrides: Map<string, Reply>;
  expectedAssetFailures: RegExp[];
  expectedPageErrors: RegExp[];
};

export const test = base.extend<{harness: BrowserHarness}>({
  harness: [async ({context, page}, use) => {
    const harness: BrowserHarness = {overrides: new Map(), expectedAssetFailures: [], expectedPageErrors: []};
    const unexpectedRequests: string[] = [];
    const assetFailures: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const isAsset = (url: string) => /\/assets\/[^/?]+\.(?:js|css)(?:\?|$)/.test(url);
    page.on('requestfailed', request => {if (isAsset(request.url())) assetFailures.push(request.url());});
    page.on('response', response => {if (response.status() >= 400 && isAsset(response.url())) assetFailures.push(response.url());});
    await context.routeWebSocket('**/*', socket => {
      unexpectedRequests.push('WebSocket is forbidden');
      socket.close();
    });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const method = request.method();
      const target = requestTarget(request.url(), method);
      // No live backend, remote assets, OTP, orders, payments or telemetry.
      if (target === 'blocked') {
        unexpectedRequests.push(`Forbidden request: ${method} ${url.origin}${url.pathname}`);
        await route.abort('blockedbyclient');
        return;
      }
      if (target === 'mock-font') {
        await route.fulfill({contentType: 'text/css', body: '/* Synthetic font stylesheet; no external requests. */'});
        return;
      }
      if (target === 'mock-widget') {
        await route.fulfill({contentType: 'text/javascript', body: '/* CDEK is mocked; no live widget or provider requests. */'});
        return;
      }
      if (target === 'mock-api') {
        const headers = {
          'access-control-allow-origin': browserOrigin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'cache-control': 'no-store'
        };
        if (method === 'OPTIONS') {await route.fulfill({status: 204, headers}); return;}
        let reply = harness.overrides.get(url.pathname);
        if (!reply) {
          const products = [product, unavailableProduct];
          switch (url.pathname) {
            case '/api/auth/me': reply = {status: 401, json: {error: 'Synthetic guest session'}}; break;
            case '/api/categories': reply = {json: {items: [category]}}; break;
            case '/api/products': reply = {json: {items: products, total: 2, limit: 30, offset: 0, hasMore: false, nextOffset: null}}; break;
            case `/api/products/${product.id}`: reply = {json: product}; break;
            case `/api/products/${unavailableProduct.id}`: reply = {json: unavailableProduct}; break;
            case '/api/banners/home': reply = {json: {banner: {key: 'home', desktopImage: null, mobileImage: null, createdAt: timestamp, updatedAt: timestamp}}}; break;
            case '/api/box-types': reply = {json: {items: []}}; break;
            case '/api/delivery-providers': reply = {json: {items: []}}; break;
            default:
              // A new API dependency must be modeled explicitly, not silently faked.
              unexpectedRequests.push(`Unknown fixture API: ${method} ${url.pathname}`);
              await route.abort('blockedbyclient');
              return;
          }
        }
        await route.fulfill({status: reply.status ?? 200, headers, contentType: 'application/json', body: JSON.stringify(reply.json)});
        return;
      }
      if (target === 'local-static') {
        await route.continue();
        return;
      }
      unexpectedRequests.push(`External request blocked: ${url.origin}${url.pathname}`);
      await route.abort('blockedbyclient');
    });
    await use(harness);
    expect(unexpectedRequests, 'Unexpected network access; no request was forwarded').toEqual([]);
    expect(assetFailures.filter(url => !harness.expectedAssetFailures.some(pattern => pattern.test(url))), 'Unexpected failed JS/CSS assets').toEqual([]);
    expect(pageErrors.filter(message => !harness.expectedPageErrors.some(pattern => pattern.test(message))), 'Unexpected browser JavaScript errors').toEqual([]);
  }, {auto: true}]
});

export {expect} from '@playwright/test';
