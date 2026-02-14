import cors from 'cors';
import express, { Request, Response } from 'express';
import path from 'path';
import { signToken, verifyToken } from './auth';
import { CdekProxyError, proxyCdekWidgetRequest } from './cdek';
import { findAuthCode, saveAuthCode, deleteAuthCode } from './db/authCodes';
import { findEmailCode, saveEmailCode, deleteEmailCode } from './db/emailCodes';
import {
  filterValidCartItems,
  listCartItems,
  mergeCartItems,
  replaceCartItems,
  type CartItemRow,
  type CartSyncItem
} from './db/cart';
import { isValidCategory, listCategories } from './db/categories';
import {
  createOrder,
  findOrderByIdForUser,
  InsufficientStockError,
  listOrderItemsForUser,
  listOrdersByUser,
  markOrderPaid,
  type OrderItemRow,
  type OrderRow
} from './db/orders';
import {
  createProduct,
  deleteProduct,
  findProductById,
  findProductBySku,
  listProducts,
  updateProduct,
  type ProductRow
} from './db/products';
import {
  findUserByEmail,
  findUserById,
  findUserByPhone,
  updateUserProfile,
  upsertUser
} from './db/users';
import { authenticate, requireAdmin } from './middleware/auth';
import {
  handleTelegramOrderUpdate,
  handleTelegramUpdate,
  sendOrderTelegramMessage,
  sendTelegramMessage
} from './telegram';
import { removeUploadedFiles, toPublicUrl, upload } from './uploads';

const CODE_TTL_MINUTES = 5;

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
const normalizeEmail = (value: string) => value.trim().toLowerCase();
const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const getTelegramWebhookSecret = () => process.env.TELEGRAM_WEBHOOK_SECRET;
const getTelegramOrdersWebhookSecret = () =>
  process.env.TELEGRAM_ORDERS_WEBHOOK_SECRET;

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
  stock: row.stock,
  isHidden: row.is_hidden,
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
  if (!secret) {
    return true;
  }
  const header = req.headers['x-telegram-bot-api-secret-token'];
  return header === secret;
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
    stock: row.stock
  };
};

export const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.all('/api/cdek/widget', async (req: Request, res: Response) => {
    try {
      const response = await proxyCdekWidgetRequest(req.query, req.body);
      for (const [key, value] of response.forwardedHeaders) {
        res.setHeader(key, value);
      }
      res.setHeader('X-Service-Version', 'node-1.0.0');
      res.status(response.status).json(response.body);
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

  app.get('/api/categories', (_req: Request, res: Response) => {
    listCategories()
      .then((items) => res.json({ items }))
      .catch(() => res.status(500).json({ error: 'Failed to load categories' }));
  });

  app.get('/api/products', (req: Request, res: Response) => {
    const category = typeof req.query.category === 'string' ? req.query.category : undefined;
    const featured = req.query.featured === 'true';
    const includeHidden = req.query.includeHidden === 'true';

    if (includeHidden) {
      const header = req.headers.authorization;
      if (!header) {
        res.status(403).json({ error: 'Forbidden' });
        return;
      }
      try {
        const payload = verifyToken(header.replace('Bearer ', ''));
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
    const deliveryCostInput = req.body.deliveryCostCents;
    const deliveryCostCents =
      typeof deliveryCostInput === 'number'
        ? Math.round(deliveryCostInput)
        : typeof deliveryCostInput === 'string' && deliveryCostInput.trim() !== ''
          ? Number.parseInt(deliveryCostInput, 10)
          : 0;

    const errors: string[] = [];
    if (!fullName) {
      errors.push('ФИО обязательно');
    }
    if (!phone) {
      errors.push('Телефон обязателен');
    }
    if (!email || !isValidEmail(email)) {
      errors.push('Некорректная почта');
    }
    if (!pickupPoint) {
      errors.push('Выберите пункт выдачи');
    }
    if (Number.isNaN(deliveryCostCents) || deliveryCostCents < 0) {
      errors.push('Некорректная стоимость доставки');
    }

    if (errors.length > 0) {
      res.status(400).json({ errors });
      return;
    }

    try {
      const cartItems = await listCartItems(userId);
      if (cartItems.length === 0) {
        res.status(400).json({ error: 'Корзина пуста' });
        return;
      }

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
          error: 'Недостаточно товара на складе',
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

  app.post('/api/orders/:id/pay', authenticate, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
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
          res.status(404).json({ error: 'Order not found' });
          return;
        }
        order = paidOrder;
      }

      await replaceCartItems(userId, []);

      if (existingOrder.status !== 'paid') {
        try {
          const orderItems = await listOrderItemsForUser(order.id, userId);
          const notification = buildPaidOrderNotification(order, orderItems);
          await sendOrderTelegramMessage(notification);
        } catch (error) {
          console.error(
            `Failed to send paid order notification for order ${order.id}`,
            error
          );
        }
      }

      res.json({ order: mapOrder(order) });
    } catch {
      res.status(500).json({ error: 'Failed to update order' });
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

  app.post('/api/requests/need-part', async (req: Request, res: Response) => {
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const productId =
      typeof req.body.productId === 'string' ? req.body.productId.trim() : '';

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
    if (!phone) {
      res.status(400).json({ error: 'Некорректный телефон' });
      return;
    }

    if (phone === getAdminPhone()) {
      const adminPassword = getAdminPassword();
      if (!adminPassword) {
        res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
        return;
      }
      res.json({ ok: true, expiresInMinutes: 0, requiresPassword: true });
      return;
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await saveAuthCode(phone, code, expiresAt);
    console.log(`Auth code for ${phone}: ${code}`);
    res.json({ ok: true, expiresInMinutes: CODE_TTL_MINUTES });
  });

  app.post('/api/auth/verify', async (req: Request, res: Response) => {
    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone : '';
    const phone = normalizePhone(rawPhone);
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!phone) {
      res.status(400).json({ error: 'Телефон обязателен' });
      return;
    }

    if (phone === getAdminPhone()) {
      const adminPassword = getAdminPassword();
      if (!adminPassword) {
        res.status(500).json({ error: 'ADMIN_PASSWORD is not configured' });
        return;
      }
      if (!password.trim()) {
        res.status(400).json({ error: 'Пароль обязателен' });
        return;
      }
      if (password !== adminPassword) {
        res.status(400).json({ error: 'Неверный пароль' });
        return;
      }
      const user = await upsertUser(phone, 'admin');
      const token = signToken({ userId: user.id, phone: user.phone, role: user.role });
      res.json({ token, user: mapUser(user) });
      return;
    }

    if (!code) {
      res.status(400).json({ error: 'Телефон и код обязательны' });
      return;
    }

    const stored = await findAuthCode(phone);
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

    const role = phone === getAdminPhone() ? 'admin' : 'user';
    const user = await upsertUser(phone, role);
    const token = signToken({ userId: user.id, phone: user.phone, role: user.role });
    res.json({ token, user: mapUser(user) });
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

    const code = String(Math.floor(100000 + Math.random() * 900000));
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

    if (!email || !code) {
      res.status(400).json({ error: 'Email and code are required' });
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
    if (!phone) {
      res.status(400).json({ error: 'Phone is required' });
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

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();
    await saveAuthCode(phone, code, expiresAt);
    console.log(`Phone verification code for ${phone}: ${code}`);
    res.json({ ok: true, expiresInMinutes: CODE_TTL_MINUTES });
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

    if (!phone || !code) {
      res.status(400).json({ error: 'Phone and code are required' });
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
    res.json({ ok: true });
  });

  app.get('/', (_req: Request, res: Response) => {
    res.json({ message: 'E-commerce API' });
  });

  return app;
};
