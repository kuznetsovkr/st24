import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { resetHttpCircuits, resilientFetch } from './httpClient';

const listen = async (server: Server) => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
};

const waitFor = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

test('a custom caller abort stops an in-flight request without retrying or opening the circuit', async (t) => {
  resetHttpCircuits();
  let requestCount = 0;
  let notifyFirstRequest: (() => void) | undefined;
  const firstRequest = new Promise<void>((resolve) => {
    notifyFirstRequest = resolve;
  });
  const server = createServer((_request, response) => {
    requestCount += 1;
    if (requestCount === 1) {
      notifyFirstRequest?.();
      return;
    }
    response.writeHead(200).end('ok');
  });
  const origin = await listen(server);
  t.after(() => close(server));

  const controller = new AbortController();
  const shutdownReason = new Error('server_shutdown');
  const pendingRequest = resilientFetch(
    `${origin}/in-flight`,
    { signal: controller.signal },
    {
      circuitKey: 'http-client-test-in-flight-abort',
      timeoutMs: 5_000,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 20,
      circuitFailureThreshold: 1,
      circuitOpenMs: 5_000
    }
  );

  await firstRequest;
  controller.abort(shutdownReason);

  await assert.rejects(pendingRequest, (error: unknown) => error === shutdownReason);
  assert.equal(requestCount, 1);

  const recoveryResponse = await resilientFetch(
    `${origin}/after-abort`,
    {},
    {
      circuitKey: 'http-client-test-in-flight-abort',
      timeoutMs: 1_000,
      maxRetries: 0,
      circuitFailureThreshold: 1,
      circuitOpenMs: 5_000
    }
  );
  assert.equal(recoveryResponse.status, 200);
  assert.equal(requestCount, 2);
});

test('a caller abort interrupts a Retry-After delay before another attempt', { timeout: 5_000 }, async (t) => {
  resetHttpCircuits();
  let requestCount = 0;
  let notifyRetryResponse: (() => void) | undefined;
  const retryResponseSent = new Promise<void>((resolve) => {
    notifyRetryResponse = resolve;
  });
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(503, { 'retry-after': '2' }).end();
    notifyRetryResponse?.();
  });
  const origin = await listen(server);
  t.after(() => close(server));

  const controller = new AbortController();
  const shutdownReason = new Error('server_shutdown');
  const pendingRequest = resilientFetch(
    `${origin}/retry-after`,
    { signal: controller.signal },
    {
      circuitKey: 'http-client-test-retry-delay-abort',
      timeoutMs: 1_000,
      maxRetries: 2,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 3_000,
      circuitFailureThreshold: 1,
      circuitOpenMs: 5_000
    }
  );

  await retryResponseSent;
  await waitFor(50);
  const abortedAt = Date.now();
  controller.abort(shutdownReason);

  await assert.rejects(pendingRequest, (error: unknown) => error === shutdownReason);
  assert.ok(Date.now() - abortedAt < 500);
  await waitFor(50);
  assert.equal(requestCount, 1);
});
