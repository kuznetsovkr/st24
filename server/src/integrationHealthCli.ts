import dotenv from 'dotenv';
import { createIntegrationHealthChecker, type ShippingModes } from './integrationHealth';

// Explicit operator command; importing the checker never loads dotenv or starts a worker.
const main = async () => {
  const file = process.env.INTEGRATION_HEALTH_ENV_FILE?.trim();
  if (file && dotenv.config({ path: file, quiet: true }).error) {
    throw new Error('Environment unavailable');
  }
  const check = createIntegrationHealthChecker({ shippingModes: async (signal) => {
    const site = new URL(process.env.PUBLIC_SITE_URL ?? 'https://xn---24-3edf.xn--p1ai');
    if (site.protocol !== 'https:' || site.username || site.password || site.search || site.hash || site.pathname !== '/') {
      throw new Error('Invalid site origin');
    }
    const response = await fetch(new URL('/api/delivery-providers', site), { signal, redirect: 'error' });
    if (!response.ok) throw new Error('Shipping configuration unavailable');
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('items' in data) || !Array.isArray(data.items)) throw new Error('Invalid shipping configuration');
    const result: Partial<ShippingModes> = {};
    for (const item of data.items) {
      if (item && ['cdek', 'dellin', 'russian_post'].includes(item.key) && typeof item.isEnabled === 'boolean') {
        result[item.key as keyof ShippingModes] = item.isEnabled;
      }
    }
    if (Object.keys(result).length !== 3) throw new Error('Incomplete shipping configuration');
    return result as ShippingModes;
  } });
  const report = await check();
  console.log(JSON.stringify(report));
  process.exitCode = report.availability === 'ok' ? 0 : 1;
};

void main().catch(() => {
  console.error('integration-health: configuration_or_probe_failed');
  process.exitCode = 2;
});
