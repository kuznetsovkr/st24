import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const MAX_BODY_BYTES = 65_536;

export const validateReadinessResponse = async (response, { now, startedAt }) => {
  if (response.status !== 200) throw new Error('readiness HTTP status');
  if (!/application\/json/i.test(response.headers.get('content-type') ?? '')) {
    throw new Error('readiness content type');
  }
  if (!/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) {
    throw new Error('readiness cache policy');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('readiness body missing');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('readiness body too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const report = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const checkedAt = Date.parse(report?.checkedAt);
  if (
    report?.status !== 'ok' ||
    report?.checks?.postgres?.status !== 'ok' ||
    report?.checks?.uploads?.status !== 'ok' ||
    !Number.isFinite(checkedAt) || checkedAt < startedAt ||
    checkedAt > now + 5_000 || now - checkedAt > 60_000
  ) throw new Error('readiness report unhealthy or predates restart');
  return report;
};

export const checkDeploymentReadiness = async ({ localOrigin, publicOrigin, startedAt, requireInstanceId = true }, fetcher = fetch) => {
  const local = new URL(localOrigin);
  const publicUrl = new URL(publicOrigin);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' ||
      publicUrl.protocol !== 'https:' || !Number.isSafeInteger(startedAt) || startedAt <= 0) {
    throw new Error('invalid deployment probe configuration');
  }
  // Probe the restarted process directly, then its public reverse-proxy route.
  // A unique query also avoids reusing a pre-restart intermediary cache entry.
  let localReport;
  for (const origin of [local, publicUrl]) {
    const url = new URL('/api/health/ready', origin);
    url.searchParams.set('deploy_probe', randomUUID());
    const response = await fetcher(url, {
      cache: 'no-store', redirect: 'error',
      headers: { 'Cache-Control': 'no-cache, no-store' },
      signal: AbortSignal.timeout(5_000)
    });
    const report = await validateReadinessResponse(response, { now: Date.now(), startedAt });
    if (requireInstanceId && !/^[0-9a-f-]{36}$/i.test(report.instanceId ?? '')) {
      throw new Error('readiness process identity missing');
    }
    if (!localReport) localReport = report;
    else if (report.instanceId !== localReport.instanceId) {
      throw new Error('public route points to a different process');
    }
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkDeploymentReadiness({
      localOrigin: process.env.LOCAL_API_URL,
      publicOrigin: process.env.PUBLIC_API_URL,
      startedAt: Number(process.env.RESTART_STARTED_AT_MS),
      requireInstanceId: process.env.READINESS_REQUIRE_INSTANCE_ID !== '0'
    });
  } catch {
    process.exitCode = 1;
  }
}
