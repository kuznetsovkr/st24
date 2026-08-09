import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, parseMode, parseProxyUrl } from './config';
import { safeErrorDetail } from './http';

const validEnvironment = (): Record<string, string> => ({
  MONITOR_SITE_URL: 'https://shop.example.test/store',
  MONITOR_HOMEPAGE_MARKER: 'Expected shop title',
  MONITOR_HEARTBEAT_URL: 'https://heartbeat.example.test/monitor-secret',
  TELEGRAM_OUTBOUND_PROXY_URL: 'socks5://proxy-user:proxy-password@proxy.example.test:1080',
  TELEGRAM_BOT_TOKEN: 'main-secret-token',
  TELEGRAM_ORDERS_BOT_TOKEN: 'orders-secret-token',
  TELEGRAM_B2B_BOT_TOKEN: 'b2b-secret-token',
  MONITOR_TELEGRAM_BOT_TOKEN: 'monitor-secret-token',
  MONITOR_TELEGRAM_CHAT_ID: '-100123'
});

test('parseConfig derives public endpoints and keeps notifier independent', () => {
  const config = parseConfig(validEnvironment(), 'C:\\monitor-workdir');

  assert.equal(config.dnsHost, 'shop.example.test');
  assert.equal(config.liveUrl.href, 'https://shop.example.test/api/health/live');
  assert.equal(config.readyUrl.href, 'https://shop.example.test/api/health/ready');
  assert.equal(config.catalogUrl.href, 'https://shop.example.test/api/categories');
  assert.equal(config.telegramBots.length, 3);
  assert.equal(config.notifier.token, 'monitor-secret-token');
  assert.equal(config.notifier.proxyUrl, undefined);
  assert.equal(config.homepageMarker, 'Expected shop title');
  assert.notEqual(config.notifier.token, config.telegramBots[0]?.token);
});

test('parseConfig accepts configurable relative and absolute URLs', () => {
  const env = validEnvironment();
  env.MONITOR_CATALOG_URL = '/api/products?limit=1';
  env.MONITOR_READY_URL = 'https://api.example.test/ready';
  env.MONITOR_HEARTBEAT_URL = 'https://heartbeat.example.test/monitor-secret';
  const config = parseConfig(env);

  assert.equal(config.catalogUrl.href, 'https://shop.example.test/api/products?limit=1');
  assert.equal(config.readyUrl.href, 'https://api.example.test/ready');
  assert.equal(config.heartbeatUrl?.href, 'https://heartbeat.example.test/monitor-secret');
});

test('proxy parser accepts application proxy schemes and rejects others', () => {
  assert.equal(parseProxyUrl('http://proxy.example.test:8080', 'PROXY'), 'http://proxy.example.test:8080/');
  assert.equal(parseProxyUrl('socks5://proxy.example.test:1080', 'PROXY'), 'socks5://proxy.example.test:1080');
  assert.throws(() => parseProxyUrl('ftp://proxy.example.test', 'PROXY'), /must use http/);
});

test('configuration errors only identify a variable, not another secret', () => {
  const env = validEnvironment();
  delete env.TELEGRAM_ORDERS_BOT_TOKEN;
  assert.throws(() => parseConfig(env), {
    message: 'Missing required environment variable: TELEGRAM_ORDERS_BOT_TOKEN'
  });
});

test('notifier token must be independent from production bots', () => {
  const env = validEnvironment();
  env.MONITOR_TELEGRAM_BOT_TOKEN = env.TELEGRAM_ORDERS_BOT_TOKEN ?? '';
  assert.throws(() => parseConfig(env), {
    message: 'MONITOR_TELEGRAM_BOT_TOKEN must not match a production bot token'
  });
});

test('notifier proxy must not be the production proxy', () => {
  const env = validEnvironment();
  env.MONITOR_TELEGRAM_PROXY_URL = env.TELEGRAM_OUTBOUND_PROXY_URL ?? '';
  assert.throws(() => parseConfig(env), {
    message: 'MONITOR_TELEGRAM_PROXY_URL must differ from TELEGRAM_OUTBOUND_PROXY_URL'
  });
  assert.equal(
    safeErrorDetail(
      new Error('MONITOR_TELEGRAM_PROXY_URL must differ from TELEGRAM_OUTBOUND_PROXY_URL')
    ),
    'MONITOR_TELEGRAM_PROXY_URL must differ from TELEGRAM_OUTBOUND_PROXY_URL'
  );
});

test('production bot tokens must be unique', () => {
  const env = validEnvironment();
  env.TELEGRAM_B2B_BOT_TOKEN = env.TELEGRAM_BOT_TOKEN ?? '';
  assert.throws(() => parseConfig(env), {
    message: 'Production Telegram bot tokens must be unique'
  });
});

test('homepage marker is required and heartbeat must use HTTPS', () => {
  const missingMarker = validEnvironment();
  delete missingMarker.MONITOR_HOMEPAGE_MARKER;
  assert.throws(() => parseConfig(missingMarker), {
    message: 'Missing required environment variable: MONITOR_HOMEPAGE_MARKER'
  });

  const insecureHeartbeat = validEnvironment();
  insecureHeartbeat.MONITOR_HEARTBEAT_URL = 'http://heartbeat.example.test/secret';
  assert.throws(() => parseConfig(insecureHeartbeat), {
    message: 'MONITOR_HEARTBEAT_URL must use https'
  });
});

test('missing heartbeat requires an explicit local-only opt-out', () => {
  const env = validEnvironment();
  delete env.MONITOR_HEARTBEAT_URL;
  assert.throws(() => parseConfig(env), {
    message: 'Missing required environment variable: MONITOR_HEARTBEAT_URL'
  });

  env.MONITOR_ALLOW_NO_HEARTBEAT = 'true';
  assert.equal(parseConfig(env).heartbeatUrl, undefined);
});

test('parseMode supports one-shot check and summary modes', () => {
  assert.equal(parseMode([]), 'check');
  assert.equal(parseMode(['check']), 'check');
  assert.equal(parseMode(['summary']), 'summary');
  assert.throws(() => parseMode(['daemon']), /Usage/);
});
