export type Category = {
  slug: string;
  name: string;
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
  stock: number;
  isHidden: boolean;
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
  createdAt: string;
  updatedAt: string;
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
};

export type CartSyncItem = {
  productId: string;
  quantity: number;
};

export const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
const TOKEN_KEY = 'her_auth_token';

export const getAuthToken = () => localStorage.getItem(TOKEN_KEY);
export const setAuthToken = (token: string) => localStorage.setItem(TOKEN_KEY, token);
export const clearAuthToken = () => localStorage.removeItem(TOKEN_KEY);

const authHeaders = (): Record<string, string> => {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

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

const fetchJson = async <T>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || 'Request failed');
  }
  return (await response.json()) as T;
};

export const fetchCategories = async () => {
  const data = await fetchJson<{ items: Category[] }>(`${API_BASE}/api/categories`);
  return data.items;
};

export const fetchProducts = async (options?: {
  category?: string;
  featured?: boolean;
  includeHidden?: boolean;
}) => {
  const category = options?.category;
  const featured = options?.featured;
  const includeHidden = options?.includeHidden;
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
  const data = await fetchJson<{ items: Product[] }>(url.toString(), {
    headers: includeHidden ? authHeaders() : undefined
  });
  return data.items.map(normalizeProduct);
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
  deliveryCostCents?: number;
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

export const requestNeedPart = async (payload: {
  productId: string;
  fullName: string;
  phone: string;
}) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/requests/need-part`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
};

export const deleteProduct = async (id: string) => {
  return fetchJson<{ ok: boolean }>(`${API_BASE}/api/products/${id}`, {
    method: 'DELETE',
    headers: authHeaders()
  });
};

export const requestAuthCode = async (phone: string) => {
  return fetchJson<{ ok: boolean; expiresInMinutes: number; requiresPassword?: boolean }>(
    `${API_BASE}/api/auth/request-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone })
    }
  );
};

export const verifyAuthCode = async (phone: string, code: string, password?: string) => {
  return fetchJson<{ token: string; user: AuthUser }>(`${API_BASE}/api/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone, code, password })
  });
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

export const requestProfilePhoneCode = async (phone: string) => {
  return fetchJson<{ ok: boolean; expiresInMinutes: number }>(
    `${API_BASE}/api/profile/request-phone-code`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ phone })
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
