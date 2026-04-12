import crypto from 'crypto';
import { logPhoneCodeDeliveryEvent } from './phoneCodeDeliveryLogs';
import { resilientFetch } from './httpClient';
import { getTelegramOutboundDispatcher } from './telegramProxy';

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

type PhoneVerificationMode = 'telegram_then_sms' | 'sms_only';

const getPhoneVerificationMode = (): PhoneVerificationMode => {
  const raw = (process.env.PHONE_VERIFICATION_MODE ?? '').trim().toLowerCase();
  if (raw === 'sms_only' || raw === 'sms' || raw === 'sms_ru_only') {
    return 'sms_only';
  }
  return 'telegram_then_sms';
};

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

  if (
    isProduction() &&
    getPhoneVerificationMode() === 'sms_only' &&
    !getSmsRuApiId()
  ) {
    throw new Error('PHONE_VERIFICATION_MODE=sms_only requires SMS_RU_API_ID in production');
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
    throw new Error('Токен Telegram Gateway не настроен');
  }

  const url = `${getTelegramGatewayBaseUrl().replace(/\/$/, '')}/${method}`;
  const response = await resilientFetch(
    url,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      dispatcher: getTelegramOutboundDispatcher()
    },
    {
      circuitKey: `phone_verification:telegram_gateway:${method}`,
      timeoutMs: 10_000,
      maxRetries: 2
    }
  );

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
    throw new Error('Telegram Gateway не вернул request_id');
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
    throw new Error('SMS.RU API ID не настроен');
  }

  const phone = normalizePhone(input.phone);
  if (!phone) {
    throw new Error('Пустой номер телефона');
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

  const response = await resilientFetch(`${SMS_RU_BASE_URL}/sms/send`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    body: params.toString()
  }, {
    circuitKey: 'phone_verification:sms_ru_send',
    timeoutMs: 10_000,
    maxRetries: 2
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
  const mode = getPhoneVerificationMode();

  if (
    mode !== 'sms_only' &&
    preferredChannel !== 'sms_ru' &&
    getTelegramGatewayToken()
  ) {
    try {
      const delivery = await sendViaTelegramGateway(input);
      await logPhoneCodeDeliveryEvent({
        phone: input.phone,
        channel: delivery.channel,
        context: input.context,
        status: 'sent',
        preferredChannel: preferredChannel ?? null,
        fallbackUsed: false,
        providerRequestId: delivery.providerRequestId,
        providerMessageId: delivery.providerMessageId,
        ip: input.ip
      });
      return delivery;
    } catch (error) {
      const message = formatProviderError('Telegram Gateway', error);
      errors.push(message);
      await logPhoneCodeDeliveryEvent({
        phone: input.phone,
        channel: 'telegram_gateway',
        context: input.context,
        status: 'failed',
        preferredChannel: preferredChannel ?? null,
        fallbackUsed: false,
        error: message,
        ip: input.ip
      });
    }
  }

  if (getSmsRuApiId()) {
    try {
      const delivery = await sendViaSmsRu(input);
      await logPhoneCodeDeliveryEvent({
        phone: input.phone,
        channel: delivery.channel,
        context: input.context,
        status: 'sent',
        preferredChannel: preferredChannel ?? null,
        fallbackUsed: errors.length > 0,
        providerRequestId: delivery.providerRequestId,
        providerMessageId: delivery.providerMessageId,
        ip: input.ip
      });
      return delivery;
    } catch (error) {
      const message = formatProviderError('SMS.RU', error);
      errors.push(message);
      await logPhoneCodeDeliveryEvent({
        phone: input.phone,
        channel: 'sms_ru',
        context: input.context,
        status: 'failed',
        preferredChannel: preferredChannel ?? null,
        fallbackUsed: errors.length > 1,
        error: message,
        ip: input.ip
      });
    }
  }

  if (isDebugCodeEnabled()) {
    await logPhoneCodeDeliveryEvent({
      phone: input.phone,
      channel: 'debug',
      context: input.context,
      status: 'sent',
      preferredChannel: preferredChannel ?? null,
      fallbackUsed: errors.length > 0,
      ip: input.ip
    });
    return {
      channel: 'debug'
    };
  }

  if (errors.length > 0) {
    await logPhoneCodeDeliveryEvent({
      phone: input.phone,
      channel: 'unknown',
      context: input.context,
      status: 'failed',
      preferredChannel: preferredChannel ?? null,
      fallbackUsed: true,
      error: errors.join(' | '),
      ip: input.ip
    });
    throw new Error(`Не удалось отправить код. ${errors.join(' | ')}`);
  }

  await logPhoneCodeDeliveryEvent({
    phone: input.phone,
    channel: 'unknown',
    context: input.context,
    status: 'failed',
    preferredChannel: preferredChannel ?? null,
    fallbackUsed: false,
    error: 'telegram_and_sms_providers_not_configured',
    ip: input.ip
  });
  if (mode === 'sms_only') {
    throw new Error('SMS.RU не настроен для отправки кодов');
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
