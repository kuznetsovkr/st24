import { randomUUID } from 'crypto';

const YOOKASSA_BASE_URL = 'https://api.yookassa.ru/v3';

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parsePositiveIntEnv = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

const getShopId = () => trimToUndefined(process.env.YOOKASSA_SHOP_ID);
const getSecretKey = () => trimToUndefined(process.env.YOOKASSA_SECRET_KEY);
const getApiBaseUrl = () => trimToUndefined(process.env.YOOKASSA_API_BASE_URL) ?? YOOKASSA_BASE_URL;

export const getYooKassaWebhookSecret = () =>
  trimToUndefined(process.env.YOOKASSA_WEBHOOK_SECRET);

export const getYooKassaReturnBaseUrl = () =>
  trimToUndefined(process.env.YOOKASSA_RETURN_BASE_URL);

export const getYooKassaFixedAmountCents = () =>
  parsePositiveIntEnv(process.env.YOOKASSA_FIXED_AMOUNT_CENTS, 100);

export const isYooKassaUseOrderTotal = () =>
  (process.env.YOOKASSA_USE_ORDER_TOTAL ?? '').trim().toLowerCase() === 'true';

export const isYooKassaConfigured = () => Boolean(getShopId() && getSecretKey());

const getAuthHeaderValue = () => {
  const shopId = getShopId();
  const secretKey = getSecretKey();
  if (!shopId || !secretKey) {
    throw new Error('YOOKASSA credentials are not configured');
  }
  return `Basic ${Buffer.from(`${shopId}:${secretKey}`).toString('base64')}`;
};

const toRubleAmountValue = (amountCents: number) => (amountCents / 100).toFixed(2);

type YooKassaApiError = {
  type?: string;
  id?: string;
  code?: string;
  description?: string;
};

const parseYooKassaErrorMessage = (status: number, payload: unknown) => {
  if (payload && typeof payload === 'object') {
    const typed = payload as YooKassaApiError;
    if (typed.description) {
      return `YooKassa ${status}: ${typed.description}`;
    }
  }
  return `YooKassa request failed with status ${status}`;
};

const requestYooKassa = async <T>(
  endpoint: string,
  options: RequestInit,
  idempotenceKey?: string
): Promise<T> => {
  const headers: Record<string, string> = {
    Authorization: getAuthHeaderValue(),
    'Content-Type': 'application/json',
    ...(idempotenceKey ? { 'Idempotence-Key': idempotenceKey } : {})
  };

  const response = await fetch(`${getApiBaseUrl()}${endpoint}`, {
    ...options,
    headers
  });

  const rawBody = await response.text();
  let parsedBody: unknown = null;
  if (rawBody) {
    try {
      parsedBody = JSON.parse(rawBody) as unknown;
    } catch {
      parsedBody = null;
    }
  }

  if (!response.ok) {
    throw new Error(parseYooKassaErrorMessage(response.status, parsedBody));
  }

  return parsedBody as T;
};

export type YooKassaPayment = {
  id: string;
  status: string;
  paid?: boolean;
  amount: {
    value: string;
    currency: string;
  };
  confirmation?: {
    type?: string;
    confirmation_url?: string;
  };
  metadata?: Record<string, string>;
};

type CreateYooKassaPaymentInput = {
  amountCents: number;
  returnUrl: string;
  description: string;
  metadata: Record<string, string>;
};

export const createYooKassaPayment = async (
  input: CreateYooKassaPaymentInput
): Promise<YooKassaPayment> => {
  const body = {
    amount: {
      value: toRubleAmountValue(input.amountCents),
      currency: 'RUB'
    },
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: input.returnUrl
    },
    description: input.description,
    metadata: input.metadata
  };

  return requestYooKassa<YooKassaPayment>(
    '/payments',
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    randomUUID()
  );
};

export const fetchYooKassaPayment = async (paymentId: string): Promise<YooKassaPayment> =>
  requestYooKassa<YooKassaPayment>(`/payments/${paymentId}`, {
    method: 'GET'
  });
