import type { Page } from '@playwright/test';
import { test, expect, category, product, unavailableProduct } from './fixtures';

async function openCatalog(page: Page, isMobile: boolean) {
  if (isMobile) {
    await page.getByRole('button', {name: 'Открыть меню', exact: true}).click();
    await page.getByRole('dialog').getByRole('link', {name: 'Каталог', exact: true}).click();
  } else {
    await page.locator('.app-header').getByRole('link', {name: 'Каталог', exact: true}).click();
  }
}

test('production bundle renders home and loads featured products', async ({page}) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Купить запчасти для Karcher');
  await expect(page.locator('main').getByRole('link', {name: product.name, exact: true}).first()).toBeVisible();
  await expect(page.locator('.app-header')).toHaveCSS('display', 'flex');
});

test('catalog → category → product → cart; quantities, persistence and guest auth gate', async ({page, isMobile}) => {
  await page.goto('/');
  await openCatalog(page, isMobile);
  await expect(page.getByRole('heading', {name: 'Каталог запчастей', exact: true})).toBeVisible();
  await page.getByRole('link', {name: category.name}).click();
  await expect(page).toHaveURL(`/catalog/${category.slug}`);
  await page.getByRole('link', {name: product.name, exact: true}).click();
  await expect(page.getByRole('heading', {name: product.name, exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'В корзину', exact: true}).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('1');
  await page.goto('/cart');
  await expect(page.getByRole('heading', {name: 'Корзина', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: product.name, exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Увеличить количество', exact: true}).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  await expect(page.locator('.cart-summary .price')).toContainText('2 500');
  await page.reload();
  await expect(page.getByRole('spinbutton')).toHaveValue('2');
  await page.getByRole('button', {name: 'Увеличить количество', exact: true}).click();
  await expect(page.getByRole('spinbutton')).toHaveValue('3');
  await expect(page.getByRole('button', {name: 'Увеличить количество', exact: true})).toBeDisabled();
  await page.getByRole('button', {name: 'Оформление заказа', exact: true}).click();
  await expect(page.getByText('Для входа подтвердите номер бесплатным звонком.', {exact: true})).toBeVisible();
  await expect(page.getByLabel('Телефон', {exact: true})).toBeVisible();
});

test('cart removal renders the empty-cart state', async ({page}) => {
  await page.goto(`/product/${product.id}`);
  await page.getByRole('button', {name: 'В корзину', exact: true}).click();
  await page.goto('/cart');
  await page.getByRole('button', {name: 'Удалить', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Корзина пустая', exact: true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Корзина пустая', exact: true})).toBeVisible();
});

test('out-of-stock product cannot be added to cart', async ({page}) => {
  await page.goto(`/product/${unavailableProduct.id}`);
  await expect(page.getByRole('heading', {name: unavailableProduct.name, exact: true})).toBeVisible();
  await expect(page.locator('.stock-badge')).toHaveText('Нет в наличии');
  await expect(page.getByRole('button', {name: 'В корзину', exact: true})).toHaveCount(0);
});

test('direct checkout URL does not bypass guest authentication', async ({page}) => {
  await page.goto('/checkout');
  await expect(page.getByRole('heading', {name: 'Войдите, чтобы продолжить', exact: true})).toBeVisible();
});

test('category API outage shows an error rather than an endless loader', async ({page, harness}) => {
  harness.overrides.set('/api/categories', {status: 503, json: {error: 'Synthetic API outage'}});
  await page.goto('/catalog');
  await expect(page.getByText('Не удалось загрузить категории.', {exact: true})).toBeVisible();
  await expect(page.getByText('Загрузка категорий...', {exact: true})).toHaveCount(0);
});

test('missing product has a useful not-found page', async ({page, harness}) => {
  const id = '00000000-0000-4000-8000-000000000099';
  harness.overrides.set(`/api/products/${id}`, {status: 404, json: {error: 'Synthetic missing product'}});
  await page.goto(`/product/${id}`);
  await expect(page.getByRole('heading', {name: 'Товар не найден', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'В каталог', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Каталог запчастей', exact: true})).toBeVisible();
});

test('failed lazy route displays recovery UI and reload really recovers', async ({page, isMobile, harness}) => {
  harness.expectedAssetFailures.push(/\/assets\/Catalog-[^/]+\.js$/);
  harness.expectedPageErrors.push(/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i);
  let blocked = 0;
  await page.route('**/assets/Catalog-*.js', async route => {blocked++; await route.abort('failed');}, {times: 1});
  await page.goto('/');
  await openCatalog(page, isMobile);
  await expect(page.getByText('Не удалось загрузить страницу. Проверьте интернет и обновите сайт.', {exact: true})).toBeVisible();
  expect(blocked).toBe(1);
  await page.getByRole('button', {name: 'Обновить страницу', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Каталог запчастей', exact: true})).toBeVisible();
  await expect(page.getByRole('link', {name: category.name})).toBeVisible();
});

test('unknown SPA route renders the application 404', async ({page}) => {
  await page.goto('/browser-test-missing-route');
  await expect(page.getByRole('heading', {name: 'Страница не найдена', exact: true})).toBeVisible();
});

test('a stalled lazy chunk times out and the reload action recovers', async ({page, isMobile, harness}) => {
  harness.expectedAssetFailures.push(/\/assets\/Catalog-[^/]+\.js$/);
  harness.expectedPageErrors.push(/Route chunk load timeout \(15000 ms\)/);
  await page.clock.install();
  let blocked = false;
  let unblock = () => {};
  const held = new Promise<void>(resolve => {unblock = resolve;});
  await page.route('**/assets/Catalog-*.js', async route => {
    blocked = true;
    await held;
    await route.abort('failed');
  }, {times: 1});
  try {
    await page.goto('/');
    await openCatalog(page, isMobile);
    await expect.poll(() => blocked).toBe(true);
    await page.clock.fastForward(16_000);
    await expect(page.getByText('Не удалось загрузить страницу. Проверьте интернет и обновите сайт.', {exact: true})).toBeVisible();
  } finally {
    unblock();
  }
  await page.getByRole('button', {name: 'Обновить страницу', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Каталог запчастей', exact: true})).toBeVisible();
});
