import crypto from 'crypto';

type TurnstileVerifyResult = {
  success?: boolean;
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  'error-codes'?: string[];
};

const getTurnstileSecretKey = () => process.env.TURNSTILE_SECRET_KEY?.trim() ?? '';
const isProduction = () => (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

export const isTurnstileEnabled = () => Boolean(getTurnstileSecretKey());

export const assertTurnstileConfiguration = () => {
  if (isProduction() && !isTurnstileEnabled()) {
    throw new Error('TURNSTILE_SECRET_KEY is required in production');
  }
};

export const verifyTurnstileToken = async (
  token: string,
  remoteIp?: string,
  expectedAction?: string
) => {
  const secret = getTurnstileSecretKey();
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

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: payload.toString()
  });

  const result = (await response.json()) as TurnstileVerifyResult;
  if (!response.ok || !result.success) {
    console.warn('[Turnstile] verification failed', {
      status: response.status,
      result
    });
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }

  if (expectedAction && result.action && result.action !== expectedAction) {
    console.warn('[Turnstile] action mismatch', {
      expectedAction,
      action: result.action
    });
    throw new Error('Не удалось подтвердить проверку. Попробуйте еще раз.');
  }
};
