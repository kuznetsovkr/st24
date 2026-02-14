type CdekCredentials = {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
};

type CdekTokenState = {
  value: string;
  expiresAtMs: number;
};

type CdekErrorInput = {
  message: string;
  status: number;
  details?: string;
};

type CdekProxyResult = {
  status: number;
  body: unknown;
  forwardedHeaders: Array<[string, string]>;
};

type CdekRequestOptions = {
  method: 'GET' | 'POST';
  query?: Record<string, unknown>;
  json?: unknown;
};

const TOKEN_LEEWAY_MS = 30_000;
let tokenState: CdekTokenState | null = null;

export class CdekProxyError extends Error {
  status: number;
  details?: string;

  constructor(input: CdekErrorInput) {
    super(input.message);
    this.status = input.status;
    this.details = input.details;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getCdekCredentials = (): CdekCredentials => {
  const clientId = process.env.CDEK_CLIENT_ID ?? process.env.CDEK_ACCOUNT ?? '';
  const clientSecret =
    process.env.CDEK_CLIENT_SECRET ?? process.env.CDEK_PASSWORD ?? '';

  if (!clientId || !clientSecret) {
    throw new CdekProxyError({
      message: 'CDEK credentials are not configured',
      status: 500
    });
  }

  return {
    clientId,
    clientSecret,
    baseUrl: process.env.CDEK_API_BASE_URL ?? 'https://api.cdek.ru/v2'
  };
};

const appendQueryValue = (
  params: URLSearchParams,
  key: string,
  value: unknown
) => {
  if (value === null || value === undefined) {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      appendQueryValue(params, key, item);
    }
    return;
  }
  if (isPlainObject(value)) {
    params.set(key, JSON.stringify(value));
    return;
  }
  params.set(key, String(value));
};

const parseResponseBody = async (response: Response) => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const requestCdek = async (
  path: string,
  token: string,
  options: CdekRequestOptions
) => {
  const { baseUrl } = getCdekCredentials();
  const url = new URL(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`);
  if (options.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query)) {
      appendQueryValue(params, key, value);
    }
    url.search = params.toString();
  }

  const response = await fetch(url.toString(), {
    method: options.method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'X-App-Name': 'st24_widget',
      'X-App-Version': '1.0.0',
      ...(options.json ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.json ? JSON.stringify(options.json) : undefined
  });

  const body = await parseResponseBody(response);
  if (!response.ok) {
    const description =
      typeof body === 'string' ? body : JSON.stringify(body ?? {});
    throw new CdekProxyError({
      message: `CDEK request failed (${response.status})`,
      details: description,
      status: response.status >= 400 && response.status < 500 ? 400 : 502
    });
  }

  const forwardedHeaders: Array<[string, string]> = [];
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase().startsWith('x-')) {
      forwardedHeaders.push([key, value]);
    }
  }

  return {
    status: response.status,
    body,
    forwardedHeaders
  };
};

const fetchCdekAccessToken = async () => {
  const now = Date.now();
  if (tokenState && now + TOKEN_LEEWAY_MS < tokenState.expiresAtMs) {
    return tokenState.value;
  }

  const { clientId, clientSecret, baseUrl } = getCdekCredentials();
  const tokenUrl = new URL(`${baseUrl.replace(/\/$/, '')}/oauth/token`);
  const payload = new FormData();
  payload.append('grant_type', 'client_credentials');
  payload.append('client_id', clientId);
  payload.append('client_secret', clientSecret);

  const response = await fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      Accept: 'application/json'
    },
    body: payload
  });

  const body = (await parseResponseBody(response)) as
    | { access_token?: string; expires_in?: number }
    | string
    | null;

  if (!response.ok || !body || typeof body === 'string' || !body.access_token) {
    const description =
      typeof body === 'string' ? body : JSON.stringify(body ?? {});
    const baseHint =
      baseUrl.includes('api.cdek.ru')
      && description.includes('No such account secure')
        ? ' Проверьте CDEK_API_BASE_URL. Для тестовых ключей используйте https://api.edu.cdek.ru/v2.'
        : '';
    throw new CdekProxyError({
      message: `CDEK auth failed (${response.status}).${baseHint}`.trim(),
      details: description,
      status: response.status === 401 ? 401 : 502
    });
  }

  const expiresInSec =
    typeof body.expires_in === 'number' && Number.isFinite(body.expires_in)
      ? body.expires_in
      : 3600;
  tokenState = {
    value: body.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000
  };

  return tokenState.value;
};

const toProxyPayload = (input: unknown): Record<string, unknown> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(
      ([, value]) => value !== undefined
    )
  );
};

const extractAction = (payload: Record<string, unknown>) =>
  typeof payload.action === 'string' ? payload.action : '';

const removeAction = (payload: Record<string, unknown>) => {
  const copy = { ...payload };
  delete copy.action;
  return copy;
};

export const proxyCdekWidgetRequest = async (
  queryInput: unknown,
  bodyInput: unknown
): Promise<CdekProxyResult> => {
  const payload = {
    ...toProxyPayload(queryInput),
    ...toProxyPayload(bodyInput)
  };
  const action = extractAction(payload);

  if (!action) {
    throw new CdekProxyError({ message: 'Action is required', status: 400 });
  }

  const token = await fetchCdekAccessToken();
  const requestPayload = removeAction(payload);

  if (action === 'offices') {
    return requestCdek('deliverypoints', token, {
      method: 'GET',
      query: requestPayload
    });
  }

  if (action === 'calculate') {
    return requestCdek('calculator/tarifflist', token, {
      method: 'POST',
      json: requestPayload
    });
  }

  throw new CdekProxyError({ message: 'Unknown action', status: 400 });
};

export const resetCdekTokenCache = () => {
  tokenState = null;
};
