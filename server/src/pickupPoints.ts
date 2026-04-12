import { resilientFetch } from './httpClient';

type PickupPointProvider = 'dellin' | 'russian_post';

export type PickupPointOption = {
  provider: PickupPointProvider;
  code: string;
  name: string;
  city: string;
  address: string;
  label: string;
};

type DellinDirectoryCache = {
  loadedAtMs: number;
  points: PickupPointOption[];
};

type RussianPostAuthHeaders = {
  Authorization: string;
  'X-User-Authorization'?: string;
};

const DELLIN_DIRECTORY_TTL_MS = 30 * 60 * 1000;
let dellinDirectoryCache: DellinDirectoryCache | null = null;

export class PickupPointProxyError extends Error {
  status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizeText = (value: string) =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

const safeString = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = async (response: Response): Promise<unknown> => {
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

const collectRecords = (value: unknown, bucket: Record<string, unknown>[]) => {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, bucket);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  bucket.push(value);
  for (const nested of Object.values(value)) {
    collectRecords(nested, bucket);
  }
};

const mapToPickupOption = (
  provider: PickupPointProvider,
  record: Record<string, unknown>
): PickupPointOption | null => {
  const code = safeString(
    record.code ??
      record.id ??
      record.terminal_id ??
      record.terminalCode ??
      record.index ??
      record['postal-code']
  );

  const name = safeString(
    record.name ??
      record.terminal_name ??
      record.title ??
      record.postoffice ??
      (code ? `Пункт ${code}` : '')
  );

  const city = safeString(
    record.city ??
      record.city_name ??
      record.cityName ??
      record.settlement ??
      record.region
  );

  const address = safeString(
    record.address ??
      record.full_address ??
      record.address_full ??
      record.addressSource ??
      record['address-source'] ??
      record.street
  );

  if (provider === 'dellin' && !address) {
    return null;
  }

  if (!name && !address) {
    return null;
  }

  const labelParts = [city, address].filter(Boolean);
  const labelBody = labelParts.join(', ');
  const label = labelBody ? `${name}${name && labelBody ? ', ' : ''}${labelBody}` : name;

  return {
    provider,
    code: code || `${provider}-${normalizeText(label)}`,
    name: name || address || 'Пункт выдачи',
    city,
    address,
    label: label || 'Пункт выдачи'
  };
};

const dedupePickupOptions = (items: PickupPointOption[]) => {
  const seen = new Set<string>();
  const unique: PickupPointOption[] = [];
  for (const item of items) {
    const key = `${item.provider}:${item.code}:${item.address}:${item.name}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(item);
  }
  return unique;
};

const filterPickupOptions = (items: PickupPointOption[], query: string, limit = 25) => {
  const normalizedQuery = normalizeText(query);
  return items
    .filter((item) => {
      const haystack = normalizeText(
        `${item.name} ${item.city} ${item.address} ${item.code}`.trim()
      );
      return haystack.includes(normalizedQuery);
    })
    .slice(0, limit);
};

const getDellinAppKey = () => trimToUndefined(process.env.DELLIN_APP_KEY);
const getDellinBaseUrl = () =>
  trimToUndefined(process.env.DELLIN_API_BASE_URL) ?? 'https://api.dellin.ru';

const getRussianPostAccessToken = () =>
  trimToUndefined(process.env.RUSSIAN_POST_ACCESS_TOKEN);
const getRussianPostUserKey = () => trimToUndefined(process.env.RUSSIAN_POST_USER_KEY);
const getRussianPostBaseUrl = () =>
  trimToUndefined(process.env.RUSSIAN_POST_API_BASE_URL) ?? 'https://otpravka-api.pochta.ru';

const isPostalCode = (value: string) => /^\d{6}$/.test(value);

const toPostalCode = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const normalized = String(Math.trunc(value));
    return isPostalCode(normalized) ? normalized : null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (isPostalCode(normalized)) {
      return normalized;
    }
  }

  return null;
};

const extractPostalCodesFromPayload = (payload: unknown) => {
  const found = new Set<string>();

  const visit = (value: unknown): void => {
    const directCode = toPostalCode(value);
    if (directCode) {
      found.add(directCode);
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    if (!isRecord(value)) {
      return;
    }

    const candidateFields: Array<unknown> = [
      value.code,
      value.index,
      value.postoffice,
      value['postal-code'],
      value.postalCode
    ];
    for (const candidate of candidateFields) {
      const code = toPostalCode(candidate);
      if (code) {
        found.add(code);
      }
    }

    for (const nested of Object.values(value)) {
      visit(nested);
    }
  };

  visit(payload);

  return Array.from(found);
};

const loadDellinDirectory = async (): Promise<PickupPointOption[]> => {
  const now = Date.now();
  if (
    dellinDirectoryCache &&
    now - dellinDirectoryCache.loadedAtMs < DELLIN_DIRECTORY_TTL_MS
  ) {
    return dellinDirectoryCache.points;
  }

  const appKey = getDellinAppKey();
  if (!appKey) {
    throw new PickupPointProxyError('DELLIN_APP_KEY не настроен', 500);
  }

  const directoryUrlResponse = await resilientFetch(
    `${getDellinBaseUrl().replace(/\/$/, '')}/v3/public/terminals.json`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ appkey: appKey })
    },
    {
      circuitKey: 'pickup_points:dellin_terminals_url',
      timeoutMs: 15_000,
      maxRetries: 2
    }
  );

  const directoryUrlPayload = await parseJson(directoryUrlResponse);
  if (!directoryUrlResponse.ok || !isRecord(directoryUrlPayload)) {
    throw new PickupPointProxyError('Не удалось получить список терминалов Деловых Линий', 502);
  }

  const directoryUrl = safeString(
    directoryUrlPayload.url ??
      (isRecord(directoryUrlPayload.data) ? directoryUrlPayload.data.url : '')
  );
  if (!directoryUrl) {
    throw new PickupPointProxyError('Delovye Linii directory URL is missing in response', 502);
  }

  const directoryResponse = await resilientFetch(
    directoryUrl,
    {
      headers: {
        Accept: 'application/json'
      }
    },
    {
      circuitKey: 'pickup_points:dellin_terminals_download',
      timeoutMs: 20_000,
      maxRetries: 2
    }
  );
  const directoryPayload = await parseJson(directoryResponse);
  if (!directoryResponse.ok) {
    throw new PickupPointProxyError('Не удалось получить список терминалов Деловых Линий', 502);
  }

  const records: Record<string, unknown>[] = [];
  collectRecords(directoryPayload, records);
  const parsed = dedupePickupOptions(
    records
      .map((record) => mapToPickupOption('dellin', record))
      .filter((item): item is PickupPointOption => Boolean(item))
  );

  dellinDirectoryCache = {
    loadedAtMs: now,
    points: parsed
  };
  return parsed;
};

const getRussianPostHeaderVariants = (): RussianPostAuthHeaders[] => {
  const token = getRussianPostAccessToken();
  const userKey = getRussianPostUserKey();
  if (!token) {
    throw new PickupPointProxyError('RUSSIAN_POST_ACCESS_TOKEN is not configured', 500);
  }

  const normalizedUserKey = userKey?.replace(/^Basic\s+/i, '');
  const userAuthHeader = normalizedUserKey
    ? `Basic ${normalizedUserKey}`
    : undefined;

  return [
    {
      Authorization: `AccessToken ${token}`,
      ...(userAuthHeader ? { 'X-User-Authorization': userAuthHeader } : {})
    },
    {
      Authorization: token,
      ...(userAuthHeader ? { 'X-User-Authorization': userAuthHeader } : {})
    },
    {
      Authorization: `Bearer ${token}`,
      ...(userAuthHeader ? { 'X-User-Authorization': userAuthHeader } : {})
    }
  ];
};

type RussianPostRequestResult = {
  status: number;
  payload: unknown;
};

const requestRussianPost = async (
  methodPath: string,
  params: Record<string, string | number | boolean | undefined>,
  circuitKey: string,
  acceptedStatuses: number[] = []
): Promise<RussianPostRequestResult> => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    query.set(key, String(value));
  }
  const queryString = query.toString();
  const baseUrl = `${getRussianPostBaseUrl().replace(/\/$/, '')}/postoffice/1.0`;
  const url = `${baseUrl}/${methodPath.replace(/^\//, '')}${
    queryString ? `?${queryString}` : ''
  }`;

  const accepted = new Set(acceptedStatuses);
  let lastErrorPayload: unknown = null;
  let lastStatus = 502;

  for (const headers of getRussianPostHeaderVariants()) {
    const response = await resilientFetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers
      }
    }, {
      circuitKey,
      timeoutMs: 12_000,
      maxRetries: 2
    });
    const payload = await parseJson(response);

    if (response.ok || accepted.has(response.status)) {
      return {
        status: response.status,
        payload
      };
    }

    lastStatus = response.status;
    lastErrorPayload = payload;
    if (response.status !== 401 && response.status !== 403) {
      break;
    }
  }

  const errorText =
    typeof lastErrorPayload === 'string'
      ? lastErrorPayload
      : JSON.stringify(lastErrorPayload ?? {});
  throw new PickupPointProxyError(
    `Russian Post API request failed (${lastStatus}): ${errorText}`,
    502
  );
};

const requestRussianPostByAddress = async (query: string) => {
  const response = await requestRussianPost(
    'by-address',
    {
      address: query,
      top: 30
    },
    'pickup_points:russian_post_by_address'
  );
  return response.payload;
};

const requestRussianPostSettlementOfficeCodes = async (settlement: string) => {
  const response = await requestRussianPost(
    'settlement.offices.codes',
    {
      settlement
    },
    'pickup_points:russian_post_settlement_codes'
  );
  return response.payload;
};

const requestRussianPostOfficeByIndex = async (postalCode: string) => {
  const response = await requestRussianPost(
    postalCode,
    {
      'filter-by-office-type': true,
      'ufps-postal-code': false
    },
    'pickup_points:russian_post_office_by_index',
    [404]
  );

  if (response.status === 404) {
    return null;
  }

  return response.payload;
};

export const searchDellinPickupPoints = async (query: string) => {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) {
    return [];
  }
  const directory = await loadDellinDirectory();
  return filterPickupOptions(directory, normalizedQuery, 30);
};

export const searchRussianPostPickupPoints = async (query: string) => {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length < 2) {
    return [];
  }

  const byAddressPayload = await requestRussianPostByAddress(normalizedQuery);
  let postalCodes = extractPostalCodesFromPayload(byAddressPayload);

  if (postalCodes.length === 0) {
    const settlementPayload = await requestRussianPostSettlementOfficeCodes(normalizedQuery);
    postalCodes = extractPostalCodesFromPayload(settlementPayload);
  }

  if (postalCodes.length === 0 && !normalizedQuery.includes(',')) {
    const extendedAddressPayload = await requestRussianPostByAddress(`${normalizedQuery}, Россия`);
    postalCodes = extractPostalCodesFromPayload(extendedAddressPayload);
  }

  const officePayloads = await Promise.all(
    postalCodes.slice(0, 30).map((postalCode) => requestRussianPostOfficeByIndex(postalCode))
  );

  const records: Record<string, unknown>[] = [];
  if (officePayloads.length > 0) {
    for (const payload of officePayloads) {
      if (payload) {
        collectRecords(payload, records);
      }
    }
  }

  if (records.length === 0) {
    collectRecords(byAddressPayload, records);
  }

  const parsed = dedupePickupOptions(
    records
      .map((record) => mapToPickupOption('russian_post', record))
      .filter((item): item is PickupPointOption => Boolean(item))
  );

  const filteredParsed = filterPickupOptions(parsed, normalizedQuery, 30);
  if (filteredParsed.length > 0) {
    return filteredParsed;
  }

  if (postalCodes.length > 0) {
    return postalCodes.slice(0, 30).map((postalCode) => ({
      provider: 'russian_post' as const,
      code: postalCode,
      name: `ОПС ${postalCode}`,
      city: normalizedQuery,
      address: '',
      label: `${normalizedQuery}, ${postalCode}`
    }));
  }

  if (parsed.length > 0) {
    return parsed.slice(0, 30);
  }

  return [];
};
