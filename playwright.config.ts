import { defineConfig, devices } from '@playwright/test';
import { browserOrigin } from './tests/browser/settings.mjs';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 2,
  timeout: 30_000,
  expect: {timeout: 8_000},
  reporter: [['list'], ['html', {open: 'never'}]],
  use: {
    baseURL: browserOrigin,
    serviceWorkers: 'block',
    locale: 'ru-RU',
    timezoneId: 'Asia/Krasnoyarsk',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node tests/browser/server.mjs',
    url: browserOrigin,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: {signal: 'SIGTERM', timeout: 5_000}
  },
  projects: [
    {name: 'chromium-desktop', use: {...devices['Desktop Chrome']}},
    {name: 'chromium-mobile', use: {...devices['Pixel 7']}}
  ]
});
