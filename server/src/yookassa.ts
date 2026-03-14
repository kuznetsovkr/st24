import { randomUUID } from 'crypto';
import { logIntegrationEvent } from './integrationEvents';
import { resilientFetch } from './httpClient';

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

const parseIntEnvInRange = (
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
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

export const getYooKassaReceiptTaxSystemCode = () =>
  parseIntEnvInRange(process.env.YOOKASSA_RECEIPT_TAX_SYSTEM_CODE, 2, 1, 6);

export const getYooKassaReceiptVatCode = () =>
  parseIntEnvInRange(process.env.YOOKASSA_RECEIPT_VAT_CODE, 1, 1, 6);

export const isYooKassaConfigured = () => Boolean(getShopId() && getSecretKey());

const getAuthHeaderValue = () => {
  const shopId = getShopId();
  const secretKey = getSecretKey();
  if (!shopId || !secretKey) {
    throw new Error('Данные YOOKASSA не настроены');
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
  idempotenceKey?: string,
  operation = 'request'
): Promise<T> => {
  const startedAt = Date.now();
  let statusCode: number | null = null;

  try {
    const headers: Record<string, string> = {
      Authorization: getAuthHeaderValue(),
      'Content-Type': 'application/json',
      ...(idempotenceKey ? { 'Idempotence-Key': idempotenceKey } : {})
    };

    const response = await resilientFetch(`${getApiBaseUrl()}${endpoint}`, {
      ...options,
      headers
    }, {
      circuitKey: `yookassa:${operation}`,
      timeoutMs: 15_000,
      maxRetries: 2
    });
    statusCode = response.status;

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

    void logIntegrationEvent({
      provider: 'yookassa',
      operation,
      attempt: 1,
      statusCode,
      latencyMs: Date.now() - startedAt,
      fallbackUsed: false
    });
    return parsedBody as T;
  } catch (error) {
    void logIntegrationEvent({
      provider: 'yookassa',
      operation,
      attempt: 1,
      statusCode,
      latencyMs: Date.now() - startedAt,
      fallbackUsed: false,
      error: error instanceof Error ? error.message : 'unknown_error'
    });
    throw error;
  }
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

export type YooKassaReceipt = {
  customer: {
    full_name?: string;
    email?: string;
    phone?: string;
  };
  items: Array<{
    description: string;
    quantity: string;
    amount: {
      value: string;
      currency: 'RUB';
    };
    vat_code: number;
    payment_mode?: 'full_prepayment' | 'prepayment' | 'advance' | 'full_payment' | 'partial_payment' | 'credit' | 'credit_payment';
    payment_subject?:
      | 'commodity'
      | 'excise'
      | 'job'
      | 'service'
      | 'gambling_bet'
      | 'gambling_prize'
      | 'lottery'
      | 'lottery_prize'
      | 'intellectual_activity'
      | 'payment'
      | 'agent_commission'
      | 'composite'
      | 'another';
  }>;
  tax_system_code?: number;
};

type CreateYooKassaPaymentInput = {
  amountCents: number;
  returnUrl: string;
  description: string;
  metadata: Record<string, string>;
  receipt: YooKassaReceipt;
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
    metadata: input.metadata,
    receipt: input.receipt
  };

  return requestYooKassa<YooKassaPayment>(
    '/payments',
    {
      method: 'POST',
      body: JSON.stringify(body)
    },
    randomUUID(),
    'create_payment'
  );
};

export const fetchYooKassaPayment = async (paymentId: string): Promise<YooKassaPayment> =>
  requestYooKassa<YooKassaPayment>(
    `/payments/${paymentId}`,
    {
      method: 'GET'
    },
    undefined,
    'fetch_payment'
  );
