import {
  estimateShippingCost,
  type ShippingEstimateInput,
  type ShippingEstimateParcel,
  type ShippingEstimateResult
} from './shippingEstimate';
import { logIntegrationEvent } from './integrationEvents';
import { resilientFetch } from './httpClient';

type ProviderApiResult = ShippingEstimateResult & {
  source: 'provider_api' | 'estimate_fallback';
};

type ProviderErrorWithStatus = Error & {
  statusCode?: number;
};

const createProviderApiError = (message: string, statusCode?: number) => {
  const error = new Error(message) as ProviderErrorWithStatus;
  if (typeof statusCode === 'number' && Number.isFinite(statusCode)) {
    error.statusCode = Math.trunc(statusCode);
  }
  return error;
};

const getStatusCodeFromError = (error: unknown) => {
  if (!error || typeof error !== 'object') {
    return null;
  }
  const code = (error as ProviderErrorWithStatus).statusCode;
  if (typeof code !== 'number' || !Number.isFinite(code)) {
    return null;
  }
  return Math.trunc(code);
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const formatDateInTimezone = (date: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }

  return `${year}-${month}-${day}`;
};

const safeNumber = (value: unknown) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value.replace(',', '.'))
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const normalizeParcels = (parcels: ShippingEstimateParcel[]) => {
  const normalized = parcels
    .map((parcel) => ({
      length: Math.max(1, Math.round(safeNumber(parcel.length))),
      width: Math.max(1, Math.round(safeNumber(parcel.width))),
      height: Math.max(1, Math.round(safeNumber(parcel.height))),
      weight: Math.max(1, Math.round(safeNumber(parcel.weight)))
    }))
    .filter(
      (parcel) =>
        Number.isFinite(parcel.length) &&
        Number.isFinite(parcel.width) &&
        Number.isFinite(parcel.height) &&
        Number.isFinite(parcel.weight)
    );

  return normalized.length > 0
    ? normalized
    : [
        {
          length: 30,
          width: 20,
          height: 15,
          weight: 500
        }
      ];
};

const getParcelStats = (parcels: ShippingEstimateParcel[]) => {
  const normalized = normalizeParcels(parcels);
  const actualWeightGrams = normalized.reduce((sum, parcel) => sum + parcel.weight, 0);
  const volumeCm3 = normalized.reduce(
    (sum, parcel) => sum + parcel.length * parcel.width * parcel.height,
    0
  );
  const volumetricWeightKg = volumeCm3 / 5000;
  return {
    normalized,
    actualWeightKg: Number((actualWeightGrams / 1000).toFixed(2)),
    volumetricWeightKg: Number(volumetricWeightKg.toFixed(2)),
    billedWeightKg: Number(
      Math.max(actualWeightGrams / 1000, volumetricWeightKg, 0.5).toFixed(2)
    )
  };
};

const parseJsonResponse = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const resolveRussianPostIndex = (input: ShippingEstimateInput) => {
  const fromIndex = trimToUndefined(process.env.RUSSIAN_POST_INDEX_FROM);
  if (!fromIndex || !/^\d{6}$/.test(fromIndex)) {
    throw new Error('RUSSIAN_POST_INDEX_FROM не настроен');
  }

  const code = (input.destinationCode ?? '').trim();
  if (/^\d{6}$/.test(code)) {
    return { fromIndex, toIndex: code };
  }

  const addressCandidate = `${input.destinationAddress ?? ''} ${input.destinationCity ?? ''}`;
  const indexMatch = addressCandidate.match(/\b(\d{6})\b/);
  if (indexMatch) {
    return { fromIndex, toIndex: indexMatch[1] };
  }

  throw new Error('Не указан индекс получателя Почты России');
};

const calculateDellinShipping = async (
  input: ShippingEstimateInput
): Promise<ProviderApiResult> => {
  const appKey = trimToUndefined(process.env.DELLIN_APP_KEY);
  if (!appKey) {
    throw new Error('DELLIN_APP_KEY не настроен');
  }

  const fromTerminalId = trimToUndefined(process.env.DELLIN_FROM_TERMINAL_ID);
  if (!fromTerminalId) {
    throw new Error('DELLIN_FROM_TERMINAL_ID не настроен');
  }

  const destinationTerminalId = (input.destinationCode ?? '').trim();
  if (!destinationTerminalId) {
    throw new Error('Не указан terminal ID получателя Деловых Линий');
  }

  const baseUrl =
    trimToUndefined(process.env.DELLIN_API_BASE_URL) ?? 'https://api.dellin.ru';
  const deliveryType = trimToUndefined(process.env.DELLIN_DELIVERY_TYPE) ?? 'auto';
  const dellinTimeZone =
    trimToUndefined(process.env.DELLIN_PRODUCE_DATE_TIMEZONE) ?? 'Asia/Krasnoyarsk';
  const today = formatDateInTimezone(new Date(), dellinTimeZone);

  const stats = getParcelStats(input.parcels);
  const maxParcel = stats.normalized.reduce(
    (acc, parcel) => ({
      length: Math.max(acc.length, parcel.length),
      width: Math.max(acc.width, parcel.width),
      height: Math.max(acc.height, parcel.height),
      weight: Math.max(acc.weight, parcel.weight)
    }),
    { length: 0, width: 0, height: 0, weight: 0 }
  );
  const totalVolumeM3 = stats.normalized.reduce(
    (sum, parcel) => sum + (parcel.length * parcel.width * parcel.height) / 1_000_000,
    0
  );
  const totalWeightKg = stats.normalized.reduce((sum, parcel) => sum + parcel.weight / 1000, 0);

  const payload = {
    appkey: appKey,
    delivery: {
      deliveryType: { type: deliveryType },
      derival: {
        produceDate: today,
        variant: 'terminal',
        terminalID: fromTerminalId
      },
      arrival: {
        variant: 'terminal',
        terminalID: destinationTerminalId
      }
    },
    cargo: {
      quantity: stats.normalized.length,
      length: Number((maxParcel.length / 100).toFixed(3)),
      width: Number((maxParcel.width / 100).toFixed(3)),
      height: Number((maxParcel.height / 100).toFixed(3)),
      weight: Number((maxParcel.weight / 1000).toFixed(3)),
      totalVolume: Number(totalVolumeM3.toFixed(4)),
      totalWeight: Number(totalWeightKg.toFixed(3))
    }
  };

  const response = await resilientFetch(`${baseUrl.replace(/\/$/, '')}/v2/calculator.json`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }, {
    circuitKey: 'provider_shipping:dellin_calculator',
    timeoutMs: 15_000,
    maxRetries: 2
  });

  const payloadRaw = await parseJsonResponse(response);
  const payloadRecord = asRecord(payloadRaw);

  if (!response.ok || !payloadRecord) {
    throw createProviderApiError(
      `Delovye Linii API request failed (${response.status})`,
      response.status
    );
  }

  const metadata = asRecord(payloadRecord.metadata);
  const metadataStatus = safeNumber(metadata?.status);
  if (Number.isFinite(metadataStatus) && metadataStatus !== 200) {
    const errors = Array.isArray(payloadRecord.errors) ? payloadRecord.errors : [];
    const firstError = asRecord(errors[0]);
    const message = String(firstError?.detail ?? firstError?.message ?? 'Unknown API error');
    throw createProviderApiError(`Delovye Linii API error: ${message}`, metadataStatus);
  }

  const data = asRecord(payloadRecord.data);
  const rawPrice = safeNumber(data?.price ?? data?.intercity);
  if (!Number.isFinite(rawPrice)) {
    throw new Error('API Деловых Линий не вернул стоимость доставки');
  }

  return {
    provider: 'dellin',
    estimatedCostCents: Math.round(rawPrice * 100),
    currency: 'RUB',
    billedWeightKg: stats.billedWeightKg,
    actualWeightKg: stats.actualWeightKg,
    volumetricWeightKg: stats.volumetricWeightKg,
    source: 'provider_api'
  };
};

const calculateRussianPostShipping = async (
  input: ShippingEstimateInput
): Promise<ProviderApiResult> => {
  const accessToken = trimToUndefined(process.env.RUSSIAN_POST_ACCESS_TOKEN);
  const userKey = trimToUndefined(process.env.RUSSIAN_POST_USER_KEY);
  if (!accessToken || !userKey) {
    throw new Error('RUSSIAN_POST_ACCESS_TOKEN или RUSSIAN_POST_USER_KEY не настроены');
  }

  const { fromIndex, toIndex } = resolveRussianPostIndex(input);
  const baseUrl =
    trimToUndefined(process.env.RUSSIAN_POST_API_BASE_URL) ??
    'https://otpravka-api.pochta.ru';
  const mailCategory = trimToUndefined(process.env.RUSSIAN_POST_MAIL_CATEGORY) ?? 'ORDINARY';
  const mailType = trimToUndefined(process.env.RUSSIAN_POST_MAIL_TYPE) ?? 'POSTAL_PARCEL';

  const stats = getParcelStats(input.parcels);
  const totalMassGrams = Math.max(
    1,
    Math.round(stats.actualWeightKg * 1000)
  );

  const payload = {
    'declared-value': 0,
    'index-from': fromIndex,
    'index-to': toIndex,
    'mail-category': mailCategory,
    'mail-type': mailType,
    mass: totalMassGrams
  };

  const response = await resilientFetch(`${baseUrl.replace(/\/$/, '')}/1.0/tariff`, {
    method: 'POST',
    headers: {
      Accept: 'application/json;charset=UTF-8',
      Authorization: `AccessToken ${accessToken}`,
      'X-User-Authorization': `Basic ${userKey.replace(/^Basic\s+/i, '')}`,
      'Content-Type': 'application/json;charset=UTF-8'
    },
    body: JSON.stringify(payload)
  }, {
    circuitKey: 'provider_shipping:russian_post_tariff',
    timeoutMs: 15_000,
    maxRetries: 2
  });

  const payloadRaw = await parseJsonResponse(response);
  const payloadRecord = asRecord(payloadRaw);

  if (!response.ok || !payloadRecord) {
    throw createProviderApiError(
      `Russian Post API request failed (${response.status})`,
      response.status
    );
  }

  if (String(payloadRecord.status ?? '').toUpperCase() === 'ERROR') {
    const message = String(payloadRecord.message ?? 'Unknown Russian Post API error');
    throw createProviderApiError(`Russian Post API error: ${message}`, response.status);
  }

  const totalRate = safeNumber(payloadRecord['total-rate'] ?? payloadRecord.totalRate);
  if (!Number.isFinite(totalRate)) {
    throw new Error('API Почты России не вернул total-rate');
  }

  return {
    provider: 'russian_post',
    estimatedCostCents: Math.round(totalRate),
    currency: 'RUB',
    billedWeightKg: stats.billedWeightKg,
    actualWeightKg: stats.actualWeightKg,
    volumetricWeightKg: stats.volumetricWeightKg,
    source: 'provider_api'
  };
};

const shouldFallbackToEstimate = () =>
  (process.env.SHIPPING_PROVIDER_FALLBACK_TO_ESTIMATE ?? '').trim().toLowerCase() === 'true';

export const calculateShippingWithProviderApi = async (
  input: ShippingEstimateInput
): Promise<ProviderApiResult> => {
  const operation = 'calculate_shipping';
  const attempt = 1;
  const startedAt = Date.now();
  try {
    const result =
      input.provider === 'dellin'
        ? await calculateDellinShipping(input)
        : await calculateRussianPostShipping(input);
    void logIntegrationEvent({
      provider: input.provider,
      operation,
      attempt,
      statusCode: 200,
      latencyMs: Date.now() - startedAt,
      fallbackUsed: false
    });
    return result;
  } catch (error) {
    const statusCode = getStatusCodeFromError(error);
    const latencyMs = Date.now() - startedAt;
    const errorMessage = error instanceof Error ? error.message : 'unknown_error';
    if (!shouldFallbackToEstimate()) {
      void logIntegrationEvent({
        provider: input.provider,
        operation,
        attempt,
        statusCode,
        latencyMs,
        fallbackUsed: false,
        error: errorMessage
      });
      throw error;
    }
    const estimated = estimateShippingCost(input);
    void logIntegrationEvent({
      provider: input.provider,
      operation,
      attempt,
      statusCode,
      latencyMs,
      fallbackUsed: true,
      error: errorMessage
    });
    return {
      ...estimated,
      source: 'estimate_fallback'
    };
  }
};

export const getShippingProviderApiDebug = (
  result: ProviderApiResult
): { source: ProviderApiResult['source'] } => ({
  source: result.source
});
