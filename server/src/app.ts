import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import fs from 'fs';
import { randomInt, randomUUID } from 'crypto';
import path from 'path';
import {
  CSRF_COOKIE_NAME,
  clearAuthCookies,
  createCsrfToken,
  getCookieValue,
  getRequestAuthToken,
  setAuthCookies,
  signToken,
  verifyToken
} from './auth';
import { CdekProxyError, proxyCdekWidgetRequest } from './cdek';
import { findAuthCode, saveAuthCode, deleteAuthCode } from './db/authCodes';
import {
  createBoxType,
  deleteBoxType,
  listBoxTypes,
  updateBoxType,
  type BoxTypeRow
} from './db/boxTypes';
import {
  isDeliveryProviderEnabled,
  isDeliveryProviderKey,
  listDeliveryProviders,
  updateDeliveryProviderEnabled,
  type DeliveryProviderRow
} from './db/deliveryProviders';
import { findEmailCode, saveEmailCode, deleteEmailCode } from './db/emailCodes';
import {
  filterValidCartItems,
  listCartItems,
  mergeCartItems,
  replaceCartItems,
  type CartItemRow,
  type CartSyncItem
} from './db/cart';
import {
  countCategoryProducts,
  deleteCategory,
  findCategoryBySlug,
  isValidCategory,
  listCategories,
  updateCategory,
  type CategoryRow
} from './db/categories';
import { getCatalogPage, updateCatalogPage, type CatalogPageRow } from './db/catalogPage';
import {
  createOrder,
  findOrderById,
  findOrderByIdForUser,
  findOrderByPaymentId,
  InsufficientStockError,
  listOrderItemsForUser,
  listOrdersByUser,
  markOrderPaid,
  markOrderPaidById,
  updateOrderPayment,
  updateOrderPaymentStatusById,
  type OrderItemRow,
  type OrderRow
} from './db/orders';
import {
  createProduct,
  deleteProduct,
  findProductById,
  findProductBySku,
  listProducts,
  searchProductsBySku,
  updateProduct,
  type ProductRow
} from './db/products';
import { getHomeBanner, updateHomeBanner, type SiteBannerRow } from './db/siteBanners';
import {
  findUserByEmail,
  findUserById,
  findUserByPhone,
  updateUserProfile,
  upsertUser
} from './db/users';
import { authenticate, requireAdmin } from './middleware/auth';
import {
  reportTelegramVerificationStatus,
  sendPhoneVerificationCode,
  verifyTelegramGatewaySignature
} from './phoneVerification';
import {
  handleTelegramB2BUpdate,
  handleTelegramOrderUpdate,
  handleTelegramUpdate,
  sendB2BTelegramMessage,
  sendOrderTelegramMessage,
  sendTelegramMessage
} from './telegram';
import { isTurnstileEnabled, verifyTurnstileToken } from './turnstile';
import { removeUploadedFiles, toPublicUrl, upload, UploadValidationError } from './uploads';
import {
  PickupPointProxyError,
  searchDellinPickupPoints,
  searchRussianPostPickupPoints
} from './pickupPoints';
import {
  type ShippingEstimateProvider
} from './shippingEstimate';
import {
  calculateShippingWithProviderApi,
  getShippingProviderApiDebug
} from './providerShipping';
import {
  buildShippingParcelsFromCart,
  hashShippingParcels,
  normalizeShippingParcels
} from './shippingParcels';
import { createDeliveryQuoteToken, verifyDeliveryQuoteToken } from './shippingQuote';
import {
  createYooKassaPayment,
  fetchYooKassaPayment,
  getYooKassaFixedAmountCents,
  getYooKassaReceiptTaxSystemCode,
  getYooKassaReceiptVatCode,
  getYooKassaReturnBaseUrl,
  getYooKassaWebhookSecret,
  isYooKassaUseOrderTotal,
  isYooKassaConfigured,
  type YooKassaPayment,
  type YooKassaReceipt
} from './yookassa';

const CODE_TTL_MINUTES = 5;
const PHONE_CODE_LENGTH = 4;
const EMAIL_CODE_LENGTH = 6;
const B2B_CARD_MAX_FILE_SIZE = 10 * 1024 * 1024;
const B2B_CARD_ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/jpeg',
  'image/png'
]);
const B2B_CARD_ALLOWED_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.jpg',
  '.jpeg',
  '.png'
]);
const B2B_UPLOAD_TMP_DIR = path.resolve(process.cwd(), 'tmp', 'b2b-requests');

type RawBodyRequest = Request & {
  rawBody?: string;
};

const normalizePhone = (value: string) => value.replace(/\D/g, '');
const formatPhoneE164 = (value: string) => {
  const digits = normalizePhone(value);
  if (!digits) {
    return value.trim();
  }
  let normalized = digits;
  if (normalized.startsWith('8')) {
    normalized = `7${normalized.slice(1)}`;
  }
  if (normalized.length === 10) {
    normalized = `7${normalized}`;
  }
  return `+${normalized}`;
};
const getAdminPhone = () => normalizePhone(process.env.ADMIN_PHONE ?? '79964292550');
const getAdminPassword = () => process.env.ADMIN_PASSWORD ?? '';
const getAdminAuthMode = () =>
  (process.env.ADMIN_AUTH_MODE ?? '').trim().toLowerCase() === 'code' ? 'code' : 'password';
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const getTelegramWebhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET;
const getTelegramOrdersWebhookSecret = () =>
  process.env.TELEGRAM_ORDERS_WEBHOOK_SECRET;
const getTelegramB2BWebhookSecret = () => process.env.TELEGRAM_B2B_WEBHOOK_SECRET;

const parseTrustProxy = (value: string | undefined): boolean | number | string => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return false;
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber;
  }

  return trimmed;
};

const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);

const parseOriginList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const resolveCorsAllowedOrigins = () => {
  const allowed = [
    ...parseOriginList(process.env.CORS_ALLOWED_ORIGINS),
    ...parseOriginList(
    process.env.CORS_ORIGIN ?? process.env.CLIENT_URL ?? process.env.FRONTEND_URL
    )
  ];

  if (allowed.length > 0) {
    return new Set(allowed);
  }

  return null;
};

const CORS_ALLOWED_ORIGINS = resolveCorsAllowedOrigins();

const isCorsOriginAllowed = (origin: string) =>
  !CORS_ALLOWED_ORIGINS || CORS_ALLOWED_ORIGINS.has(origin);

const normalizeIp = (value: string | undefined) => {
  if (!value) {
    return undefined;
  }
  return value.startsWith('::ffff:') ? value.slice(7) : value;
};

const SAFE_UPLOAD_STATIC_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const applyUploadsSecurityHeaders = (res: Response) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; img-src 'self' data:; media-src 'none'; object-src 'none'; script-src 'none'; sandbox"
  );
};

const ensureB2BUploadTempDir = () => {
  if (!fs.existsSync(B2B_UPLOAD_TMP_DIR)) {
    fs.mkdirSync(B2B_UPLOAD_TMP_DIR, { recursive: true });
  }
};

const removeB2BTempFile = async (file: Express.Multer.File | undefined) => {
  if (!file?.path) {
    return;
  }

  try {
    await fs.promises.unlink(file.path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== 'ENOENT') {
      console.error('Failed to remove temporary B2B file', error);
    }
  }
};

const getRequestIp = (req: Request) => {
  const fromExpress = typeof req.ip === 'string' ? req.ip : undefined;
  return normalizeIp(fromExpress ?? req.socket.remoteAddress ?? undefined);
};

const parsePositiveEnvInt = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
};

const PHONE_CODE_RATE_LIMIT_WINDOW_SECONDS = parsePositiveEnvInt(
  process.env.PHONE_CODE_RATE_LIMIT_WINDOW_SECONDS,
  600
);
const PHONE_CODE_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.PHONE_CODE_RATE_LIMIT_MAX,
  5
);
const OTP_VERIFY_RATE_LIMIT_WINDOW_SECONDS = parsePositiveEnvInt(
  process.env.OTP_VERIFY_RATE_LIMIT_WINDOW_SECONDS,
  600
);
const OTP_VERIFY_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.OTP_VERIFY_RATE_LIMIT_MAX,
  10
);
const EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS = parsePositiveEnvInt(
  process.env.EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS,
  600
);
const EMAIL_VERIFY_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.EMAIL_VERIFY_RATE_LIMIT_MAX,
  10
);
const PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS = parsePositiveEnvInt(
  process.env.PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS,
  600
);
const NEED_PART_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.NEED_PART_RATE_LIMIT_MAX,
  5
);
const B2B_REQUEST_RATE_LIMIT_MAX = parsePositiveEnvInt(
  process.env.B2B_REQUEST_RATE_LIMIT_MAX,
  3
);

type RateLimitState = {
  count: number;
  resetAt: number;
};

type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

type ScopedRateLimiter = {
  consume: (scope: string, ip: string | undefined, subject: string) => RateLimitResult;
  reset: (scope: string, ip: string | undefined, subject: string) => void;
};

const createScopedRateLimiter = (windowSeconds: number, max: number): ScopedRateLimiter => {
  const store = new Map<string, RateLimitState>();
  let lastCleanup = 0;
  const windowMs = windowSeconds * 1000;
  const keyOf = (scope: string, ip: string | undefined, subject: string) =>
    `${scope}:${ip ?? 'unknown'}:${subject}`;

  const consume = (
    scope: string,
    ip: string | undefined,
    subject: string
  ): RateLimitResult => {
    const now = Date.now();
    const key = keyOf(scope, ip, subject);

    if (now - lastCleanup > windowMs) {
      for (const [storeKey, state] of store.entries()) {
        if (state.resetAt <= now) {
          store.delete(storeKey);
        }
      }
      lastCleanup = now;
    }

    const existing = store.get(key);
    if (!existing || existing.resetAt <= now) {
      store.set(key, {
        count: 1,
        resetAt: now + windowMs
      });
      return {
        allowed: true,
        retryAfterSeconds: 0
      };
    }

    if (existing.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return {
        allowed: false,
        retryAfterSeconds
      };
    }

    existing.count += 1;
    store.set(key, existing);
    return {
      allowed: true,
      retryAfterSeconds: 0
    };
  };

  const reset = (scope: string, ip: string | undefined, subject: string) => {
    store.delete(keyOf(scope, ip, subject));
  };

  return { consume, reset };
};

const phoneCodeRequestRateLimiter = createScopedRateLimiter(
  PHONE_CODE_RATE_LIMIT_WINDOW_SECONDS,
  PHONE_CODE_RATE_LIMIT_MAX
);
const otpVerifyRateLimiter = createScopedRateLimiter(
  OTP_VERIFY_RATE_LIMIT_WINDOW_SECONDS,
  OTP_VERIFY_RATE_LIMIT_MAX
);
const emailVerifyRateLimiter = createScopedRateLimiter(
  EMAIL_VERIFY_RATE_LIMIT_WINDOW_SECONDS,
  EMAIL_VERIFY_RATE_LIMIT_MAX
);
const needPartRateLimiter = createScopedRateLimiter(
  PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS,
  NEED_PART_RATE_LIMIT_MAX
);
const b2bRequestRateLimiter = createScopedRateLimiter(
  PUBLIC_FORM_RATE_LIMIT_WINDOW_SECONDS,
  B2B_REQUEST_RATE_LIMIT_MAX
);

const parsePriceCents = (value?: string) => {
  if (!value) {
    return null;
  }
  const normalized = value.replace(',', '.').replace(/[^\d.]/g, '');
  if (!normalized) {
    return null;
  }
  const parsed = Number.parseFloat(normalized);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return Math.round(parsed * 100);
};

const parseSliderOrder = (value?: string) => {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

const parseImageOrder = (value?: string) => {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed
      .filter((item) => typeof item === 'string')
      .map((item) => {
        const trimmed = item.split('?')[0];
        const parts = trimmed.split('/');
        return parts[parts.length - 1] || trimmed;
      });
  } catch {
    return null;
  }
};

const parseStock = (value?: string) => {
  if (value === undefined || value === '') {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

const parsePositiveInt = (value?: string, min = 1, max = 100000) => {
  if (value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
};

const generateNumericCode = (length: number) => {
  const safeLength = Math.max(1, Math.floor(length));
  const min = safeLength === 1 ? 0 : Math.pow(10, safeLength - 1);
  const max = Math.pow(10, safeLength);
  return String(randomInt(min, max)).padStart(safeLength, '0');
};

const parseIntegerField = (value: unknown, min: number, max: number) => {
  const parsed =
    typeof value === 'number'
      ? Math.round(value)
      : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
};

const parseFillRatioField = (value: unknown) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value.replace(',', '.'))
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    return null;
  }
  return Math.round(parsed * 100) / 100;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const toTrimmedString = (value: unknown) => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
};

const parseNumber = (value: unknown) => {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
      ? Number.parseFloat(value.replace(',', '.'))
      : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const parseCdekTariffCode = (value: unknown) => {
  const parsed =
    typeof value === 'number'
      ? Math.round(value)
      : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const extractCdekDestinationCode = (requestPayload: Record<string, unknown>) => {
  const directCode =
    toTrimmedString(requestPayload.office_code) ??
    toTrimmedString(requestPayload.officeCode) ??
    toTrimmedString(requestPayload.destinationCode);
  if (directCode) {
    return directCode;
  }

  const toLocation = asRecord(requestPayload.to_location ?? requestPayload.toLocation);
  if (!toLocation) {
    return undefined;
  }

  return (
    toTrimmedString(toLocation.code) ??
    toTrimmedString(toLocation.office_code) ??
    toTrimmedString(toLocation.officeCode) ??
    toTrimmedString(toLocation.pvz_code) ??
    toTrimmedString(toLocation.pvzCode)
  );
};

const attachCdekQuoteTokens = (
  responseBody: unknown,
  requestPayload: Record<string, unknown>
) => {
  const parcelsRaw = Array.isArray(requestPayload.goods)
    ? requestPayload.goods
    : Array.isArray(requestPayload.packages)
    ? requestPayload.packages
    : [];
  const parcelsHash = hashShippingParcels(normalizeShippingParcels(parcelsRaw));
  const destinationCode = extractCdekDestinationCode(requestPayload);

  const attachToTariffArray = (tariffs: unknown[]) =>
    tariffs.map((item) => {
      const record = asRecord(item);
      if (!record) {
        return item;
      }

      const deliverySum = parseNumber(record.delivery_sum);
      if (!Number.isFinite(deliverySum) || deliverySum < 0) {
        return item;
      }

      const tariffCode = parseCdekTariffCode(record.tariff_code);
      const quoteToken = createDeliveryQuoteToken({
        provider: 'cdek',
        costCents: Math.round(deliverySum * 100),
        parcelsHash,
        destinationCode,
        tariffCode
      });

      return {
        ...record,
        quote_token: quoteToken
      };
    });

  if (Array.isArray(responseBody)) {
    return attachToTariffArray(responseBody);
  }

  const record = asRecord(responseBody);
  if (!record) {
    return responseBody;
  }

  const listKeys = ['tariff_codes', 'tariffCodes', 'tariffs', 'items'];
  for (const key of listKeys) {
    const list = record[key];
    if (Array.isArray(list)) {
      return {
        ...record,
        [key]: attachToTariffArray(list)
      };
    }
  }

  return responseBody;
};

const b2bUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureB2BUploadTempDir();
      cb(null, B2B_UPLOAD_TMP_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${randomUUID()}${ext}`);
    }
  }),
  limits: {
    fileSize: B2B_CARD_MAX_FILE_SIZE,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (B2B_CARD_ALLOWED_MIME.has(file.mimetype) && B2B_CARD_ALLOWED_EXTENSIONS.has(ext)) {
      cb(null, true);
      return;
    }
    cb(
      new Error(
        'Допустимы только PDF, DOC, DOCX, XLS, XLSX, JPG или PNG файлы карточки предприятия.'
      )
    );
  }
});

const mapProduct = (row: ProductRow) => ({
  id: row.id,
  name: row.name,
  sku: row.sku,
  description: row.description ?? '',
  priceCents: row.price_cents,
  category: row.category_slug,
  images: (row.images ?? []).map(toPublicUrl),
  showInSlider: row.show_in_slider,
  sliderOrder: row.slider_order,
  weightGrams: row.weight_grams,
  lengthCm: row.length_cm,
  widthCm: row.width_cm,
  heightCm: row.height_cm,
  stock: row.stock,
  isHidden: row.is_hidden,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapBoxType = (row: BoxTypeRow) => ({
  id: row.id,
  name: row.name,
  lengthCm: row.length_cm,
  widthCm: row.width_cm,
  heightCm: row.height_cm,
  maxWeightGrams: row.max_weight_grams,
  emptyWeightGrams: row.empty_weight_grams,
  fillRatio: row.fill_ratio,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapDeliveryProvider = (row: DeliveryProviderRow) => ({
  key: row.key,
  name: row.name,
  isEnabled: row.is_enabled,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapCategory = (row: CategoryRow) => ({
  slug: row.slug,
  name: row.name,
  image: row.image ? toPublicUrl(row.image) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapCatalogPage = (row: CatalogPageRow) => ({
  key: row.key,
  name: row.name,
  image: row.image ? toPublicUrl(row.image) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapSiteBanner = (row: SiteBannerRow) => ({
  key: row.key,
  desktopImage: row.desktop_image ? toPublicUrl(row.desktop_image) : null,
  mobileImage: row.mobile_image ? toPublicUrl(row.mobile_image) : null,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapOrder = (row: OrderRow) => ({
  id: row.id,
  orderNumber: row.order_number,
  status: row.status,
  fullName: row.full_name,
  phone: row.phone,
  email: row.email,
  pickupPoint: row.pickup_point ?? '',
  deliveryCostCents: row.delivery_cost_cents,
  totalCents: row.total_cents,
  paymentProvider: row.payment_provider ?? '',
  paymentId: row.payment_id ?? '',
  paymentStatus: row.payment_status ?? '',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapOrderItem = (row: OrderItemRow) => ({
  productId: row.product_id,
  name: row.name,
  priceCents: row.price_cents,
  quantity: row.quantity
});

const formatRubles = (cents: number) =>
  `${new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  }).format(cents / 100)} ₽`;

const toAmountValue = (cents: number) => (Math.max(0, cents) / 100).toFixed(2);

const toReceiptQuantity = (quantity: number) => {
  const normalized = Number.isFinite(quantity) ? quantity : 0;
  return normalized <= 0 ? '1.000' : normalized.toFixed(3);
};

const normalizeReceiptDescription = (value: string, fallback: string) => {
  const trimmed = value.trim();
  const base = trimmed || fallback;
  return base.length > 128 ? `${base.slice(0, 125)}...` : base;
};

const buildYooKassaTestReceipt = (order: OrderRow, amountCents: number): YooKassaReceipt => {
  const customerEmail = order.email.trim();
  const customerPhone = formatPhoneE164(order.phone);

  return {
    customer: {
      full_name: order.full_name.trim() || undefined,
      email: customerEmail || undefined,
      phone: customerPhone || undefined
    },
    tax_system_code: getYooKassaReceiptTaxSystemCode(),
    items: [
      {
        description: `Тестовая оплата заказа №${order.order_number}`,
        quantity: '1.000',
        amount: {
          value: toAmountValue(amountCents),
          currency: 'RUB'
        },
        vat_code: getYooKassaReceiptVatCode(),
        payment_mode: 'full_payment',
        payment_subject: 'service'
      }
    ]
  };
};

const buildYooKassaOrderReceipt = (
  order: OrderRow,
  orderItems: OrderItemRow[],
  amountCents: number
): YooKassaReceipt => {
  const vatCode = getYooKassaReceiptVatCode();
  const items: YooKassaReceipt['items'] = orderItems
    .filter((item) => item.quantity > 0 && item.price_cents >= 0)
    .map((item) => ({
      description: normalizeReceiptDescription(item.name, `Товар ${item.product_id}`),
      quantity: toReceiptQuantity(item.quantity),
      amount: {
        value: toAmountValue(item.price_cents),
        currency: 'RUB' as const
      },
      vat_code: vatCode,
      payment_mode: 'full_payment',
      payment_subject: 'commodity'
    }));

  if (order.delivery_cost_cents > 0) {
    items.push({
      description: 'Доставка',
      quantity: '1.000',
      amount: {
        value: toAmountValue(order.delivery_cost_cents),
        currency: 'RUB' as const
      },
      vat_code: vatCode,
      payment_mode: 'full_payment',
      payment_subject: 'service'
    });
  }

  const receiptTotalCents =
    orderItems.reduce((sum, item) => sum + item.price_cents * item.quantity, 0) +
    order.delivery_cost_cents;

  if (items.length === 0 || receiptTotalCents !== amountCents) {
    throw new Error(
      `Receipt total mismatch: expected ${amountCents} cents, got ${receiptTotalCents} cents`
    );
  }

  const customerEmail = order.email.trim();
  const customerPhone = formatPhoneE164(order.phone);

  return {
    customer: {
      full_name: order.full_name.trim() || undefined,
      email: customerEmail || undefined,
      phone: customerPhone || undefined
    },
    tax_system_code: getYooKassaReceiptTaxSystemCode(),
    items
  };
};

const buildPaidOrderNotification = (order: OrderRow, items: OrderItemRow[]) => {
  const pickupPoint = order.pickup_point?.trim() ? order.pickup_point : 'не указан';
  const phone = formatPhoneE164(order.phone);
  const orderItemsBlock =
    items.length > 0
      ? items
          .map((item, index) => {
            const lineTotal = item.price_cents * item.quantity;
            return `🔹 ${index + 1}. ${item.name} x${item.quantity} — ${formatRubles(lineTotal)}`;
          })
          .join('\n')
      : '🔹 Состав заказа пуст';

  return [
    '✅ Новый оплаченный заказ',
    `🧾 Номер заказа: ${order.order_number}`,
    `👤 ФИО: ${order.full_name}`,
    `📞 Телефон: ${phone}`,
    `✉️ Email: ${order.email}`,
    '📦 Состав заказа:',
    orderItemsBlock,
    `🚚 Доставка: ${formatRubles(order.delivery_cost_cents)}`,
    `💰 Стоимость: ${formatRubles(order.total_cents)}`,
    `📍 Пункт выдачи: ${pickupPoint}`
  ].join('\n');
};

const mapUser = (user: {
  id: string;
  phone: string;
  role: string;
  email?: string | null;
  full_name?: string | null;
}) => ({
  id: user.id,
  phone: user.phone,
  role: user.role,
  email: user.email ?? '',
  fullName: user.full_name ?? ''
});

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const isTelegramWebhookAllowed = (req: Request, secret?: string) => {
  const expectedSecret = secret?.trim();
  if (!expectedSecret) {
    return false;
  }
  const providedSecret = req.header('x-telegram-bot-api-secret-token')?.trim();
  if (!providedSecret) {
    return false;
  }
  return providedSecret === expectedSecret;
};

const getPublicOrigin = (req: Request) => {
  const configured = getYooKassaReturnBaseUrl();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  const originHeader = req.header('origin');
  if (originHeader) {
    return originHeader.replace(/\/+$/, '');
  }

  const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = forwardedHost || req.get('host');
  return `${protocol}://${host}`;
};

const getYooKassaReturnUrl = (req: Request, orderId: string) =>
  `${getPublicOrigin(req)}/payment/${orderId}?fromYooKassa=1`;

const isYooKassaWebhookAllowed = (req: Request) => {
  const expectedSecret = getYooKassaWebhookSecret();
  if (!expectedSecret) {
    return false;
  }
  const providedSecret = req.header('x-yookassa-webhook-secret')?.trim();
  if (!providedSecret) {
    return false;
  }
  return providedSecret === expectedSecret;
};

const finalizePaidOrder = async (order: OrderRow) => {
  await replaceCartItems(order.user_id, []);
  try {
    const orderItems = await listOrderItemsForUser(order.id, order.user_id);
    const notification = buildPaidOrderNotification(order, orderItems);
    await sendOrderTelegramMessage(notification);
  } catch (error) {
    console.error(`Failed to send paid order notification for order ${order.id}`, error);
  }
};

const syncOrderWithYooKassaPayment = async (order: OrderRow, payment: YooKassaPayment) => {
  await updateOrderPayment(order.id, {
    provider: 'yookassa',
    paymentId: payment.id,
    paymentStatus: payment.status
  });

  if (payment.status === 'succeeded' || payment.paid === true) {
    if (order.status === 'paid') {
      const paidOrder = await findOrderById(order.id);
      return paidOrder ?? order;
    }
    const paidOrder = await markOrderPaidById(order.id);
    if (paidOrder) {
      await finalizePaidOrder(paidOrder);
      return paidOrder;
    }
  }

  if (payment.status === 'canceled') {
    const canceledOrder = await updateOrderPaymentStatusById(order.id, 'canceled');
    return canceledOrder ?? order;
  }

  const refreshed = await findOrderById(order.id);
  return refreshed ?? order;
};

const normalizeCartItems = (input: unknown): CartSyncItem[] => {
  if (!Array.isArray(input)) {
    return [];
  }

  const merged = new Map<string, number>();
  for (const item of input) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const candidate = item as { productId?: unknown; quantity?: unknown };
    const productId = typeof candidate.productId === 'string' ? candidate.productId : '';
    const parsedQuantity =
      typeof candidate.quantity === 'number'
        ? candidate.quantity
        : Number.parseInt(String(candidate.quantity ?? ''), 10);

    if (
      !productId ||
      !isUuid(productId) ||
      Number.isNaN(parsedQuantity) ||
      parsedQuantity <= 0
    ) {
      continue;
    }

    const current = merged.get(productId) ?? 0;
    merged.set(productId, current + parsedQuantity);
  }

  return Array.from(merged.entries()).map(([productId, quantity]) => ({
    productId,
    quantity
  }));
};

const mapCartItem = (row: CartItemRow) => {
  const image = row.images?.[0];
  return {
    id: row.product_id,
    name: row.name,
    priceCents: row.price_cents,
    image: image ? toPublicUrl(image) : null,
    quantity: row.quantity,
    stock: row.stock,
    weightGrams: row.weight_grams,
    lengthCm: row.length_cm,
    widthCm: row.width_cm,
    heightCm: row.height_cm
  };
};

export const createApp = () => {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);

  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin || isCorsOriginAllowed(origin)) {
          callback(null, true);
          return;
        }
        callback(null, false);
      },
      credentials: true
    })
  );
  app.use(
    express.json({
      limit: '2mb',
      verify: (req, _res, buffer) => {
        (req as RawBodyRequest).rawBody = buffer.toString('utf8');
      }
    })
  );
  app.use(
    '/uploads',
    (_req: Request, res: Response, next: NextFunction) => {
      applyUploadsSecurityHeaders(res);
      next();
    },
    express.static(path.join(process.cwd(), 'uploads'), {
      fallthrough: false,
      index: false,
      setHeaders: (res, filePath) => {
        applyUploadsSecurityHeaders(res);
        const ext = path.extname(filePath).toLowerCase();
        if (!SAFE_UPLOAD_STATIC_EXTENSIONS.has(ext)) {
          res.setHeader('Content-Disposition', 'attachment');
        }
      }
    })
  );

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/api/telegram-gateway/report', (req: Request, res: Response) => {
    const rawBody = (req as RawBodyRequest).rawBody ?? '';
    const timestamp = req.header('X-Telegram-Gateway-Timestamp') ?? '';
    const signature = req.header('X-Telegram-Gateway-Signature') ?? '';

    if (!verifyTelegramGatewaySignature(rawBody, timestamp, signature)) {
      res.status(401).json({ error: 'Invalid Telegram Gateway signature' });
      return;
    }

    console.log('[TELEGRAM GATEWAY] Delivery report', req.body);
    res.json({ ok: true });
  });

  app.all('/api/cdek/widget', async (req: Request, res: Response) => {
    try {
      const cdekEnabled = await isDeliveryProviderEnabled('cdek');
      if (!cdekEnabled) {
        res.status(503).json({ message: 'CDEK delivery is disabled' });
        return;
      }

      const response = await proxyCdekWidgetRequest(req.query, req.body);
      for (const [key, value] of response.forwardedHeaders) {
        res.setHeader(key, value);
      }
      res.setHeader('X-Service-Version', 'node-1.0.0');
      const responseBody =
        response.action === 'calculate'
          ? attachCdekQuoteTokens(response.body, response.requestPayload)
          : response.body;
      res.status(response.status).json(responseBody);
    } catch (error) {
      if (error instanceof CdekProxyError) {
        if (error.status >= 500) {
          console.error('CDEK proxy error', {
            message: error.message,
            details: error.details
          });
        }
        res.status(error.status).json({
          message: error.message,
          details: error.details
        });
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Failed to process CDEK request';
      console.error('CDEK proxy unexpected error', error);
      res.status(500).json({ message });
    }
  });

  app.get('/api/pickup-points/dellin', async (req: Request, res: Response) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (query.length < 2) {
      res.status(400).json({ error: 'Query must contain at least 2 characters' });
      return;
    }

    try {
      const providerEnabled = await isDeliveryProviderEnabled('dellin');
      if (!providerEnabled) {
        res.status(503).json({ error: 'Delovye Linii delivery is disabled' });
        return;
      }

      const items = await searchDellinPickupPoints(query);
      res.json({ items });
    } catch (error) {
      if (error instanceof PickupPointProxyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('Failed to load Delovye Linii pickup points', error);
      res.status(500).json({ error: 'Failed to load Delovye Linii pickup points' });
    }
  });

  app.get('/api/pickup-points/russian_post', async (req: Request, res: Response) => {
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (query.length < 2) {
      res.status(400).json({ error: 'Query must contain at least 2 characters' });
      return;
    }

    try {
      const providerEnabled = await isDeliveryProviderEnabled('russian_post');
      if (!providerEnabled) {
        res.status(503).json({ error: 'Russian Post delivery is disabled' });
        return;
      }

      const items = await searchRussianPostPickupPoints(query);
      res.json({ items });
    } catch (error) {
      if (error instanceof PickupPointProxyError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      console.error('Failed to load Russian Post pickup points', error);
      res.status(500).json({ error: 'Failed to load Russian Post pickup points' });
    }
  });

  app.post('/api/shipping/estimate', async (req: Request, res: Response) => {
    const providerRaw = typeof req.body?.provider === 'string' ? req.body.provider.trim() : '';
    const provider: ShippingEstimateProvider | null =
      providerRaw === 'dellin' || providerRaw === 'russian_post'
        ? providerRaw
        : null;
    if (!provider) {
      res.status(400).json({ error: 'Unsupported provider' });
      return;
    }

    const rawParcels: unknown[] = Array.isArray(req.body?.parcels) ? req.body.parcels : [];
    const parcels = rawParcels
      .filter((parcel: unknown) => parcel && typeof parcel === 'object')
      .map((parcel: unknown) => {
        const p = parcel as {
          length?: unknown;
          width?: unknown;
          height?: unknown;
          weight?: unknown;
        };
        return {
          length:
            typeof p.length === 'number'
              ? p.length
              : Number.parseFloat(String(p.length ?? '0')),
          width:
            typeof p.width === 'number' ? p.width : Number.parseFloat(String(p.width ?? '0')),
          height:
            typeof p.height === 'number'
              ? p.height
              : Number.parseFloat(String(p.height ?? '0')),
          weight:
            typeof p.weight === 'number'
              ? p.weight
              : Number.parseFloat(String(p.weight ?? '0'))
        };
      });

    const destinationCity =
      typeof req.body?.destinationCity === 'string' ? req.body.destinationCity : '';
    const destinationCode =
      typeof req.body?.destinationCode === 'string' ? req.body.destinationCode : '';
    const destinationAddress =
      typeof req.body?.destinationAddress === 'string' ? req.body.destinationAddress : '';

    try {
      const providerEnabled = await isDeliveryProviderEnabled(provider);
      if (!providerEnabled) {
        res.status(503).json({ error: 'Delivery provider is disabled' });
        return;
      }

      const estimate = await calculateShippingWithProviderApi({
        provider,
        parcels,
        destinationCity,
        destinationCode,
        destinationAddress
      });
      const parcelsHash = hashShippingParcels(normalizeShippingParcels(parcels));
      const quoteToken = createDeliveryQuoteToken({
        provider,
        costCents: estimate.estimatedCostCents,
        parcelsHash,
        destinationCode: destinationCode.trim() || undefined
      });
      const debug = getShippingProviderApiDebug(estimate);
      console.log('[SHIPPING]', {
        provider,
        source: debug.source,
        destinationCode,
        destinationCity
      });
      res.json({
        ...estimate,
        quoteToken
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to calculate shipping cost';
      res.status(502).json({ error: message });
    }
  });

  app.get('/api/categories', (_req: Request, res: Response) => {
    listCategories()
      .then((items) => res.json({ items: items.map(mapCategory) }))
      .catch(() => res.status(500).json({ error: 'Failed to load categories' }));
  });

  app.get('/api/catalog-page', async (_req: Request, res: Response) => {
    try {
      const item = await getCatalogPage();
      if (!item) {
        res.json({
          page: {
            key: 'catalog',
            name: 'Разделы каталога',
            image: null,
            createdAt: '',
            updatedAt: ''
          }
        });
        return;
      }

      res.json({ page: mapCatalogPage(item) });
    } catch {
      res.status(500).json({ error: 'Failed to load catalog page settings' });
    }
  });

  app.put(
    '/api/catalog-page',
    authenticate,
    requireAdmin,
    upload.single('image'),
    async (req: Request, res: Response) => {
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const uploadedFilename = req.file?.filename;

      if (!name) {
        if (uploadedFilename) {
          removeUploadedFiles([uploadedFilename]);
        }
        res.status(400).json({ error: 'Catalog page name is required' });
        return;
      }

      try {
        const current = await getCatalogPage();
        const updated = await updateCatalogPage({
          name,
          image: uploadedFilename ?? null
        });

        if (
          uploadedFilename &&
          current?.image &&
          current.image !== uploadedFilename
        ) {
          removeUploadedFiles([current.image]);
        }

        res.json({ page: mapCatalogPage(updated) });
      } catch {
        if (uploadedFilename) {
          removeUploadedFiles([uploadedFilename]);
        }
        res.status(500).json({ error: 'Failed to update catalog page settings' });
      }
    }
  );

  app.put(
    '/api/categories/:slug',
    authenticate,
    requireAdmin,
    upload.single('image'),
    async (req: Request, res: Response) => {
      const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
      const nextSlug =
        typeof req.body?.slug === 'string' ? req.body.slug.trim().toLowerCase() : slug;
      const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const uploadedFilename = req.file?.filename;
      const removeImage =
        req.body?.removeImage === 'true' ||
        req.body?.removeImage === '1' ||
        req.body?.removeImage === true;
      const hasImageUpdate = Boolean(uploadedFilename) || removeImage;
      const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

      if (!slug || !name || !nextSlug) {
        if (uploadedFilename) {
          removeUploadedFiles([uploadedFilename]);
        }
        res.status(400).json({ error: 'Название и URL категории обязательны' });
        return;
      }
      if (!slugPattern.test(nextSlug)) {
        if (uploadedFilename) {
          removeUploadedFiles([uploadedFilename]);
        }
        res
          .status(400)
          .json({ error: 'URL категории должен содержать только латиницу, цифры и дефис' });
        return;
      }

      try {
        const current = await findCategoryBySlug(slug);
        if (!current) {
          if (uploadedFilename) {
            removeUploadedFiles([uploadedFilename]);
          }
          res.status(404).json({ error: 'Category not found' });
          return;
        }

        const updated = await updateCategory(slug, {
          slug: nextSlug,
          name,
          image: uploadedFilename ?? null,
          hasImageUpdate
        });

        if (!updated) {
          if (uploadedFilename) {
            removeUploadedFiles([uploadedFilename]);
          }
          res.status(404).json({ error: 'Category not found' });
          return;
        }

        if (current.image && current.image !== updated.image) {
          removeUploadedFiles([current.image]);
        }

        res.json({ item: mapCategory(updated) });
      } catch (error) {
        if (uploadedFilename) {
          removeUploadedFiles([uploadedFilename]);
        }
        const maybePg = error as { code?: string };
        if (maybePg.code === '23505') {
          res.status(409).json({ error: 'Такой URL категории уже используется' });
          return;
        }
        res.status(500).json({ error: 'Failed to update category' });
      }
    }
  );

  app.delete('/api/categories/:slug', authenticate, requireAdmin, async (req: Request, res: Response) => {
    const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    if (!slug) {
      res.status(400).json({ error: '\u0423\u043a\u0430\u0436\u0438\u0442\u0435 URL \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u0438.' });
      return;
    }

    try {
      const current = await findCategoryBySlug(slug);
      if (!current) {
        res.status(404).json({ error: '\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
        return;
      }

      const productsCount = await countCategoryProducts(slug);
      if (productsCount > 0) {
        res.status(409).json({
          error:
            '\u041d\u0435\u043b\u044c\u0437\u044f \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044e: \u0432 \u043d\u0435\u0439 \u0435\u0441\u0442\u044c \u0442\u043e\u0432\u0430\u0440\u044b.'
        });
        return;
      }

      const deleted = await deleteCategory(slug);
      if (!deleted) {
        res.status(404).json({ error: '\u041a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044f \u043d\u0435 \u043d\u0430\u0439\u0434\u0435\u043d\u0430.' });
        return;
      }

      if (deleted.image) {
        removeUploadedFiles([deleted.image]);
      }

      res.json({ ok: true });
    } catch {
      res.status(500).json({
        error:
          '\u041d\u0435 \u0443\u0434\u0430\u043b\u043e\u0441\u044c \u0443\u0434\u0430\u043b\u0438\u0442\u044c \u043a\u0430\u0442\u0435\u0433\u043e\u0440\u0438\u044e.'
      });
    }
  });

  app.get('/api/box-types', async (_req: Request, res: Response) => {
    try {
      const items = await listBoxTypes();
      res.json({ items: items.map(mapBoxType) });
    } catch {
      res.status(500).json({ error: 'Failed to load box types' });
    }
  });

  app.get('/api/delivery-providers', async (_req: Request, res: Response) => {
    try {
      const items = await listDeliveryProviders();
      res.json({ items: items.map(mapDeliveryProvider) });
    } catch {
      res.status(500).json({ error: 'Failed to load delivery providers' });
    }
  });

  app.put(
    '/api/delivery-providers/:key',
    authenticate,
    requireAdmin,
    async (req: Request, res: Response) => {
      const keyRaw = typeof req.params.key === 'string' ? req.params.key.trim() : '';
      if (!isDeliveryProviderKey(keyRaw)) {
        res.status(400).json({ error: 'Unsupported delivery provider' });
        return;
      }

      if (typeof req.body?.isEnabled !== 'boolean') {
        res.status(400).json({ error: 'isEnabled must be boolean' });
        return;
      }

      try {
        const item = await updateDeliveryProviderEnabled(keyRaw, req.body.isEnabled);
        if (!item) {
          res.status(404).json({ error: 'Delivery provider not found' });
          return;
        }
        res.json(mapDeliveryProvider(item));
      } catch {
        res.status(500).json({ error: 'Failed to update delivery provider' });
      }
    }
  );

  app.get('/api/banners/home', async (_req: Request, res: Response) => {
    try {
      const item = await getHomeBanner();
      if (!item) {
        res.json({
          banner: {
            key: 'home',
            desktopImage: null,
            mobileImage: null,
            createdAt: '',
            updatedAt: ''
          }
        });
        return;
      }
      res.json({ banner: mapSiteBanner(item) });
    } catch {
      res.status(500).json({ error: 'Failed to load home banner' });
    }
  });

  app.put(
    '/api/banners/home',
    authenticate,
    requireAdmin,
    upload.fields([
      { name: 'desktopImage', maxCount: 1 },
      { name: 'mobileImage', maxCount: 1 }
    ]),
    async (req: Request, res: Response) => {
      const files =
        ((req.files ?? {}) as {
          [fieldname: string]: Express.Multer.File[];
        }) ?? {};
      const desktopFile = files.desktopImage?.[0];
      const mobileFile = files.mobileImage?.[0];
      const uploadedFilenames = [desktopFile?.filename, mobileFile?.filename].filter(
        (value): value is string => Boolean(value)
      );

      if (!desktopFile && !mobileFile) {
        res.status(400).json({ error: 'At least one banner image is required' });
        return;
      }

      try {
        const current = await getHomeBanner();
        const updated = await updateHomeBanner({
          desktopImage: desktopFile?.filename ?? null,
          mobileImage: mobileFile?.filename ?? null
        });

        const oldFilenamesToDelete = new Set<string>();
        if (
          desktopFile &&
          current?.desktop_image &&
          current.desktop_image !== desktopFile.filename
        ) {
          oldFilenamesToDelete.add(current.desktop_image);
        }
        if (
          mobileFile &&
          current?.mobile_image &&
          current.mobile_image !== mobileFile.filename
        ) {
          oldFilenamesToDelete.add(current.mobile_image);
        }
        if (oldFilenamesToDelete.size > 0) {
          removeUploadedFiles(Array.from(oldFilenamesToDelete));
        }

        res.json({ banner: mapSiteBanner(updated) });
      } catch {
        if (uploadedFilenames.length > 0) {
          removeUploadedFiles(uploadedFilenames);
        }
        res.status(500).json({ error: 'Failed to update home banner' });
      }
    }
  );

  app.post('/api/box-types', authenticate, requireAdmin, async (req: Request, res: Response) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const lengthCm = parseIntegerField(req.body.lengthCm, 1, 500);
    const widthCm = parseIntegerField(req.body.widthCm, 1, 500);
    const heightCm = parseIntegerField(req.body.heightCm, 1, 500);
    const maxWeightGrams = parseIntegerField(req.body.maxWeightGrams, 1, 100000);
    const emptyWeightGrams = parseIntegerField(req.body.emptyWeightGrams, 0, 100000);
    const fillRatio = parseFillRatioField(req.body.fillRatio);
    const sortOrder = parseIntegerField(req.body.sortOrder, 0, 100000);

    const errors: string[] = [];
    if (!name) {
      errors.push('Название коробки обязательно');
    }
    if (lengthCm === null || widthCm === null || heightCm === null) {
      errors.push('Некорректные габариты коробки');
    }
    if (maxWeightGrams === null || emptyWeightGrams === null) {
      errors.push('Некорректный вес коробки');
    }
    if (fillRatio === null) {
      errors.push('Коэффициент заполнения должен быть от 0.01 до 1');
    }
    if (sortOrder === null) {
      errors.push('Некорректный порядок сортировки');
    }
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    try {
      const item = await createBoxType({
        name,
        lengthCm: lengthCm ?? 0,
        widthCm: widthCm ?? 0,
        heightCm: heightCm ?? 0,
        maxWeightGrams: maxWeightGrams ?? 0,
        emptyWeightGrams: emptyWeightGrams ?? 0,
        fillRatio: fillRatio ?? 0,
        sortOrder: sortOrder ?? 0
      });
      res.status(201).json(mapBoxType(item));
    } catch {
      res.status(500).json({ error: 'Failed to create box type' });
    }
  });

  app.put('/api/box-types/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const lengthCm = parseIntegerField(req.body.lengthCm, 1, 500);
    const widthCm = parseIntegerField(req.body.widthCm, 1, 500);
    const heightCm = parseIntegerField(req.body.heightCm, 1, 500);
    const maxWeightGrams = parseIntegerField(req.body.maxWeightGrams, 1, 100000);
    const emptyWeightGrams = parseIntegerField(req.body.emptyWeightGrams, 0, 100000);
    const fillRatio = parseFillRatioField(req.body.fillRatio);
    const sortOrder = parseIntegerField(req.body.sortOrder, 0, 100000);

    const errors: string[] = [];
    if (!name) {
      errors.push('Название коробки обязательно');
    }
    if (lengthCm === null || widthCm === null || heightCm === null) {
      errors.push('Некорректные габариты коробки');
    }
    if (maxWeightGrams === null || emptyWeightGrams === null) {
      errors.push('Некорректный вес коробки');
    }
    if (fillRatio === null) {
      errors.push('Коэффициент заполнения должен быть от 0.01 до 1');
    }
    if (sortOrder === null) {
      errors.push('Некорректный порядок сортировки');
    }
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    try {
      const item = await updateBoxType(req.params.id, {
        name,
        lengthCm: lengthCm ?? 0,
        widthCm: widthCm ?? 0,
        heightCm: heightCm ?? 0,
        maxWeightGrams: maxWeightGrams ?? 0,
        emptyWeightGrams: emptyWeightGrams ?? 0,
        fillRatio: fillRatio ?? 0,
        sortOrder: sortOrder ?? 0
      });
      if (!item) {
        res.status(404).json({ error: 'Box type not found' });
        return;
      }
      res.json(mapBoxType(item));
    } catch {
      res.status(500).json({ error: 'Failed to update box type' });
    }
  });

  app.delete('/api/box-types/:id', authenticate, requireAdmin, async (req: Request, res: Response) => {
    try {
      const item = await deleteBoxType(req.params.id);
      if (!item) {
        res.status(404).json({ error: 'Box type not found' });
        return;
      }
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'Failed to delete box type' });
    }
  });

  app.get('/api/products', (req: Request, res: Response) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const featured = req.query.featured === 'true';
    const includeHidden = req.query.includeHidden === 'true';

    if (includeHidden) {
      const { token } = getRequestAuthToken(req);
      if (!token) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      try {
        const payload = verifyToken(token);
        if (payload.role !== 'admin') {
          res.status(403).json({ error: 'Forbidden' });
          return;
        }
      } catch {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
    }

    listProducts(category, featured, includeHidden)
      .then((items) => res.json({ items: items.map(mapProduct) }))
      .catch(() => res.status(500).json({ error: 'Failed to load products' }));
  });

  app.get('/api/products/search', async (req: Request, res: Response) => {
    const sku = typeof req.query.sku === 'string' ? req.query.sku.trim() : '';
    const limitRaw = typeof req.query.limit === 'string' ? req.query.limit.trim() : '';
    const limitParsed = Number.parseInt(limitRaw, 10);
    const limit = Number.isFinite(limitParsed) && limitParsed > 0 ? limitParsed : undefined;

    if (!sku) {
      res.json({
        items: [],
        total: 0,
        usedFallback: false,
        fallbackPrefix: null
      });
      return;
    }

    try {
      const result = await searchProductsBySku(sku, limit);
      res.json({
        items: result.items.map(mapProduct),
        total: result.total,
        usedFallback: result.usedFallback,
        fallbackPrefix: result.fallbackPrefix
      });
    } catch {
      res.status(500).json({ error: 'Failed to search products' });
    }
  });

  app.post('/api/products', authenticate, requireAdmin, upload.array('images', 5), async (req, res) => {
    const files = (req.files ?? []) as Express.Multer.File[];
    const filenames = files.map((file) => file.filename);
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const sku = typeof req.body.sku === 'string' ? req.body.sku.trim() : '';
    const description =
      typeof req.body.description === 'string' ? req.body.description.trim() : null;
    const category = typeof req.body.category === 'string' ? req.body.category : '';
    const priceCents = parsePriceCents(
      typeof req.body.price === 'string' ? req.body.price : undefined
    );
    const showInSlider = req.body.showInSlider === 'true';
    const sliderOrder = parseSliderOrder(
      typeof req.body.sliderOrder === 'string' ? req.body.sliderOrder : undefined
    );
    const isHidden = req.body.isHidden === 'true';
    const stock = parseStock(typeof req.body.stock === 'string' ? req.body.stock : undefined);
    const weightGrams = parsePositiveInt(
      typeof req.body.weightGrams === 'string' ? req.body.weightGrams : undefined,
      1,
      50000
    );
    const lengthCm = parsePositiveInt(
      typeof req.body.lengthCm === 'string' ? req.body.lengthCm : undefined,
      1,
      300
    );
    const widthCm = parsePositiveInt(
      typeof req.body.widthCm === 'string' ? req.body.widthCm : undefined,
      1,
      300
    );
    const heightCm = parsePositiveInt(
      typeof req.body.heightCm === 'string' ? req.body.heightCm : undefined,
      1,
      300
    );

    const errors: string[] = [];

    if (!name) {
      errors.push('Название обязательно');
    }

    if (!sku) {
      errors.push('SKU обязателен');
    }

    if (priceCents === null) {
      errors.push('Цена обязательна');
    }

    if (sliderOrder === null) {
      errors.push('Некорректный порядок в слайдере');
    }

    if (!category || !(await isValidCategory(category))) {
      errors.push('Некорректная категория');
    }

    const existingSku = sku ? await findProductBySku(sku) : null;
    if (existingSku) {
      errors.push('SKU уже используется');
    }

    if (stock === null) {
      errors.push('Некорректный остаток');
    }

    if (weightGrams === null) {
      errors.push('Некорректный вес (граммы)');
    }

    if (lengthCm === null || widthCm === null || heightCm === null) {
      errors.push('Некорректные габариты (см)');
    }

    if (errors.length > 0) {
      removeUploadedFiles(filenames);
      res.status(400).json({ errors });
      return;
    }

    try {
      const product = await createProduct({
        name,
        sku,
        description,
        priceCents: priceCents ?? 0,
        category,
        images: filenames,
        showInSlider,
        sliderOrder: sliderOrder ?? 0,
        weightGrams: weightGrams ?? 500,
        lengthCm: lengthCm ?? 10,
        widthCm: widthCm ?? 10,
        heightCm: heightCm ?? 10,
        stock: stock ?? 0,
        isHidden
      });

      res.status(201).json(mapProduct(product));
    } catch {
      removeUploadedFiles(filenames);
      res.status(500).json({ error: 'Failed to create product' });
    }
  });

  app.put('/api/products/:id', authenticate, requireAdmin, upload.array('images', 5), async (req, res) => {
    const { id } = req.params;
    const existing = await findProductById(id);
    if (!existing) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const files = (req.files ?? []) as Express.Multer.File[];
    const filenames = files.map((file) => file.filename);
    const imagesOrder =
      typeof req.body.imagesOrder === 'string'
        ? parseImageOrder(req.body.imagesOrder)
        : null;
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const sku = typeof req.body.sku === 'string' ? req.body.sku.trim() : '';
    const description =
      typeof req.body.description === 'string' ? req.body.description.trim() : null;
    const category = typeof req.body.category === 'string' ? req.body.category : '';
    const priceCents = parsePriceCents(
      typeof req.body.price === 'string' ? req.body.price : undefined
    );
    const showInSlider = req.body.showInSlider === 'true';
    const sliderOrder = parseSliderOrder(
      typeof req.body.sliderOrder === 'string' ? req.body.sliderOrder : undefined
    );
    const isHidden = req.body.isHidden === 'true';
    const stock =
      typeof req.body.stock === 'string'
        ? parseStock(req.body.stock)
        : existing.stock ?? 0;
    const weightGrams =
      typeof req.body.weightGrams === 'string'
        ? parsePositiveInt(req.body.weightGrams, 1, 50000)
        : existing.weight_grams ?? 500;
    const lengthCm =
      typeof req.body.lengthCm === 'string'
        ? parsePositiveInt(req.body.lengthCm, 1, 300)
        : existing.length_cm ?? 10;
    const widthCm =
      typeof req.body.widthCm === 'string'
        ? parsePositiveInt(req.body.widthCm, 1, 300)
        : existing.width_cm ?? 10;
    const heightCm =
      typeof req.body.heightCm === 'string'
        ? parsePositiveInt(req.body.heightCm, 1, 300)
        : existing.height_cm ?? 10;

    const errors: string[] = [];

    if (!name) {
      errors.push('Название обязательно');
    }

    if (!sku) {
      errors.push('SKU обязателен');
    }

    if (priceCents === null) {
      errors.push('Цена обязательна');
    }

    if (sliderOrder === null) {
      errors.push('Некорректный порядок в слайдере');
    }

    if (typeof req.body.stock === 'string' && stock === null) {
      errors.push('Некорректный остаток');
    }

    if (typeof req.body.weightGrams === 'string' && weightGrams === null) {
      errors.push('Некорректный вес (граммы)');
    }

    if (
      (typeof req.body.lengthCm === 'string' && lengthCm === null) ||
      (typeof req.body.widthCm === 'string' && widthCm === null) ||
      (typeof req.body.heightCm === 'string' && heightCm === null)
    ) {
      errors.push('Некорректные габариты (см)');
    }

    if (!category || !(await isValidCategory(category))) {
      errors.push('Некорректная категория');
    }

    const skuOwner = sku ? await findProductBySku(sku) : null;
    if (skuOwner && skuOwner.id !== existing.id) {
      errors.push('SKU уже используется');
    }

    if (errors.length > 0) {
      removeUploadedFiles(filenames);
      res.status(400).json({ errors });
      return;
    }

    const currentImages = existing.images ?? [];
    let images = currentImages;
    const replaceImages = req.body.replaceImages === 'true';
    let removeAfterUpdate: string[] = [];

    if (filenames.length > 0) {
      images = filenames;
      removeAfterUpdate = currentImages;
    } else if (replaceImages) {
      images = [];
      removeAfterUpdate = currentImages;
    } else if (imagesOrder && imagesOrder.length > 0) {
      const available = new Set(currentImages);
      const ordered: string[] = [];
      const seen = new Set<string>();
      for (const entry of imagesOrder) {
        if (available.has(entry) && !seen.has(entry)) {
          ordered.push(entry);
          seen.add(entry);
        }
      }
      const missing = currentImages.filter((entry) => !seen.has(entry));
      images = [...ordered, ...missing];
    }

    try {
      const updated = await updateProduct(id, {
        name,
        sku,
        description,
        priceCents: priceCents ?? 0,
        category,
        images,
        showInSlider,
        sliderOrder: sliderOrder ?? 0,
        weightGrams: weightGrams ?? existing.weight_grams ?? 500,
        lengthCm: lengthCm ?? existing.length_cm ?? 10,
        widthCm: widthCm ?? existing.width_cm ?? 10,
        heightCm: heightCm ?? existing.height_cm ?? 10,
        stock: stock ?? existing.stock ?? 0,
        isHidden
      });

      if (!updated) {
        res.status(404).json({ error: 'Product not found' });
        return;
      }

      if (removeAfterUpdate.length > 0) {
        removeUploadedFiles(removeAfterUpdate);
      }
      res.json(mapProduct(updated));
    } catch {
      removeUploadedFiles(filenames);
      res.status(500).json({ error: 'Failed to update product' });
    }
  });

  app.delete('/api/products/:id', authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const removed = await deleteProduct(id);
    if (!removed) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    removeUploadedFiles(removed.images ?? []);
    res.json({ ok: true });
  });

  app.get('/api/cart', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const items = await listCartItems(userId);
      res.json({ items: items.map(mapCartItem) });
    } catch {
      res.status(500).json({ error: 'Failed to load cart' });
    }
  });

  app.post('/api/cart/merge', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const normalized = normalizeCartItems(req.body?.items);

    try {
      const validItems = await filterValidCartItems(normalized);
      await mergeCartItems(userId, validItems);
      const items = await listCartItems(userId);
      res.json({ items: items.map(mapCartItem) });
    } catch {
      res.status(500).json({ error: 'Failed to merge cart' });
    }
  });

  app.put('/api/cart', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const normalized = normalizeCartItems(req.body?.items);

    try {
      const validItems = await filterValidCartItems(normalized);
      await replaceCartItems(userId, validItems);
      const items = await listCartItems(userId);
      res.json({ items: items.map(mapCartItem) });
    } catch {
      res.status(500).json({ error: 'Failed to sync cart' });
    }
  });

  app.post('/api/orders', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const email =
      typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const pickupPoint =
      typeof req.body.pickupPoint === 'string' ? req.body.pickupPoint.trim() : '';
    const pickupPointCode =
      typeof req.body.pickupPointCode === 'string' ? req.body.pickupPointCode.trim() : '';
    const destinationCode =
      typeof req.body.destinationCode === 'string' ? req.body.destinationCode.trim() : '';
    const deliveryProviderRaw =
      typeof req.body.deliveryProvider === 'string' ? req.body.deliveryProvider.trim() : '';
    const deliveryProvider = isDeliveryProviderKey(deliveryProviderRaw)
      ? deliveryProviderRaw
      : null;
    const deliveryQuoteToken =
      typeof req.body.deliveryQuoteToken === 'string' ? req.body.deliveryQuoteToken.trim() : '';
    const deliveryTariffCode = parseCdekTariffCode(req.body.deliveryTariffCode);
    const errors: string[] = [];
    if (!fullName) {
      errors.push('Full name is required');
    }
    if (!phone) {
      errors.push('Phone is required');
    }
    if (!email || !isValidEmail(email)) {
      errors.push('Invalid email');
    }
    if (!pickupPoint) {
      errors.push('Pickup point is required');
    }
    if (!deliveryProvider) {
      errors.push('Unsupported delivery provider');
    }
    if (!pickupPointCode) {
      errors.push('Pickup point code is required');
    }
    if (!deliveryQuoteToken) {
      errors.push('Delivery quote is missing');
    }
    if (deliveryProvider && deliveryProvider !== 'cdek' && !destinationCode) {
      errors.push('Destination code is required');
    }
    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }
    if (!deliveryProvider) {
      res.status(400).json({ error: 'Unsupported delivery provider' });
      return;
    }
    try {
      const providerEnabled = await isDeliveryProviderEnabled(deliveryProvider);
      if (!providerEnabled) {
        res.status(503).json({ error: 'Delivery provider is disabled' });
        return;
      }
      const cartItems = await listCartItems(userId);
      if (cartItems.length === 0) {
        res.status(400).json({ error: 'Cart is empty' });
        return;
      }
      const boxTypes = await listBoxTypes();
      const cartParcels = buildShippingParcelsFromCart(cartItems, boxTypes);
      const cartParcelsHash = hashShippingParcels(cartParcels);
      const quote = verifyDeliveryQuoteToken(deliveryQuoteToken);
      if (!quote.ok) {
        res.status(400).json({ error: 'Invalid or expired delivery quote' });
        return;
      }
      if (quote.payload.provider !== deliveryProvider) {
        res.status(400).json({ error: 'Delivery provider does not match quote' });
        return;
      }
      if (quote.payload.parcelsHash !== cartParcelsHash) {
        res.status(409).json({
          error: 'Cart or shipping parameters changed. Recalculate delivery before checkout.'
        });
        return;
      }
      const destinationCodeToCheck =
        deliveryProvider === 'cdek' ? pickupPointCode : destinationCode || pickupPointCode;
      if (
        quote.payload.destinationCode &&
        quote.payload.destinationCode !== destinationCodeToCheck
      ) {
        res.status(400).json({ error: 'Pickup point does not match delivery quote' });
        return;
      }
      if (
        deliveryProvider === 'cdek' &&
        quote.payload.tariffCode &&
        deliveryTariffCode &&
        quote.payload.tariffCode !== deliveryTariffCode
      ) {
        res.status(400).json({ error: 'CDEK tariff does not match delivery quote' });
        return;
      }
      const deliveryCostCents = quote.payload.costCents;
      const itemsTotalCents = cartItems.reduce(
        (sum, item) => sum + item.price_cents * item.quantity,
        0
      );
      const totalCents = itemsTotalCents + deliveryCostCents;
      const order = await createOrder({
        userId,
        fullName,
        phone,
        email,
        pickupPoint,
        deliveryCostCents,
        totalCents,
        items: cartItems.map((item) => ({
          productId: item.product_id,
          name: item.name,
          priceCents: item.price_cents,
          quantity: item.quantity
        }))
      });
      res.status(201).json({ order: mapOrder(order) });
    } catch (error) {
      if (error instanceof InsufficientStockError) {
        res.status(409).json({
          error: 'Not enough items in stock',
          issues: error.issues
        });
        return;
      }
      res.status(500).json({ error: 'Failed to create order' });
    }
  });
  app.get('/api/orders', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const orders = await listOrdersByUser(userId);
      res.json({ items: orders.map(mapOrder) });
    } catch {
      res.status(500).json({ error: 'Failed to load orders' });
    }
  });

  app.get('/api/orders/:id', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const order = await findOrderByIdForUser(req.params.id, userId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      res.json({ order: mapOrder(order) });
    } catch {
      res.status(500).json({ error: 'Failed to load order' });
    }
  });

  app.get('/api/orders/:id/items', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    try {
      const order = await findOrderByIdForUser(req.params.id, userId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }
      const items = await listOrderItemsForUser(req.params.id, userId);
      res.json({ items: items.map(mapOrderItem) });
    } catch {
      res.status(500).json({ error: 'Failed to load order items' });
    }
  });

  app.post('/api/orders/:id/payment', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!isYooKassaConfigured()) {
      res.status(503).json({
        error: 'YooKassa is not configured. Set YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY.'
      });
      return;
    }

    try {
      const order = await findOrderByIdForUser(req.params.id, userId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      if (order.status === 'paid') {
        res.json({
          order: mapOrder(order),
          alreadyPaid: true
        });
        return;
      }

      const amountCents = isYooKassaUseOrderTotal()
        ? order.total_cents
        : getYooKassaFixedAmountCents();
      const isTestMode = !isYooKassaUseOrderTotal();
      const orderItems = await listOrderItemsForUser(order.id, userId);
      const receipt = !isTestMode
        ? buildYooKassaOrderReceipt(order, orderItems, amountCents)
        : buildYooKassaTestReceipt(order, amountCents);

      const payment = await createYooKassaPayment({
        amountCents,
        returnUrl: getYooKassaReturnUrl(req, order.id),
        description: `Оплата заказа №${order.order_number}`,
        metadata: {
          orderId: order.id,
          orderNumber: String(order.order_number),
          userId: order.user_id
        },
        receipt
      });

      const confirmationUrl = payment.confirmation?.confirmation_url;
      if (!confirmationUrl) {
        res.status(502).json({ error: 'YooKassa did not return confirmation_url' });
        return;
      }

      const updatedOrder = await updateOrderPayment(order.id, {
        provider: 'yookassa',
        paymentId: payment.id,
        paymentStatus: payment.status
      });

      res.json({
        order: mapOrder(updatedOrder ?? order),
        confirmationUrl,
        paymentId: payment.id,
        paymentStatus: payment.status,
        amountCents,
        isTestMode
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create YooKassa payment';
      console.error('Failed to create YooKassa payment', error);
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/orders/:id/payment/refresh', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!isYooKassaConfigured()) {
      res.status(503).json({
        error: 'YooKassa is not configured. Set YOOKASSA_SHOP_ID and YOOKASSA_SECRET_KEY.'
      });
      return;
    }

    try {
      const order = await findOrderByIdForUser(req.params.id, userId);
      if (!order) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      if (order.status === 'paid') {
        res.json({ order: mapOrder(order) });
        return;
      }

      if (!order.payment_id) {
        res.status(400).json({ error: 'Payment is not initialized for this order' });
        return;
      }

      const payment = await fetchYooKassaPayment(order.payment_id);
      const updatedOrder = await syncOrderWithYooKassaPayment(order, payment);
      res.json({
        order: mapOrder(updatedOrder),
        paymentStatus: payment.status
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to refresh payment status';
      console.error('Failed to refresh YooKassa payment status', error);
      res.status(502).json({ error: message });
    }
  });

  app.post('/api/orders/:id/pay', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (isYooKassaConfigured()) {
      res.status(400).json({
        error: 'Manual payment is disabled when YooKassa is enabled. Use /api/orders/:id/payment.'
      });
      return;
    }

    try {
      const existingOrder = await findOrderByIdForUser(req.params.id, userId);
      if (!existingOrder) {
        res.status(404).json({ error: 'Order not found' });
        return;
      }

      let order = existingOrder;
      if (existingOrder.status !== 'paid') {
        const paidOrder = await markOrderPaid(req.params.id, userId);
        if (!paidOrder) {
          const refreshedOrder = await findOrderByIdForUser(req.params.id, userId);
          if (!refreshedOrder) {
            res.status(404).json({ error: 'Order not found' });
            return;
          }
          order = refreshedOrder;
        } else {
          order = paidOrder;
        }
      }

      if (existingOrder.status !== 'paid') {
        await finalizePaidOrder(order);
      }

      res.json({ order: mapOrder(order) });
    } catch {
      res.status(500).json({ error: 'Failed to update order' });
    }
  });

  app.post('/api/payments/yookassa/webhook', async (req: Request, res: Response) => {
    if (!isYooKassaWebhookAllowed(req)) {
      res.status(403).json({ ok: false });
      return;
    }

    if (!isYooKassaConfigured()) {
      res.status(503).json({ ok: false });
      return;
    }

    try {
      const paymentId =
        req.body?.object &&
        typeof req.body.object === 'object' &&
        typeof (req.body.object as { id?: unknown }).id === 'string'
          ? ((req.body.object as { id: string }).id ?? '').trim()
          : '';

      if (!paymentId) {
        res.status(400).json({ error: 'Invalid YooKassa webhook payload' });
        return;
      }

      const payment = await fetchYooKassaPayment(paymentId);
      if (!payment.id || !payment.status) {
        res.status(400).json({ error: 'Invalid YooKassa payment data' });
        return;
      }

      const metadataOrderId =
        payment.metadata && typeof payment.metadata.orderId === 'string'
          ? payment.metadata.orderId.trim()
          : '';

      const orderByMetadata = metadataOrderId ? await findOrderById(metadataOrderId) : null;
      const order = orderByMetadata ?? (await findOrderByPaymentId(payment.id));
      if (!order) {
        res.json({ ok: true });
        return;
      }

      await syncOrderWithYooKassaPayment(order, payment);

      res.json({ ok: true });
    } catch (error) {
      console.error('Failed to process YooKassa webhook', error);
      res.status(500).json({ ok: false });
    }
  });

  app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
    if (!isTelegramWebhookAllowed(req, getTelegramWebhookSecret())) {
      res.status(403).json({ ok: false });
      return;
    }

    try {
      await handleTelegramUpdate(req.body ?? {});
    } catch (error) {
      console.error('Failed to process telegram webhook update', error);
    }

    res.json({ ok: true });
  });

  app.post('/api/telegram/orders-webhook', async (req: Request, res: Response) => {
    if (!isTelegramWebhookAllowed(req, getTelegramOrdersWebhookSecret())) {
      res.status(403).json({ ok: false });
      return;
    }

    try {
      await handleTelegramOrderUpdate(req.body ?? {});
    } catch (error) {
      console.error('Failed to process telegram orders webhook update', error);
    }

    res.json({ ok: true });
  });

  app.post('/api/telegram/b2b-webhook', async (req: Request, res: Response) => {
    if (!isTelegramWebhookAllowed(req, getTelegramB2BWebhookSecret())) {
      res.status(403).json({ ok: false });
      return;
    }

    try {
      await handleTelegramB2BUpdate(req.body ?? {});
    } catch (error) {
      console.error('Failed to process telegram B2B webhook update', error);
    }

    res.json({ ok: true });
  });

  app.post('/api/requests/b2b', (req: Request, res: Response) => {
    const requestIp = getRequestIp(req);
    const uploadRateLimit = b2bRequestRateLimiter.consume('b2b_upload', requestIp, 'public');
    if (!uploadRateLimit.allowed) {
      res.setHeader('Retry-After', String(uploadRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many requests. Try again in ${uploadRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    b2bUpload.single('enterpriseCard')(req, res, async (uploadError) => {
      if (uploadError) {
        await removeB2BTempFile(req.file as Express.Multer.File | undefined);
        res.status(400).json({
          error:
            uploadError instanceof Error
              ? uploadError.message
              : 'Не удалось загрузить карточку предприятия'
        });
        return;
      }

      const companyName =
        typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '';
      const contactPerson =
        typeof req.body.contactPerson === 'string' ? req.body.contactPerson.trim() : '';
      const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
      const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
      const captchaToken = typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
      const file = req.file as Express.Multer.File | undefined;

      const errors: string[] = [];
      if (!companyName) {
        errors.push('Укажите ФИО или название компании');
      }
      if (!phone) {
        errors.push('Укажите телефон для связи');
      }
      if (email && !isValidEmail(email)) {
        errors.push('Некорректный email');
      }

      if (errors.length > 0) {
        await removeB2BTempFile(file);
        res.status(400).json({ errors });
        return;
      }

      if (isTurnstileEnabled()) {
        try {
          await verifyTurnstileToken(captchaToken, requestIp, 'request_b2b');
        } catch (error) {
          await removeB2BTempFile(file);
          res.status(400).json({
            error: error instanceof Error ? error.message : 'Failed to validate captcha'
          });
          return;
        }
      }

      const messageLines = [
        '🏢 Новая заявка от юр. лица',
        `🧾 Компания / ФИО: ${companyName}`,
        contactPerson ? `👤 Контактное лицо: ${contactPerson}` : null,
        `📞 Телефон: ${formatPhoneE164(phone)}`,
        email ? `✉️ Email: ${email}` : null,
        comment ? `📝 Комментарий: ${comment}` : null,
        file ? `📎 Карточка предприятия: ${file.originalname || 'прикреплена'}` : '📎 Карточка предприятия: не приложена'
      ].filter(Boolean);

      try {
        const document =
          file &&
          file.path
            ? {
                bytes: await fs.promises.readFile(file.path),
                fileName: file.originalname || path.basename(file.path),
                mimeType: file.mimetype
              }
            : undefined;

        await sendB2BTelegramMessage(
          messageLines.join('\n'),
          document
        );
        res.json({ ok: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to send request';
        res.status(500).json({ error: message });
      } finally {
        await removeB2BTempFile(file);
      }
    });
  });

  app.post('/api/requests/need-part', async (req: Request, res: Response) => {
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const productId =
      typeof req.body.productId === 'string' ? req.body.productId.trim() : '';
    const captchaToken = typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
    const requestIp = getRequestIp(req);

    const errors: string[] = [];
    if (!fullName) {
      errors.push('ФИО обязательно');
    }
    if (!phone) {
      errors.push('Телефон обязателен');
    }
    if (!productId || !isUuid(productId)) {
      errors.push('Некорректный товар');
    }

    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    const needPartRateLimit = needPartRateLimiter.consume(
      'need_part',
      requestIp,
      `${normalizePhone(phone)}:${productId}`
    );
    if (!needPartRateLimit.allowed) {
      res.setHeader('Retry-After', String(needPartRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many requests. Try again in ${needPartRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    if (isTurnstileEnabled()) {
      try {
        await verifyTurnstileToken(captchaToken, requestIp, 'request_need_part');
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Failed to validate captcha'
        });
        return;
      }
    }

    const product = await findProductById(productId);
    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    const normalizedPhone = formatPhoneE164(phone);
    const lines = [
      '🆘 Новая заявка: нужна деталь',
      `🔧 Товар: ${product.name}`,
      product.sku ? `🏷️ SKU: ${product.sku}` : null,
      `📦 Остаток: ${product.stock}`,
      `👤 ФИО: ${fullName}`,
      `📞 Телефон: ${normalizedPhone}`
    ].filter(Boolean);

    try {
      await sendTelegramMessage(lines.join('\n'));
      res.json({ ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to send request';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/auth/request-code', async (req: Request, res: Response) => {
    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const adminAuthMode = getAdminAuthMode();
    const preferredChannel = req.body.preferredChannel === 'sms_ru' ? 'sms_ru' : undefined;
    const captchaToken = typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
    const requestIp = getRequestIp(req);
    if (!phone) {
      res.status(400).json({ error: 'Некорректный телефон' });
      return;
    }

    const authRateLimit = phoneCodeRequestRateLimiter.consume('auth', requestIp, phone);
    if (!authRateLimit.allowed) {
      res.setHeader('Retry-After', String(authRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many code requests. Try again in ${authRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    const existingAuthCode = await findAuthCode(phone);
    const isSmsFallbackRequest = preferredChannel === 'sms_ru';
    const canSkipCaptchaForSmsFallback = Boolean(
      isSmsFallbackRequest &&
        existingAuthCode &&
        existingAuthCode.delivery_channel === 'telegram_gateway' &&
        new Date(existingAuthCode.expires_at).getTime() > Date.now()
    );

    if (isTurnstileEnabled() && !canSkipCaptchaForSmsFallback) {
      try {
        await verifyTurnstileToken(captchaToken, requestIp, 'request_phone_code');
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Не удалось подтвердить проверку'
        });
        return;
      }
    }

    if (phone === getAdminPhone() && adminAuthMode === 'password') {
      const adminPassword = getAdminPassword();
      if (!adminPassword) {
        res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
        return;
      }
      res.json({ ok: true, expiresInMinutes: 0, requiresPassword: true });
      return;
    }

    const code = generateNumericCode(PHONE_CODE_LENGTH);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await saveAuthCode(phone, code, expiresAt);
    try {
      const delivery = await sendPhoneVerificationCode({
        phone,
        code,
        ttlMinutes: CODE_TTL_MINUTES,
        context: 'auth',
        ip: requestIp,
        preferredChannel
      });

      await saveAuthCode(phone, code, expiresAt, {
        deliveryChannel: delivery.channel,
        providerRequestId: delivery.providerRequestId ?? null,
        providerMessageId: delivery.providerMessageId ?? null
      });

      res.json({
        ok: true,
        expiresInMinutes: CODE_TTL_MINUTES,
        deliveryChannel: delivery.channel
      });
    } catch (error) {
      await deleteAuthCode(phone);
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Не удалось отправить код'
      });
    }
  });

  app.post('/api/auth/verify', async (req: Request, res: Response) => {
    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const adminAuthMode = getAdminAuthMode();
    const requestIp = getRequestIp(req);
    const verifyScope = 'auth_verify';

    if (!phone) {
      res.status(400).json({ error: 'Телефон обязателен' });
      return;
    }

    if (phone === getAdminPhone() && adminAuthMode === 'password') {
      const adminPassword = getAdminPassword();
      if (!adminPassword) {
        res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
        return;
      }
      if (!password.trim()) {
        res.status(400).json({ error: 'Пароль обязателен' });
        return;
      }
      const verifyRateLimit = otpVerifyRateLimiter.consume(verifyScope, requestIp, phone);
      if (!verifyRateLimit.allowed) {
        res.setHeader('Retry-After', String(verifyRateLimit.retryAfterSeconds));
        res.status(429).json({
          error: `Too many verification attempts. Try again in ${verifyRateLimit.retryAfterSeconds} sec.`
        });
        return;
      }
      if (password !== adminPassword) {
        res.status(400).json({ error: 'Неверный пароль' });
        return;
      }
      otpVerifyRateLimiter.reset(verifyScope, requestIp, phone);
      const user = await upsertUser(phone, 'admin');
      const csrfToken = createCsrfToken();
      const token = signToken({
        userId: user.id,
        phone: user.phone,
        role: user.role,
        csrfToken
      });
      setAuthCookies(res, token, csrfToken);
      res.json({ user: mapUser(user) });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'Телефон и код обязательны' });
      return;
    }

    const verifyRateLimit = otpVerifyRateLimiter.consume(verifyScope, requestIp, phone);
    if (!verifyRateLimit.allowed) {
      res.setHeader('Retry-After', String(verifyRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many verification attempts. Try again in ${verifyRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }
    const stored = await findAuthCode(phone);
    if (stored?.delivery_channel === 'telegram_gateway' && stored.provider_request_id) {
      void reportTelegramVerificationStatus(stored.provider_request_id, code);
    }
    if (!stored || stored.code !== code) {
      res.status(400).json({ error: 'Неверный код' });
      return;
    }

    const expired = new Date(stored.expires_at).getTime() < Date.now();
    if (expired) {
      res.status(400).json({ error: 'Код истек' });
      return;
    }

    await deleteAuthCode(phone);
    otpVerifyRateLimiter.reset(verifyScope, requestIp, phone);

    const role = phone === getAdminPhone() ? 'admin' : 'user';
    const user = await upsertUser(phone, role);
    const csrfToken = createCsrfToken();
    const token = signToken({
      userId: user.id,
      phone: user.phone,
      role: user.role,
      csrfToken
    });
    setAuthCookies(res, token, csrfToken);
    res.json({ user: mapUser(user) });
  });

  app.get('/api/auth/me', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const user = await findUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    res.json(mapUser(user));
  });

  app.post('/api/auth/logout', (req: Request, res: Response) => {
    const { token, source } = getRequestAuthToken(req);
    if (token && source === 'cookie') {
      try {
        const payload = verifyToken(token);
        const csrfHeader = req.header('x-csrf-token')?.trim() ?? '';
        const csrfCookie = getCookieValue(req, CSRF_COOKIE_NAME) ?? '';
        if (
          !csrfHeader ||
          !csrfCookie ||
          csrfHeader !== csrfCookie ||
          csrfHeader !== payload.csrfToken
        ) {
          res.status(403).json({ error: 'Invalid CSRF token' });
          return;
        }
      } catch {
        // Clear stale cookies even if the session token can no longer be verified.
      }
    }

    clearAuthCookies(res);
    res.json({ ok: true });
  });

  app.put('/api/profile', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const fullNameRaw = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const rawEmail = typeof req.body.email === 'string' ? req.body.email : '';
    const normalizedEmail = normalizeEmail(rawEmail);
    const email = normalizedEmail ? normalizedEmail : null;

    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
      return;
    }

    if (phone.length !== 11 || !phone.startsWith('7')) {
      res.status(400).json({ error: 'Invalid phone format' });
      return;
    }

    if (email && !isValidEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    const existing = await findUserById(userId);
    if (!existing) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const phoneOwner = await findUserByPhone(phone);
    if (phoneOwner && phoneOwner.id !== userId) {
      res.status(409).json({ error: 'Phone already in use' });
      return;
    }

    if (email) {
      const emailOwner = await findUserByEmail(email);
      if (emailOwner && emailOwner.id !== userId) {
        res.status(409).json({ error: 'Email already in use' });
        return;
      }
    }

    try {
      const updated = await updateUserProfile(
        userId,
        email,
        fullNameRaw ? fullNameRaw : null,
        phone
      );

      if (!updated) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      res.json(mapUser(updated));
    } catch {
      res.status(500).json({ error: 'Failed to update profile' });
    }
  });

  app.post('/api/profile/request-email-code', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawEmail = typeof req.body.email === 'string' ? req.body.email : '';
    const email = normalizeEmail(rawEmail);
    if (!email) {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    const emailOwner = await findUserByEmail(email);
    if (emailOwner && emailOwner.id !== userId) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }

    const code = generateNumericCode(EMAIL_CODE_LENGTH);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await saveEmailCode(email, code, expiresAt);
    console.log(`Email verification code for ${email}: ${code}`);
    res.json({ ok: true, expiresInMinutes: CODE_TTL_MINUTES });
  });

  app.post('/api/profile/verify-email-code', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawEmail = typeof req.body.email === 'string' ? req.body.email : '';
    const email = normalizeEmail(rawEmail);
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const requestIp = getRequestIp(req);
    const verifyScope = 'profile_email_verify';

    if (!email || !code) {
      res.status(400).json({ error: 'Email and code are required' });
      return;
    }

    const verifyRateLimit = emailVerifyRateLimiter.consume(verifyScope, requestIp, email);
    if (!verifyRateLimit.allowed) {
      res.setHeader('Retry-After', String(verifyRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many verification attempts. Try again in ${verifyRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Invalid email format' });
      return;
    }

    const emailOwner = await findUserByEmail(email);
    if (emailOwner && emailOwner.id !== userId) {
      res.status(409).json({ error: 'Email already in use' });
      return;
    }

    const stored = await findEmailCode(email);
    if (!stored || stored.code !== code) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }

    const expired = new Date(stored.expires_at).getTime() < Date.now();
    if (expired) {
      res.status(400).json({ error: 'Code expired' });
      return;
    }

    await deleteEmailCode(email);
    emailVerifyRateLimiter.reset(verifyScope, requestIp, email);
    res.json({ ok: true });
  });

  app.post('/api/profile/request-phone-code', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const preferredChannel = req.body.preferredChannel === 'sms_ru' ? 'sms_ru' : undefined;
    const captchaToken = typeof req.body.captchaToken === 'string' ? req.body.captchaToken : '';
    const requestIp = getRequestIp(req);
    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
      return;
    }

    const profilePhoneRateLimit = phoneCodeRequestRateLimiter.consume(
      'profile_phone',
      requestIp,
      phone
    );
    if (!profilePhoneRateLimit.allowed) {
      res.setHeader('Retry-After', String(profilePhoneRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many code requests. Try again in ${profilePhoneRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    const existingPhoneCode = await findAuthCode(phone);
    const isSmsFallbackRequest = preferredChannel === 'sms_ru';
    const canSkipCaptchaForSmsFallback = Boolean(
      isSmsFallbackRequest &&
        existingPhoneCode &&
        existingPhoneCode.delivery_channel === 'telegram_gateway' &&
        new Date(existingPhoneCode.expires_at).getTime() > Date.now()
    );

    if (isTurnstileEnabled() && !canSkipCaptchaForSmsFallback) {
      try {
        await verifyTurnstileToken(captchaToken, requestIp, 'request_phone_code');
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : 'Не удалось подтвердить проверку'
        });
        return;
      }
    }

    if (phone.length !== 11 || !phone.startsWith('7')) {
      res.status(400).json({ error: 'Invalid phone format' });
      return;
    }

    const phoneOwner = await findUserByPhone(phone);
    if (phoneOwner && phoneOwner.id !== userId) {
      res.status(409).json({ error: 'Phone already in use' });
      return;
    }

    const code = generateNumericCode(PHONE_CODE_LENGTH);
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await saveAuthCode(phone, code, expiresAt);
    try {
      const delivery = await sendPhoneVerificationCode({
        phone,
        code,
        ttlMinutes: CODE_TTL_MINUTES,
        context: 'profile_phone',
        ip: requestIp,
        preferredChannel
      });

      await saveAuthCode(phone, code, expiresAt, {
        deliveryChannel: delivery.channel,
        providerRequestId: delivery.providerRequestId ?? null,
        providerMessageId: delivery.providerMessageId ?? null
      });

      res.json({
        ok: true,
        expiresInMinutes: CODE_TTL_MINUTES,
        deliveryChannel: delivery.channel
      });
    } catch (error) {
      await deleteAuthCode(phone);
      res.status(502).json({
        error: error instanceof Error ? error.message : 'Не удалось отправить код'
      });
    }
  });

  app.post('/api/profile/verify-phone-code', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const requestIp = getRequestIp(req);
    const verifyScope = 'profile_phone_verify';

    if (!phone || !code) {
      res.status(400).json({ error: 'Phone and code are required' });
      return;
    }

    const verifyRateLimit = otpVerifyRateLimiter.consume(verifyScope, requestIp, phone);
    if (!verifyRateLimit.allowed) {
      res.setHeader('Retry-After', String(verifyRateLimit.retryAfterSeconds));
      res.status(429).json({
        error: `Too many verification attempts. Try again in ${verifyRateLimit.retryAfterSeconds} sec.`
      });
      return;
    }

    if (phone.length !== 11 || !phone.startsWith('7')) {
      res.status(400).json({ error: 'Invalid phone format' });
      return;
    }

    const phoneOwner = await findUserByPhone(phone);
    if (phoneOwner && phoneOwner.id !== userId) {
      res.status(409).json({ error: 'Phone already in use' });
      return;
    }

    const stored = await findAuthCode(phone);
    if (stored?.delivery_channel === 'telegram_gateway' && stored.provider_request_id) {
      void reportTelegramVerificationStatus(stored.provider_request_id, code);
    }
    if (!stored || stored.code !== code) {
      res.status(400).json({ error: 'Invalid code' });
      return;
    }

    const expired = new Date(stored.expires_at).getTime() < Date.now();
    if (expired) {
      res.status(400).json({ error: 'Code expired' });
      return;
    }

    await deleteAuthCode(phone);
    otpVerifyRateLimiter.reset(verifyScope, requestIp, phone);
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'E-commerce API' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        res.status(400).json({ error: 'Файл слишком большой. Максимальный размер — 5 МБ.' });
        return;
      }
      if (error.code === 'LIMIT_FILE_COUNT') {
        res.status(400).json({ error: 'Загружено слишком много файлов.' });
        return;
      }
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof UploadValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }

    if (error instanceof Error) {
      const message = error.message || 'Internal server error';
      const isClientUploadError =
        message.includes('Unsupported file') ||
        message.includes('signature') ||
        message.includes('Допустимы только');
      res.status(isClientUploadError ? 400 : 500).json({ error: message });
      return;
    }

    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
};
