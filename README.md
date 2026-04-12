# ST24 — интернет-магазин запчастей

Монорепозиторий проекта `st-24.рф` с фронтендом на React/Vite и backend API на Node.js/Express + PostgreSQL.

## Что в проекте

- Каталог и категории товаров.
- Страницы товара, корзина, оформление заказа.
- Выбор доставки:
  - CDEK (виджет ПВЗ),
  - Деловые Линии,
  - Почта России.
- Оценка стоимости доставки и упаковка заказа по коробкам.
- Авторизация по телефону:
  - Telegram Gateway,
  - fallback через SMS.ru.
- Оплата через YooKassa (webhook, статусы платежей, чеки).
- Формы:
  - «Нужна деталь» (карточка товара),
  - «Спросить о наличии» (из раздела каталога, с фото до 3 шт.),
  - B2B-заявка (с файлом карточки предприятия).
- Уведомления в Telegram-боты:
  - заявки по деталям,
  - оплаченные заказы,
  - заявки B2B.
- Админ-панель:
  - товары,
  - коробки,
  - разделы каталога,
  - баннеры,
  - доставки,
  - шрифты.

## Технологии

- Frontend: `React`, `TypeScript`, `Vite`, `react-router-dom`.
- Backend: `Node.js`, `Express`, `TypeScript`.
- DB: `PostgreSQL`.
- Дополнительно: `Redis` (опционально для rate limit), `multer`, `undici`.

## Структура репозитория

- `client/` — фронтенд.
- `server/` — backend API.
- `deploy.sh` — серверный деплой (pull + install + build + restart service).

## Маршруты фронтенда

- `/` — главная.
- `/catalog` — разделы каталога.
- `/catalog/:slug` — товары категории.
- `/product/:id` — страница товара.
- `/search` — результаты поиска по SKU.
- `/cart`, `/checkout`, `/payment/:orderId`, `/order-success/:orderId`.
- `/contacts`, `/about` (legacy), `/b2b`.
- `/account`, `/admin`.
- `/terms`, `/privacy`.

## Основные API endpoints

- Каталог/товары:
  - `GET /api/categories`
  - `PUT /api/categories/:slug`
  - `DELETE /api/categories/:slug`
  - `GET /api/products`
  - `GET /api/products/:id`
  - `POST /api/products`
  - `PUT /api/products/:id`
- Поиск/доставка:
  - `GET /api/products/search`
  - `ALL /api/cdek/widget`
  - `GET /api/pickup-points/dellin`
  - `GET /api/pickup-points/russian_post`
  - `POST /api/shipping/estimate`
- Корзина/заказы/оплата:
  - `GET /api/cart`
  - `PUT /api/cart`
  - `POST /api/orders`
  - `POST /api/orders/:id/payment`
  - `POST /api/payments/yookassa/webhook`
- Авторизация/профиль:
  - `POST /api/auth/request-code`
  - `POST /api/auth/verify`
  - `GET /api/auth/me`
  - `POST /api/auth/logout`
  - `PUT /api/profile`
- Заявки:
  - `POST /api/requests/need-part`
  - `POST /api/requests/need-part/catalog`
  - `POST /api/requests/b2b`

## Требования

- Node.js 20+ (рекомендуется LTS).
- PostgreSQL 14+.
- npm 10+.

## Локальный запуск

1. Установить зависимости:

```bash
npm install
```

2. Подготовить переменные окружения:

- `server/.env`
- `client/.env`

3. Запустить backend:

```bash
npm run dev --workspace server
```

4. Запустить frontend:

```bash
npm run dev --workspace client
```

5. Открыть сайт:

- `http://localhost:5173`

## Сборка

```bash
npm run build --workspace client
npm run build --workspace server
```

## Обязательные переменные окружения

### `server/.env` (минимум)

- `PORT`
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_PHONE`
- `ADMIN_AUTH_MODE` (`password` | `code`)
- `ADMIN_PASSWORD` (если `ADMIN_AUTH_MODE=password`)

### Авторизация по телефону

- `PHONE_VERIFICATION_MODE` (`telegram_then_sms` | `sms_only`)
- `TELEGRAM_GATEWAY_TOKEN`
- `SMS_RU_API_ID` (обязателен при `PHONE_VERIFICATION_MODE=sms_only`)
- `SMS_RU_SENDER` (если требуется аккаунтом SMS.ru)
- `PHONE_VERIFICATION_BRAND`

### Captcha

- `TURNSTILE_SECRET_KEY` (backend)
- `VITE_TURNSTILE_SITE_KEY` (frontend)

### Telegram-боты

- `TELEGRAM_BOT_TOKEN` — заявки по деталям.
- `TELEGRAM_ORDERS_BOT_TOKEN` — оплаченные заказы.
- `TELEGRAM_B2B_BOT_TOKEN` — заявки юрлиц.
- `TELEGRAM_*_POLLING` или webhook-режим с `TELEGRAM_*_WEBHOOK_SECRET`.

### Доставка

- CDEK:
  - `CDEK_CLIENT_ID`
  - `CDEK_CLIENT_SECRET`
  - `CDEK_API_BASE_URL` (`https://api.cdek.ru/v2` для прода)
- Деловые Линии:
  - `DELLIN_APP_KEY`
  - `DELLIN_FROM_TERMINAL_ID`
- Почта России:
  - `RUSSIAN_POST_ACCESS_TOKEN`
  - `RUSSIAN_POST_USER_KEY`
  - `RUSSIAN_POST_INDEX_FROM`

### Оплата YooKassa

- `YOOKASSA_SHOP_ID`
- `YOOKASSA_SECRET_KEY`
- `YOOKASSA_WEBHOOK_SECRET`
- `YOOKASSA_RETURN_BASE_URL`
- `YOOKASSA_RECEIPT_TAX_SYSTEM_CODE`
- `YOOKASSA_RECEIPT_VAT_CODE`

### `client/.env` (основное)

- `VITE_API_URL`
- `VITE_YANDEX_MAPS_API_KEY`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_CDEK_FROM_CODE`
- `VITE_CDEK_FROM_LOCATION`
- `VITE_CDEK_DEFAULT_LOCATION`

## База данных

- Инициализация схемы выполняется автоматически при старте backend (`server/src/db/init.ts`).
- В проекте используются таблицы для:
  - товаров/категорий,
  - коробок,
  - заказов/платежей,
  - пользователей/кодов подтверждения,
  - логов безопасности и интеграций,
  - Telegram подписчиков.

## Деплой

Используется скрипт в корне:

```bash
/var/www/st24/deploy.sh
```

Что делает скрипт:

1. `git pull`
2. `npm install`
3. сборка frontend и backend
4. `systemctl restart her-api`

Параметры (опционально):

```bash
./deploy.sh <ROOT> <API_URL> <SERVICE_NAME>
```

Пример:

```bash
./deploy.sh /var/www/st24 https://xn---24-3edf.xn--p1ai her-api
```

## Бэкапы (рекомендуется)

Рекомендуемая схема:

- ежедневный backup БД (`pg_dump -Fc`);
- хранение локально 14 дней;
- копия в облако (например, Яндекс.Диск через `rclone`);
- периодическая проверка восстановления.

## Полезно знать

- В `server/src/app.ts` есть in-memory кэш для поиска ПВЗ и расчета доставки. После деплоя/рестарта кэш очищается.
- Для CSV-выгрузок используется BOM (`\uFEFF`) для корректного открытия в Excel.
- Для продакшена лучше включить `TRUST_PROXY`, корректно настроить CORS и HTTPS.
