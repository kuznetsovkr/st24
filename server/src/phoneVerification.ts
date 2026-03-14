import crypto from 'crypto';

export type PhoneVerificationChannel = 'telegram_gateway' | 'sms_ru' | 'debug';

export type PhoneVerificationContext = 'auth' | 'profile_phone';

export type PhoneVerificationDeliveryResult = {
  channel: PhoneVerificationChannel;
  providerRequestId?: string;
  providerMessageId?: string;
};

type PreferredPhoneVerificationChannel = Exclude<PhoneVerificationChannel, 'debug'>;

type SendPhoneVerificationCodeInput = {
  phone: string;
  code: string;
  ttlMinutes: number;
  context: PhoneVerificationContext;
  ip?: string;
  preferredChannel?: PreferredPhoneVerificationChannel;
};

type TelegramGatewayResponse<T> = {
  ok?: boolean;
  result?: T;
  error?: string;
  description?: string;
};

type TelegramGatewayCheckSendAbilityResult = {
  request_id?: string;
};

type TelegramGatewaySendVerificationResult = {
  request_id?: string;
};

type SmsRuSendResponse = {
  status?: string;
  status_text?: string;
  sms?: Record<
    string,
    {
      status?: string;
      status_code?: number;
      status_text?: string;
      sms_id?: string | number;
    }
  >;
};

const TELEGRAM_GATEWAY_BASE_URL = 'https://gatewayapi.telegram.org';
const SMS_RU_BASE_URL = 'https://sms.ru';

const trimToUndefined = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const normalizePhone = (value: string) => value.replace(/\D/g, '');

const formatPhoneE164 = (value: string) => {
  let digits = normalizePhone(value);
  if (!digits) {
    return value.trim();
  }
  if (digits.startsWith('8')) {
    digits = `7${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    digits = `7${digits}`;
  }
  return `+${digits}`;
};

const getTelegramGatewayToken = () => trimToUndefined(process.env.TELEGRAM_GATEWAY_TOKEN);

const getTelegramGatewayBaseUrl = () =>
  trimToUndefined(process.env.TELEGRAM_GATEWAY_BASE_URL) ?? TELEGRAM_GATEWAY_BASE_URL;

const getTelegramGatewayCallbackUrl = () =>
  trimToUndefined(process.env.TELEGRAM_GATEWAY_CALLBACK_URL);

const getTelegramGatewaySenderUsername = () =>
  trimToUndefined(process.env.TELEGRAM_GATEWAY_SENDER_USERNAME);

const getSmsRuApiId = () => trimToUndefined(process.env.SMS_RU_API_ID);

const getSmsRuSender = () => trimToUndefined(process.env.SMS_RU_SENDER);

const isSmsRuTestMode = () => process.env.SMS_RU_TEST === 'true';
const isProduction = () => (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';

const getPhoneVerificationBrand = () =>
  trimToUndefined(process.env.PHONE_VERIFICATION_BRAND) ?? 'ST24';

const isDebugCodeEnabled = () => {
  if (process.env.PHONE_VERIFICATION_DEBUG_CODE === 'true') {
    return true;
  }
  if (process.env.PHONE_VERIFICATION_DEBUG_CODE === 'false') {
    return false;
  }
  return process.env.NODE_ENV !== 'production';
};

export const assertPhoneVerificationConfiguration = () => {
  if (isProduction() && process.env.PHONE_VERIFICATION_DEBUG_CODE === 'true') {
    throw new Error('PHONE_VERIFICATION_DEBUG_CODE must be false in production');
  }
};

const getTelegramGatewayTtlSeconds = (ttlMinutes: number) => {
  const fallback = Math.max(30, Math.min(3600, Math.round(ttlMinutes * 60)));
  const raw = trimToUndefined(process.env.TELEGRAM_GATEWAY_TTL_SECONDS);
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(30, Math.min(3600, parsed));
};

const buildSmsText = (code: string, ttlMinutes: number) =>
  `${getPhoneVerificationBrand()}: код подтверждения ${code}. Не сообщайте его никому. Код действует ${ttlMinutes} мин.`;

const parseJsonResponse = async <T>(response: Response): Promise<T | null> => {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const formatProviderError = (provider: string, error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  return `${provider}: ${message}`;
};

const callTelegramGateway = async <T>(
  method: string,
  payload: Record<string, unknown>
): Promise<T> => {
  const token = getTelegramGatewayToken();
  if (!token) {
    throw new Error('Telegram Gateway token is not configured');
  }

  const response = await fetch(`${getTelegramGatewayBaseUrl().replace(/\/$/, '')}/${method}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const data = await parseJsonResponse<TelegramGatewayResponse<T>>(response);
  if (!response.ok || !data?.ok || !data.result) {
    const details = data?.description || data?.error || `HTTP ${response.status}`;
    throw new Error(details);
  }

  return data.result;
};

const sendViaTelegramGateway = async (
  input: SendPhoneVerificationCodeInput
): Promise<PhoneVerificationDeliveryResult> => {
  const phoneNumber = formatPhoneE164(input.phone);
  const check = await callTelegramGateway<TelegramGatewayCheckSendAbilityResult>(
    'checkSendAbility',
    {
      phone_number: phoneNumber
    }
  );

  const requestId = check.request_id?.trim();
  if (!requestId) {
    throw new Error('Telegram Gateway did not return request_id');
  }

  const payload: Record<string, unknown> = {
    phone_number: phoneNumber,
    request_id: requestId,
    code: input.code,
    ttl: getTelegramGatewayTtlSeconds(input.ttlMinutes),
    payload: input.context
  };

  const callbackUrl = getTelegramGatewayCallbackUrl();
  if (callbackUrl) {
    payload.callback_url = callbackUrl;
  }

  const senderUsername = getTelegramGatewaySenderUsername();
  if (senderUsername) {
    payload.sender_username = senderUsername;
  }

  const sendResult = await callTelegramGateway<TelegramGatewaySendVerificationResult>(
    'sendVerificationMessage',
    payload
  );

  return {
    channel: 'telegram_gateway',
    providerRequestId: sendResult.request_id?.trim() || requestId
  };
};

const sendViaSmsRu = async (
  input: SendPhoneVerificationCodeInput
): Promise<PhoneVerificationDeliveryResult> => {
  const apiId = getSmsRuApiId();
  if (!apiId) {
    throw new Error('SMS.RU API ID is not configured');
  }

  const phone = normalizePhone(input.phone);
  if (!phone) {
    throw new Error('Phone number is empty');
  }

  const params = new URLSearchParams();
  params.set('api_id', apiId);
  params.set('to', phone);
  params.set('msg', buildSmsText(input.code, input.ttlMinutes));
  params.set('json', '1');

  const sender = getSmsRuSender();
  if (sender) {
    params.set('from', sender);
  }

  if (input.ip) {
    params.set('ip', input.ip);
  }

  if (isSmsRuTestMode()) {
    params.set('test', '1');
  }

  const response = await fetch(`${SMS_RU_BASE_URL}/sms/send`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: params.toString()
  });

  const data = await parseJsonResponse<SmsRuSendResponse>(response);
  if (!response.ok) {
    throw new Error(`SMS.RU HTTP ${response.status}`);
  }

  if (!data || data.status !== 'OK') {
    throw new Error(data?.status_text || 'SMS.RU request failed');
  }

  const smsResult = data.sms?.[phone];
  if (!smsResult || smsResult.status !== 'OK') {
    throw new Error(smsResult?.status_text || 'SMS.RU send failed');
  }

  return {
    channel: 'sms_ru',
    providerMessageId:
      smsResult.sms_id !== undefined && smsResult.sms_id !== null
        ? String(smsResult.sms_id)
        : undefined
  };
};

export const sendPhoneVerificationCode = async (
  input: SendPhoneVerificationCodeInput
): Promise<PhoneVerificationDeliveryResult> => {
  const errors: string[] = [];
  const preferredChannel = input.preferredChannel;

  if (preferredChannel !== 'sms_ru' && getTelegramGatewayToken()) {
    try {
      return await sendViaTelegramGateway(input);
    } catch (error) {
      errors.push(formatProviderError('Telegram Gateway', error));
    }
  }

  if (getSmsRuApiId()) {
    try {
      return await sendViaSmsRu(input);
    } catch (error) {
      errors.push(formatProviderError('SMS.RU', error));
    }
  }

  if (isDebugCodeEnabled()) {
    console.log(`[PHONE VERIFY DEBUG] ${input.context} ${input.phone}: ${input.code}`);
    return {
      channel: 'debug'
    };
  }

  if (errors.length > 0) {
    throw new Error(`Не удалось отправить код. ${errors.join(' | ')}`);
  }

  throw new Error('Не настроены Telegram Gateway и SMS.RU для отправки кодов');
};

export const reportTelegramVerificationStatus = async (
  requestId: string | null | undefined,
  code: string
) => {
  const trimmedRequestId = requestId?.trim();
  if (!trimmedRequestId || !getTelegramGatewayToken() || !code.trim()) {
    return;
  }

  try {
    await callTelegramGateway('checkVerificationStatus', {
      request_id: trimmedRequestId,
      code: code.trim()
    });
  } catch (error) {
    console.warn(
      `[PHONE VERIFY] Telegram verification status check failed for ${trimmedRequestId}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`
    );
  }
};

export const verifyTelegramGatewaySignature = (
  rawBody: string,
  timestamp: string,
  signature: string
) => {
  const token = getTelegramGatewayToken();
  if (!token || !rawBody || !timestamp || !signature) {
    return false;
  }

  const secret = crypto.createHash('sha256').update(token).digest();
  const actual = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${rawBody}`)
    .digest('hex');

  const expectedBuffer = Buffer.from(actual, 'utf8');
  const signatureBuffer = Buffer.from(signature.trim().toLowerCase(), 'utf8');

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
};
