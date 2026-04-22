export type Category = {
  slug: string;
  name: string;
  image: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Product = {
  id: string;
  name: string;
  sku: string;
  description: string;
  priceCents: number;
  category: string;
  images: string[];
  showInSlider: boolean;
  sliderOrder: number;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  stock: number;
  isHidden: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProductSkuSearchResult = {
  items: Product[];
  total: number;
  usedFallback: boolean;
  fallbackPrefix: string | null;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export type BoxType = {
  id: string;
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type DeliveryProviderKey = 'cdek' | 'dellin' | 'russian_post';

export type DeliveryProviderSetting = {
  key: DeliveryProviderKey;
  name: string;
  isEnabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

export type HomeBanner = {
  key: 'home';
  desktopImage: string | null;
  mobileImage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CatalogPageSettings = {
  key: 'catalog';
  name: string;
  image: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AuthUser = {
  id: string;
  phone: string;
  role: string;
  email: string;
  fullName: string;
};

export type Order = {
  id: string;
  orderNumber: string;
  status: string;
  fullName: string;
  phone: string;
  email: string;
  pickupPoint: string;
  deliveryCostCents: number;
  totalCents: number;
  paymentProvider?: string;
  paymentId?: string;
  paymentStatus?: string;
  createdAt: string;
  updatedAt: string;
};

export type OrderPaymentSession = {
  order: Order;
  confirmationUrl?: string;
  paymentId?: string;
  paymentStatus?: string;
  amountCents?: number;
  alreadyPaid?: boolean;
};

export type OrderItem = {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
};

export type CartItem = {
  id: string;
  name: string;
  priceCents: number;
  image?: string | null;
  quantity: number;
  stock: number;
  weightGrams: number;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
};

export type CartSyncItem = {
  productId: string;
  quantity: number;
};

export type PickupPointOption = {
  provider: 'dellin' | 'russian_post';
  code: string;
  name: string;
  city: string;
  address: string;
  label: string;
};

export type ShippingEstimateProvider = 'dellin' | 'russian_post';

export type ShippingEstimateParcel = {
  length: number;
  width: number;
  height: number;
  weight: number;
};

export type ShippingEstimate = {
  provider: ShippingEstimateProvider;
  estimatedCostCents: number;
  currency: 'RUB';
  billedWeightKg: number;
  actualWeightKg: number;
  volumetricWeightKg: number;
  quoteToken: string;
};

export type ProductsPage = {
  items: Product[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
};

export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const CSRF_COOKIE_NAME = 'her_csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const getCookieValue = (name: string) => {
  if (typeof document === 'undefined') {
    return null;
  }

  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escapedName}=([^;]*)`));
  if (!match?.[1]) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
};

const clearCsrfCookie = () => {
  if (typeof document === 'undefined') {
    return;
  }
  document.cookie = `${CSRF_COOKIE_NAME}=; Max-Age=0; Path=/`;
};

const authHeaders = (): Record<string, string> => ({});

const normalizeImageUrl = (value: string) => {
  if (!value) {
    return value;
  }
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return value;
  }
  if (value.startsWith('/')) {
    return `${API_BASE}${value}`;
  }
  return `${API_BASE}/${value}`;
};

const normalizeProduct = (product: Product): Product => ({
  ...product,
  images: product.images.map((image) => normalizeImageUrl(image))
});

const normalizeCartItem = (item: CartItem): CartItem => ({
  ...item,
  image: item.image ? normalizeImageUrl(item.image) : item.image
});

const normalizeCategory = (category: Category): Category => ({
  ...category,
  image: category.image ? normalizeImageUrl(category.image) : null
});

const normalizeHomeBanner = (banner: HomeBanner): HomeBanner => ({
  ...banner,
  desktopImage: banner.desktopImage ? normalizeImageUrl(banner.desktopImage) : null,
  mobileImage: banner.mobileImage ? normalizeImageUrl(banner.mobileImage) : null
});

const normalizeCatalogPage = (page: CatalogPageSettings): CatalogPageSettings => ({
  ...page,
  image: page.image ? normalizeImageUrl(page.image) : null
});

const fetchJson = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const method = (options?.method ?? 'GET').toUpperCase();
  const headers = new Headers(options?.headers);

  if (!SAFE_METHODS.has(method)) {
    const csrfToken = getCookieValue(CSRF_COOKIE_NAME);
    if (csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Не удалось выполнить запрос');
  }
  return (await response.json()) as T;
};

export const fetchCategories = async () => {
  const data = await fetchJson<{ items: Category[] }>(`${API_BASE}/api/categories`);
  return data.items.map(normalizeCategory);
};

export const updateCategorySection = async (slug: string, payload: FormData) => {
  const data = await fetchJson<{ item: Category }>(`${API_BASE}/api/categories/${slug}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: payload
  });
  return normalizeCategory(data.item);
};

export const deleteCategorySection = async (slug: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/categories/${slug}`, {
    method: 'DELETE',
    headers: authHeaders()
  });
};

export const fetchProductsPage = async (options?: {
  category?: string;
  featured?: boolean;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
}) => {
  const category = options?.category;
  const featured = options?.featured;
  const includeHidden = options?.includeHidden;
  const limit = options?.limit;
  const offset = options?.offset;
  const url = new URL(`${API_BASE}/api/products`);
  if (category) {
    url.searchParams.set('category', category);
  }
  if (featured) {
    url.searchParams.set('featured', 'true');
  }
  if (includeHidden) {
    url.searchParams.set('includeHidden', 'true');
  }
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
    url.searchParams.set('limit', String(Math.trunc(limit)));
  }
  if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
    url.searchParams.set('offset', String(Math.trunc(offset)));
  }

  const data = await fetchJson<{
    items: Product[];
    total?: number;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  }>(url.toString(), {
    headers: includeHidden ? authHeaders() : undefined
  });

  const normalizedItems = data.items.map(normalizeProduct);
  const resolvedLimit =
    typeof data.limit === 'number' && Number.isFinite(data.limit)
      ? Math.trunc(data.limit)
      : typeof limit === 'number' && Number.isFinite(limit)
      ? Math.trunc(limit)
      : normalizedItems.length;
  const resolvedOffset =
    typeof data.offset === 'number' && Number.isFinite(data.offset)
      ? Math.trunc(data.offset)
      : typeof offset === 'number' && Number.isFinite(offset)
      ? Math.trunc(offset)
      : 0;
  const resolvedTotal =
    typeof data.total === 'number' && Number.isFinite(data.total)
      ? Math.trunc(data.total)
      : resolvedOffset + normalizedItems.length;
  const resolvedHasMore =
    typeof data.hasMore === 'boolean'
      ? data.hasMore
      : resolvedOffset + normalizedItems.length < resolvedTotal;
  const resolvedNextOffset =
    typeof data.nextOffset === 'number' && Number.isFinite(data.nextOffset)
      ? Math.trunc(data.nextOffset)
      : resolvedHasMore
      ? resolvedOffset + normalizedItems.length
      : null;

  return {
    items: normalizedItems,
    total: resolvedTotal,
    limit: resolvedLimit,
    offset: resolvedOffset,
    hasMore: resolvedHasMore,
    nextOffset: resolvedNextOffset
  } satisfies ProductsPage;
};

export const fetchProducts = async (options?: {
  category?: string;
  featured?: boolean;
  includeHidden?: boolean;
  limit?: number;
  offset?: number;
}) => {
  const page = await fetchProductsPage(options);
  return page.items;
};

export const fetchProductById = async (id: string, options?: { includeHidden?: boolean }) => {
  const productId = id.trim();
  if (!productId) {
    throw new Error('Invalid request data');
  }

  const url = new URL(`${API_BASE}/api/products/${productId}`);
  if (options?.includeHidden) {
    url.searchParams.set('includeHidden', 'true');
  }

  const product = await fetchJson<Product>(url.toString(), {
    headers: options?.includeHidden ? authHeaders() : undefined
  });
  return normalizeProduct(product);
};

export const searchProductsBySku = async (
  sku: string,
  options?: number | { limit?: number; offset?: number }
) => {
  const requestedLimit =
    typeof options === 'number'
      ? options
      : typeof options?.limit === 'number'
      ? options.limit
      : undefined;
  const requestedOffset =
    typeof options === 'object' && options !== null && typeof options.offset === 'number'
      ? options.offset
      : 0;

  const normalizedSku = sku.trim();
  const normalizedLimit =
    typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.trunc(requestedLimit)
      : undefined;
  const normalizedOffset =
    typeof requestedOffset === 'number' && Number.isFinite(requestedOffset) && requestedOffset >= 0
      ? Math.trunc(requestedOffset)
      : 0;

  if (!normalizedSku) {
    return {
      items: [],
      total: 0,
      usedFallback: false,
      fallbackPrefix: null,
      limit: normalizedLimit ?? 0,
      offset: normalizedOffset,
      hasMore: false,
      nextOffset: null
    } satisfies ProductSkuSearchResult;
  }

  const url = new URL(`${API_BASE}/api/products/search`);
  url.searchParams.set('sku', normalizedSku);
  if (typeof normalizedLimit === 'number') {
    url.searchParams.set('limit', String(normalizedLimit));
  }
  if (normalizedOffset > 0) {
    url.searchParams.set('offset', String(normalizedOffset));
  }

  const data = await fetchJson<{
    items: Product[];
    total?: number;
    usedFallback?: boolean;
    fallbackPrefix?: string | null;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    nextOffset?: number | null;
  }>(url.toString());

  const normalizedItems = data.items.map(normalizeProduct);
  const resolvedOffset =
    typeof data.offset === 'number' && Number.isFinite(data.offset)
      ? Math.trunc(data.offset)
      : normalizedOffset;
  const resolvedLimit =
    typeof data.limit === 'number' && Number.isFinite(data.limit)
      ? Math.trunc(data.limit)
      : normalizedLimit ?? normalizedItems.length;
  const resolvedTotal =
    typeof data.total === 'number' && Number.isFinite(data.total)
      ? Math.trunc(data.total)
      : resolvedOffset + normalizedItems.length;
  const resolvedHasMore =
    typeof data.hasMore === 'boolean'
      ? data.hasMore
      : resolvedOffset + normalizedItems.length < resolvedTotal;
  const resolvedNextOffset =
    typeof data.nextOffset === 'number' && Number.isFinite(data.nextOffset)
      ? Math.trunc(data.nextOffset)
      : resolvedHasMore
      ? resolvedOffset + normalizedItems.length
      : null;

  return {
    items: normalizedItems,
    total: resolvedTotal,
    usedFallback: Boolean(data.usedFallback),
    fallbackPrefix: typeof data.fallbackPrefix === 'string' ? data.fallbackPrefix : null,
    limit: resolvedLimit,
    offset: resolvedOffset,
    hasMore: resolvedHasMore,
    nextOffset: resolvedNextOffset
  } satisfies ProductSkuSearchResult;
};

export const fetchBoxTypes = async () => {
  const data = await fetchJson<{ items: BoxType[] }>(`${API_BASE}/api/box-types`);
  return data.items;
};

export const fetchDeliveryProviders = async () => {
  const data = await fetchJson<{ items: DeliveryProviderSetting[] }>(
    `${API_BASE}/api/delivery-providers`
  );
  return data.items;
};

export const fetchHomeBanner = async () => {
  const data = await fetchJson<{ banner: HomeBanner }>(`${API_BASE}/api/banners/home`);
  return normalizeHomeBanner(data.banner);
};

export const fetchCatalogPageSettings = async () => {
  const data = await fetchJson<{ page: CatalogPageSettings }>(`${API_BASE}/api/catalog-page`);
  return normalizeCatalogPage(data.page);
};

export const updateCatalogPageSettings = async (payload: FormData) => {
  const data = await fetchJson<{ page: CatalogPageSettings }>(`${API_BASE}/api/catalog-page`, {
    method: 'PUT',
    headers: authHeaders(),
    body: payload
  });
  return normalizeCatalogPage(data.page);
};

export const updateHomeBanner = async (payload: FormData) => {
  const data = await fetchJson<{ banner: HomeBanner }>(`${API_BASE}/api/banners/home`, {
    method: 'PUT',
    headers: authHeaders(),
    body: payload
  });
  return normalizeHomeBanner(data.banner);
};

export const updateDeliveryProvider = async (
  key: DeliveryProviderKey,
  isEnabled: boolean
) => {
  return fetchJson<DeliveryProviderSetting>(`${API_BASE}/api/delivery-providers/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ isEnabled })
  });
};

type BoxTypePayload = {
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
  sortOrder: number;
};

export const createBoxType = async (payload: BoxTypePayload) => {
  return fetchJson<BoxType>(`${API_BASE}/api/box-types`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
};

export const updateBoxType = async (id: string, payload: BoxTypePayload) => {
  return fetchJson<BoxType>(`${API_BASE}/api/box-types/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
};

export const deleteBoxType = async (id: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/box-types/${id}`, {
    method: 'DELETE',
    headers: authHeaders()
  });
};

export const createProduct = async (payload: FormData) => {
  const product = await fetchJson<Product>(`${API_BASE}/api/products`, {
    method: 'POST',
    headers: authHeaders(),
    body: payload
  });
  return normalizeProduct(product);
};

export const updateProduct = async (id: string, payload: FormData) => {
  const product = await fetchJson<Product>(`${API_BASE}/api/products/${id}`, {
    method: 'PUT',
    headers: authHeaders(),
    body: payload
  });
  return normalizeProduct(product);
};

export const createOrder = async (payload: {
  fullName: string;
  phone: string;
  email: string;
  pickupPoint: string;
  pickupPointCode: string;
  deliveryProvider: DeliveryProviderKey;
  deliveryQuoteToken: string;
  deliveryTariffCode?: number;
  destinationCode?: string;
  destinationCity?: string;
  destinationAddress?: string;
}) => {
  const data = await fetchJson<{ order: Order }>(`${API_BASE}/api/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
  return data.order;
};

export const fetchOrders = async () => {
  const data = await fetchJson<{ items: Order[] }>(`${API_BASE}/api/orders`, {
    headers: authHeaders()
  });
  return data.items;
};

export const fetchOrder = async (orderId: string) => {
  const data = await fetchJson<{ order: Order }>(`${API_BASE}/api/orders/${orderId}`, {
    headers: authHeaders()
  });
  return data.order;
};

export const fetchOrderItems = async (orderId: string) => {
  const data = await fetchJson<{ items: OrderItem[] }>(
    `${API_BASE}/api/orders/${orderId}/items`,
    {
      headers: authHeaders()
    }
  );
  return data.items;
};

export const payOrder = async (orderId: string) => {
  const data = await fetchJson<{ order: Order }>(`${API_BASE}/api/orders/${orderId}/pay`, {
    method: 'POST',
    headers: authHeaders()
  });
  return data.order;
};

export const createOrderPayment = async (orderId: string) => {
  return fetchJson<OrderPaymentSession>(`${API_BASE}/api/orders/${orderId}/payment`, {
    method: 'POST',
    headers: authHeaders()
  });
};

export const refreshOrderPayment = async (orderId: string) => {
  return fetchJson<{ order: Order; paymentStatus: string }>(
    `${API_BASE}/api/orders/${orderId}/payment/refresh`,
    {
      method: 'POST',
      headers: authHeaders()
    }
  );
};

export const requestNeedPart = async (payload: {
  productId: string;
  fullName: string;
  phone: string;
  captchaToken?: string;
}) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/requests/need-part`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const requestNeedPartCatalog = async (payload: FormData) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/requests/need-part/catalog`, {
    method: 'POST',
    body: payload
  });
};

export const requestB2BInquiry = async (payload: FormData) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/requests/b2b`, {
    method: 'POST',
    body: payload
  });
};

export const deleteProduct = async (id: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/products/${id}`, {
    method: 'DELETE',
    headers: authHeaders()
  });
};

export const requestAuthCode = async (
  phone: string,
  preferredChannel?: 'sms_ru',
  captchaToken?: string
) => {
  return fetchJson<{
    ok: boolean;
    expiresInMinutes: number;
    requiresPassword?: boolean;
    deliveryChannel?: 'telegram_gateway' | 'sms_ru' | 'sms_ru_call' | 'debug';
    callPhone?: string;
    callPhonePretty?: string;
  }>(
    `${API_BASE}/api/auth/request-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, preferredChannel, captchaToken })
    }
  );
};

export const fetchAuthCallStatus = async (phone: string) => {
  const normalizedPhone = phone.trim();
  const url = new URL(`${API_BASE}/api/auth/call-status`);
  url.searchParams.set('phone', normalizedPhone);
  return fetchJson<{
    status: 'pending' | 'confirmed' | 'expired' | 'not_found';
  }>(url.toString());
};

export const verifyAuthCode = async (phone: string, code: string, password?: string) => {
  return fetchJson<{ user: AuthUser }>(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, password })
  });
};

export const logout = async () => {
  try {
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/auth/logout`, {
      method: 'POST'
    });
  } finally {
    clearCsrfCookie();
  }
};

export const fetchMe = async () => {
  return fetchJson<AuthUser>(`${API_BASE}/api/auth/me`, {
    headers: authHeaders()
  });
};

export const updateProfile = async (payload: { fullName: string; phone: string; email: string }) => {
  return fetchJson<AuthUser>(`${API_BASE}/api/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(payload)
  });
};

export const requestProfilePhoneCode = async (
  phone: string,
  preferredChannel?: 'sms_ru',
  captchaToken?: string
) => {
  return fetchJson<{
    ok: boolean;
    expiresInMinutes: number;
    deliveryChannel?: 'telegram_gateway' | 'sms_ru' | 'debug';
  }>(
    `${API_BASE}/api/profile/request-phone-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone, preferredChannel, captchaToken })
    }
  );
};

export const verifyProfilePhoneCode = async (phone: string, code: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/profile/verify-phone-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ phone, code })
  });
};

export const requestProfileEmailCode = async (email: string) => {
  return fetchJson<{ ok: boolean; expiresInMinutes: number }>(
    `${API_BASE}/api/profile/request-email-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ email })
    }
  );
};

export const verifyProfileEmailCode = async (email: string, code: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/profile/verify-email-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ email, code })
  });
};

export const fetchCart = async () => {
  const data = await fetchJson<{ items: CartItem[] }>(`${API_BASE}/api/cart`, {
    headers: authHeaders()
  });
  return data.items.map(normalizeCartItem);
};

export const mergeCart = async (items: CartSyncItem[]) => {
  const data = await fetchJson<{ items: CartItem[] }>(`${API_BASE}/api/cart/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ items })
  });
  return data.items.map(normalizeCartItem);
};

export const syncCart = async (items: CartSyncItem[]) => {
  const data = await fetchJson<{ items: CartItem[] }>(`${API_BASE}/api/cart`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ items })
  });
  return data.items.map(normalizeCartItem);
};

const fetchPickupPoints = async (provider: 'dellin' | 'russian_post', query: string) => {
  const url = new URL(`${API_BASE}/api/pickup-points/${provider}`);
  url.searchParams.set('query', query);
  const data = await fetchJson<{ items: PickupPointOption[] }>(url.toString());
  return data.items;
};

export const searchDellinPickupPoints = async (query: string) =>
  fetchPickupPoints('dellin', query);

export const searchRussianPostPickupPoints = async (query: string) =>
  fetchPickupPoints('russian_post', query);

export const estimateShipping = async (payload: {
  provider: ShippingEstimateProvider;
  parcels: ShippingEstimateParcel[];
  destinationCity?: string;
  destinationCode?: string;
  destinationAddress?: string;
}) =>
  fetchJson<ShippingEstimate>(`${API_BASE}/api/shipping/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
