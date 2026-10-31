import crypto from 'crypto';
import { resilientFetch } from './httpClient';
import { TURNSTILE_SITEVERIFY_URL, turnstileTransport } from './turnstileTransport';
import type { Dispatcher } from 'undici';

type TurnstileVerifyResult = {
  success?: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  'error-codes'?: string[];
};

const getTurnstileSecretKey = (
  environment: Record<string, string | undefined> = process.env
) => environment.TURNSTILE_SECRET_KEY?.trim() ?? '';
const isProduction = (
  environment: Record<string, string | undefined> = process.env
) => (environment.NODE_ENV ?? '').trim().toLowerCase() === 'production';

export const isTurnstileEnabled = () => Boolean(getTurnstileSecretKey());

export const assertTurnstileConfiguration = (
  environment: Record<string, string | undefined> = process.env
) => {
  if (isProduction(environment) && !getTurnstileSecretKey(environment)) {
    throw new Error('TURNSTILE_SECRET_KEY is required in production');
  }
};

export const createTurnstileVerifier = (options: {
  environment?: () => Record<string, string | undefined>;
  request?: typeof resilientFetch;
  dispatcher?: () => Dispatcher;
  log?: (code: 'request_failed' | 'verification_rejected' | 'action_mismatch', status?: number) => void;
} = {}) => async (
  token: string,
  remoteIp?: string,
  expectedAction?: string
) => {
  const secret = getTurnstileSecretKey((options.environment ?? (() => process.env))());
  if (!secret) {
    return;
  }

  const trimmedToken = token.trim();
  if (!trimmedToken) {
    throw new Error('Подтвердите, что вы не робот.');
  }

  const payload = new URLSearchParams();
  payload.set('secret', secret);
  payload.set('response', trimmedToken);
  if (remoteIp) {
    payload.set('remoteip', remoteIp);
  }
  payload.set('idempotency_key', crypto.randomUUID());

  const log = options.log ?? ((code, httpStatus) => console.warn('[turnstile]', JSON.stringify({
    event: 'turnstile_verification', code, ...(httpStatus === undefined ? {} : { httpStatus })
  })));
  let response: Response;
  try {
    response = await (options.request ?? resilientFetch)(TURNSTILE_SITEVERIFY_URL, {
      method: 'POST',
      redirect: 'error',
      dispatcher: (options.dispatcher ?? (() => turnstileTransport.dispatcher('business')))(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: payload.toString()
    }, {
      circuitKey: 'turnstile:siteverify',
      timeoutMs: 8_000,
      maxRetries: 2
    });
  } catch {
    log('request_failed');
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }

  let result: TurnstileVerifyResult;
  try { result = (await response.json()) as TurnstileVerifyResult; }
  catch {
    log('verification_rejected', response.status);
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }
  if (!response.ok || result?.success !== true) {
    log('verification_rejected', response.status);
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }

  if (expectedAction && result.action && result.action !== expectedAction) {
    log('action_mismatch', response.status);
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }
};

export const verifyTurnstileToken = createTurnstileVerifier();
