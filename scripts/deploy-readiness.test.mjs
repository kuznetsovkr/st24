import assert from 'node:assert/strict';
import test from 'node:test';
import { checkDeploymentReadiness, validateReadinessResponse } from './deploy-readiness.mjs';

const now = Date.now();
const report = {
  instanceId: '01234567-0123-4123-8123-0123456789ab',
  status: 'ok', checkedAt: new Date(now).toISOString(),
  checks: { postgres: { status: 'ok' }, uploads: { status: 'ok' } }
};
const response = (body = report, headers = {}) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }
});

test('rejects healthy but pre-restart or cacheable responses', async () => {
  await assert.rejects(validateReadinessResponse(response(), { now, startedAt: now + 1 }), /predates/);
  await assert.rejects(validateReadinessResponse(response(report, { 'Cache-Control': 'public, max-age=60' }),
    { now, startedAt: now - 1 }), /cache policy/);
});

test('rejects unavailable dependencies, invalid JSON and oversized bodies', async () => {
  await assert.rejects(validateReadinessResponse(response({ ...report, status: 'error' }),
    { now, startedAt: now - 1 }), /unhealthy/);
  await assert.rejects(validateReadinessResponse(response({ ...report,
    checks: { postgres: { status: 'error' }, uploads: { status: 'ok' } } }),
  { now, startedAt: now - 1 }), /unhealthy/);
  await assert.rejects(validateReadinessResponse(response('x'.repeat(65_536)),
    { now, startedAt: now - 1 }), /too large/);
});

test('requires both the direct process and the public route to be ready', async () => {
  const visited = [];
  await checkDeploymentReadiness({ localOrigin: 'http://127.0.0.1:4000',
    publicOrigin: 'https://shop.example', startedAt: now - 1 }, async (url, options) => {
    visited.push(url.origin);
    assert.equal(options.redirect, 'error');
    assert.ok(url.searchParams.get('deploy_probe'));
    return response();
  });
  assert.deepEqual(visited, ['http://127.0.0.1:4000', 'https://shop.example']);
  await assert.rejects(checkDeploymentReadiness({ localOrigin: 'http://127.0.0.1:4000',
    publicOrigin: 'https://shop.example', startedAt: now - 1 }, async (url) => {
    if (url.protocol === 'http:') throw new Error('process unavailable');
    return response();
  }), /process unavailable/);
});

test('rejects a healthy public response from another process or a pre-iteration API', async () => {
  const config = { localOrigin: 'http://127.0.0.1:4000', publicOrigin: 'https://shop.example', startedAt: now - 1 };
  await assert.rejects(checkDeploymentReadiness(config, async (url) => response({ ...report,
    instanceId: url.protocol === 'http:' ? report.instanceId : '98765432-0123-4123-8123-0123456789ab'
  })), /different process/);
  await assert.rejects(checkDeploymentReadiness(config, async () => response({ ...report, instanceId: undefined })),
    /identity missing/);
  // Rolling back the first rollout must still support the previous health API.
  await checkDeploymentReadiness({ ...config, requireInstanceId: false },
    async () => response({ ...report, instanceId: undefined }));
});
