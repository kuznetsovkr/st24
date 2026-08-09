import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';
import {
  createLivenessReport,
  createCachedReadinessChecker,
  runReadinessChecks,
  type ReadinessReport,
  type HealthFileSystem
} from './health';

const createMemoryFileSystem = (options?: {
  readValue?: string;
  readError?: Error;
  removeError?: Error;
}) => {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const fileSystem: HealthFileSystem = {
    writeFile: async (filePath, contents) => {
      calls.push(`write:${filePath}`);
      files.set(filePath, contents);
    },
    readFile: async (filePath) => {
      calls.push(`read:${filePath}`);
      if (options?.readError) throw options.readError;
      return options?.readValue ?? files.get(filePath) ?? '';
    },
    removeFile: async (filePath) => {
      calls.push(`remove:${filePath}`);
      if (options?.removeError) {
        throw options.removeError;
      }
      files.delete(filePath);
    }
  };
  return { fileSystem, files, calls };
};

test('createLivenessReport does not touch dependencies', () => {
  const report = createLivenessReport(
    () => Date.parse('2026-08-08T00:00:00.000Z'),
    () => 12.6
  );

  assert.deepEqual(report, {
    status: 'ok',
    checkedAt: '2026-08-08T00:00:00.000Z',
    uptimeSeconds: 13,
    checks: { process: { status: 'ok', latencyMs: 0 } }
  });
});

test('health routes preserve legacy contract and expose uncached liveness JSON', async () => {
  let readinessReport: ReadinessReport = {
    status: 'ok',
    checkedAt: '2026-08-08T00:00:00.000Z',
    durationMs: 2,
    checks: {
      postgres: { status: 'ok', latencyMs: 1 },
      uploads: { status: 'ok', latencyMs: 1 }
    }
  };
  const server = createApp({ readinessCheck: async () => readinessReport }).listen(
    0,
    '127.0.0.1'
  );
  await new Promise<void>((resolvePromise) => server.once('listening', resolvePromise));
  const port = (server.address() as AddressInfo).port;
  const request = (pathname: string) =>
    new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolvePromise, reject) => {
        http
          .get({ host: '127.0.0.1', port, path: pathname }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolvePromise({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8')
              })
            );
          })
          .on('error', reject);
      }
    );

  try {
    const legacy = await request('/api/health');
    assert.equal(legacy.statusCode, 200);
    assert.deepEqual(JSON.parse(legacy.body), { status: 'ok' });

    const live = await request('/api/health/live');
    assert.equal(live.statusCode, 200);
    assert.equal(live.headers['cache-control'], 'no-store');
    assert.match(String(live.headers['content-type']), /^application\/json/);
    const payload = JSON.parse(live.body) as ReturnType<typeof createLivenessReport>;
    assert.equal(payload.status, 'ok');
    assert.equal(payload.checks.process.status, 'ok');
    assert.ok(Number.isFinite(Date.parse(payload.checkedAt)));

    const ready = await request('/api/health/ready');
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.headers['cache-control'], 'no-store');
    assert.equal(JSON.parse(ready.body).status, 'ok');

    readinessReport = {
      ...readinessReport,
      status: 'error',
      checks: {
        postgres: { status: 'error', latencyMs: 1, reason: 'check_failed' },
        uploads: { status: 'ok', latencyMs: 1 }
      }
    };
    const notReady = await request('/api/health/ready');
    assert.equal(notReady.statusCode, 503);
    assert.equal(notReady.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(notReady.body).checks.postgres, {
      status: 'error',
      latencyMs: 1,
      reason: 'check_failed'
    });
  } finally {
    await new Promise<void>((resolvePromise, reject) =>
      server.close((error) => (error ? reject(error) : resolvePromise()))
    );
  }
});

test('readiness succeeds after PostgreSQL and uploads round trip', async () => {
  const memory = createMemoryFileSystem();
  const queries: string[] = [];

  const report = await runReadinessChecks({
    queryDatabase: async (text) => {
      queries.push(text);
    },
    uploadsDir: 'virtual-uploads',
    timeoutMs: 100,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.status, 'ok');
  assert.equal(report.checks.postgres.status, 'ok');
  assert.equal(report.checks.uploads.status, 'ok');
  assert.deepEqual(queries, ['SELECT 1']);
  assert.equal(memory.files.size, 0);
  assert.ok(memory.calls.some((call) => call.startsWith('remove:')));
});

test('real uploads canary is private and leaves no file behind', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'her-health-uploads-'));
  let canaryPath = '';
  let canaryMode = 0;
  try {
    const fileSystem: Partial<HealthFileSystem> = {
      removeFile: async (filePath) => {
        canaryPath = filePath;
        canaryMode = (await stat(filePath)).mode & 0o777;
        await unlink(filePath);
      }
    };
    const report = await runReadinessChecks({
      queryDatabase: async () => undefined,
      uploadsDir: directory,
      timeoutMs: 1_000,
      generateId: () => 'real-probe',
      fileSystem
    });

    assert.equal(report.checks.uploads.status, 'ok');
    assert.match(canaryPath, /\.health-real-probe\.tmp$/);
    if (process.platform !== 'win32') assert.equal(canaryMode, 0o600);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('readiness reports a safe PostgreSQL failure and still checks uploads', async () => {
  const memory = createMemoryFileSystem();
  const secret = 'postgres://monitor:super-secret@private-db/internal';

  const report = await runReadinessChecks({
    queryDatabase: async () => {
      throw new Error(secret);
    },
    uploadsDir: 'virtual-uploads',
    timeoutMs: 100,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.status, 'error');
  assert.equal(report.checks.postgres.status, 'error');
  assert.equal(report.checks.uploads.status, 'ok');
  assert.ok(memory.calls.some((call) => call.startsWith('write:')));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test('readiness times out a stalled dependency', async () => {
  const memory = createMemoryFileSystem();

  const report = await runReadinessChecks({
    queryDatabase: () => new Promise(() => undefined),
    uploadsDir: 'virtual-uploads',
    timeoutMs: 5,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.status, 'error');
  assert.equal(report.checks.postgres.status, 'error');
  if (report.checks.postgres.status === 'error') {
    assert.equal(report.checks.postgres.reason, 'timeout');
  }
  assert.equal(report.checks.uploads.status, 'ok');
});

test('readiness fails when the uploads marker does not round trip', async () => {
  const memory = createMemoryFileSystem({ readValue: 'wrong-marker' });

  const report = await runReadinessChecks({
    queryDatabase: async () => undefined,
    uploadsDir: 'virtual-uploads',
    timeoutMs: 100,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.status, 'error');
  assert.equal(report.checks.uploads.status, 'error');
  assert.equal(memory.files.size, 0);
  assert.ok(memory.calls.some((call) => call.startsWith('remove:')));
});

test('readiness still removes the canary after an uploads read failure', async () => {
  const memory = createMemoryFileSystem({ readError: new Error('read failed') });
  const report = await runReadinessChecks({
    queryDatabase: async () => undefined,
    uploadsDir: 'virtual-uploads',
    timeoutMs: 100,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.checks.uploads.status, 'error');
  assert.equal(memory.files.size, 0);
  assert.ok(memory.calls.some((call) => call.startsWith('remove:')));
});

test('a timed-out uploads operation is not overlapped by the next readiness probe', async () => {
  let writes = 0;
  let storedMarker = '';
  let resolveRead: ((value: string) => void) | undefined;
  let readSignal: AbortSignal | undefined;
  const fileSystem: HealthFileSystem = {
    writeFile: async (_filePath, contents) => {
      writes += 1;
      storedMarker = contents;
    },
    readFile: (_filePath, signal) => new Promise<string>((resolvePromise) => {
      readSignal = signal;
      resolveRead = resolvePromise;
    }),
    removeFile: async () => undefined
  };
  const options = {
    queryDatabase: async () => undefined,
    uploadsDir: 'virtual-uploads',
    timeoutMs: 5,
    generateId: () => 'probe-id',
    fileSystem
  };

  const first = await runReadinessChecks(options);
  assert.equal(readSignal?.aborted, true);
  const second = await runReadinessChecks(options);
  assert.equal(first.checks.uploads.status, 'error');
  assert.equal(second.checks.uploads.status, 'error');
  assert.equal(writes, 1);

  assert.ok(resolveRead);
  resolveRead(storedMarker);
  await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
});

test('readiness fails when the canary cannot be removed', async () => {
  const memory = createMemoryFileSystem({ removeError: new Error('cleanup failed') });

  const report = await runReadinessChecks({
    queryDatabase: async () => undefined,
    uploadsDir: 'virtual-uploads',
    timeoutMs: 100,
    generateId: () => 'probe-id',
    fileSystem: memory.fileSystem
  });

  assert.equal(report.status, 'error');
  assert.equal(report.checks.uploads.status, 'error');
  if (report.checks.uploads.status === 'error') {
    assert.equal(report.checks.uploads.reason, 'check_failed');
  }
});

test('cached readiness coalesces concurrent probes and expires after the TTL', async () => {
  let calls = 0;
  let currentTime = 1_000;
  const report: ReadinessReport = {
    status: 'ok',
    checkedAt: '2026-08-08T00:00:00.000Z',
    durationMs: 1,
    checks: {
      postgres: { status: 'ok', latencyMs: 1 },
      uploads: { status: 'ok', latencyMs: 1 }
    }
  };
  const checker = createCachedReadinessChecker(
    async () => {
      calls += 1;
      await Promise.resolve();
      return report;
    },
    () => 100,
    () => currentTime
  );

  const [first, second] = await Promise.all([checker(), checker()]);
  assert.equal(first, report);
  assert.equal(second, report);
  assert.equal(calls, 1);

  await checker();
  assert.equal(calls, 1);

  currentTime += 101;
  await checker();
  assert.equal(calls, 2);
});
