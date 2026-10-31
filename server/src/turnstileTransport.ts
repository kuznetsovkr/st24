import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import { createShutdownFence } from './shutdownFence';

export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Targeted workaround for large hybrid ClientHello packets on this network path.
// Keep TLS 1.3, forward secrecy, CA/hostname verification and normal SNI.
// Other providers and the process-wide TLS defaults are deliberately untouched.
export const TURNSTILE_CONNECT_OPTIONS = Object.freeze({
  ecdhCurve: 'X25519:P-256',
  minVersion: 'TLSv1.2' as const,
  rejectUnauthorized: true,
  timeout: 3_000
});

type PoolKind = 'business' | 'probe';

export const createTurnstileTransport = (
  makeDispatcher: (kind: PoolKind) => Dispatcher = () => new Agent({ connect: TURNSTILE_CONNECT_OPTIONS })
) => {
  const fence = createShutdownFence();
  const pools = new Map<PoolKind, Dispatcher>();
  const dispatcher = (kind: PoolKind): Dispatcher => {
    fence.assertOpen('Turnstile transport is shutting down');
    let pool = pools.get(kind);
    if (!pool) { pool = makeDispatcher(kind); pools.set(kind, pool); }
    return pool;
  };
  return {
    dispatcher,
    // No URL argument: a caller cannot redirect this special TLS policy elsewhere.
    probe: async (init: RequestInit): Promise<Response> => undiciFetch(TURNSTILE_SITEVERIFY_URL, {
      ...init, redirect: 'error', dispatcher: dispatcher('probe')
    } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>,
    close: () => fence.closeOnce(async () => {
      const results = await Promise.allSettled([...pools.values()].map((pool) => pool.close()));
      if (results.some((result) => result.status === 'rejected')) throw new Error('turnstile_transport_close_failed');
    })
  };
};

export const turnstileTransport = createTurnstileTransport();
