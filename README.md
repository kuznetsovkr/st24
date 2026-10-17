# СТ24 — интернет-магазин запчастей

Монорепозиторий проекта `ст-24.рф` с фронтендом на React/Vite и backend API на Node.js/Express + PostgreSQL.

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
- `monitor/` — независимый внешний мониторинг.
- `ops/` — production-ready systemd units, timers, tmpfiles и logrotate.
- `deploy.sh` — guarded-деплой с preflight, тестами, backup, migration smoke,
  readiness и автоматическим откатом кода.
- `.github/workflows/ci.yml` — CI на поддерживаемой Node.js и чистой PostgreSQL.

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

- Node.js 20.19+, 22.13+ или 24+; используйте LTS-ветку.
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

Production-сборка frontend выполняется только из проверенного файла с
allowlist публичных `VITE_*`-значений (без чтения случайного `client/.env`):

```bash
CLIENT_ENV_FILE=/etc/her/client.env npm run client:config:check
CLIENT_ENV_FILE=/etc/her/client.env npm run client:build
```

## Проверки

```bash
npm ci
npm run lint
npm test
npm run build --workspace client
npm audit --omit=dev --audit-level=high
```

GitHub Actions повторяет эти проверки на Node.js 22.13.1, поднимает чистую
PostgreSQL и проверяет idempotent schema init, резервирование склада и durable
outbox. Workflow также запускается еженедельно, а Dependabot готовит отдельные
PR для обновлений npm и GitHub Actions.

## Обязательные переменные окружения

### Backend (`server/.env` локально, `/etc/her/api.env` в production)

- `NODE_ENV` (`development` | `test` | `production`, строго в нижнем регистре)
- `PORT`
- `API_BIND_HOST` (`127.0.0.1`, если API доступен только через nginx на том же сервере)
- `DATABASE_URL`
- `JWT_SECRET`
- `CLIENT_URL` или другой явный HTTPS origin из CORS-настроек
- `AUTH_COOKIE_SECURE=true` в production
- `ADMIN_PHONE`
- `ADMIN_AUTH_MODE` (`password` | `code`)
- `ADMIN_PASSWORD` (если `ADMIN_AUTH_MODE=password`)
- `SUPER_ADMIN_PHONE` (опционально, отдельный номер суперадмина)
- `SUPER_ADMIN_PASSWORD` (если используется `SUPER_ADMIN_PHONE`)

При `RATE_LIMIT_REDIS_REQUIRED=true` также обязательны
`RATE_LIMIT_REDIS_ENABLED=true` и корректный `RATE_LIMIT_REDIS_URL` (`redis://`
или `rediss://`). Перед запуском backend и перед каждым деплоем одна и та же
fail-closed проверка выполняется командой:

```bash
DOTENV_CONFIG_PATH=/etc/her/api.env NODE_ENV=production npm run config:check
```

### Авторизация по телефону

- `SMS_RU_API_ID` (обязателен, используется для подтверждения звонком через SMS.RU Callcheck)
- `SMS_RU_SENDER` (только для SMS-кодов в других сценариях, если требуется аккаунтом SMS.ru)
- `PHONE_VERIFICATION_MODE` (`telegram_then_sms` | `sms_only`)
- `TELEGRAM_GATEWAY_TOKEN`
- `PHONE_VERIFICATION_BRAND`

### Captcha

- `TURNSTILE_SECRET_KEY` (backend)
- `VITE_TURNSTILE_SITE_KEY` (frontend)

### Telegram-боты

- `TELEGRAM_BOT_TOKEN` — заявки по деталям.
- `TELEGRAM_ORDERS_BOT_TOKEN` — оплаченные заказы.
- `TELEGRAM_B2B_BOT_TOKEN` — заявки юрлиц.
- `TELEGRAM_MAIN_MODE`, `TELEGRAM_ORDERS_MODE`, `TELEGRAM_B2B_MODE` — явный режим `polling` | `webhook` | `disabled`.
- Для каждого настроенного token обязателен соответствующий `TELEGRAM_*_ALLOWED_CHAT_IDS`: outbox фиксирует только активных подписчиков из этого списка в момент создания события. Перед приёмом заявок каждый разрешённый чат должен отправить боту `/start`.
- Для webhook-режима обязательны соответствующие `TELEGRAM_*_WEBHOOK_SECRET` и точный публичный `TELEGRAM_*_WEBHOOK_URL`. В `polling`/`disabled` secret и URL запрещены, а ранее зарегистрированный webhook должен быть удалён через Bot API.
- Старые `TELEGRAM_*_POLLING` временно поддерживаются только для совместимости; новые окружения должны задавать явные mode-переменные.
- `TELEGRAM_OUTBOUND_PROXY_URL` — общий production proxy приложения; monitor использует его только для проверок и отправляет алерты через независимый канал.
- `TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS` — окно повторных попыток нового outbox-события (по умолчанию 7 дней); после него содержимое стирается и событие становится невосстановимым dead-letter.

Безопасный минимальный шаблон без секретов находится в `server/.env.example`. Он не заменяет уже существующий production-конфиг: новые переменные добавляйте в него вручную. Только при первом создании, от имени пользователя сервиса, выполните `test ! -e server/.env && install -m 600 server/.env.example server/.env`; если команду запускает root, дополнительно задайте корректные `-o/-g`. Никогда не перезаписывайте рабочий `.env` шаблоном и не коммитьте его.

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
- `YOOKASSA_WEBHOOK_SECRET` — только дополнительный секрет, который добавляет доверенный reverse proxy после проверки источника; proxy обязан удалить одноимённый клиентский header. Сама YooKassa такой header не отправляет. Backend также принимает webhook с официальных IP YooKassa и всегда перечитывает объект платежа через API.
- `YOOKASSA_RETURN_BASE_URL` — обязательный в production точный публичный HTTPS origin без path/query/fragment, например `https://shop.example.com`.
- `YOOKASSA_API_BASE_URL` в production может указывать только на официальный `https://api.yookassa.ru/v3`; произвольный endpoint разрешён лишь в dev/test, чтобы Basic credentials не ушли на чужой хост из-за ошибки конфигурации.
- `YOOKASSA_RECEIPT_TAX_SYSTEM_CODE`
- `YOOKASSA_RECEIPT_VAT_CODE`
- `ENABLE_MANUAL_PAYMENT` — только локальный dev-флаг; в production endpoint ручной оплаты всегда закрыт независимо от значения.

### Frontend (`client/.env` локально, `/etc/her/client.env` в production)

- `VITE_API_URL`
- `VITE_SITE_URL`
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

Полный bootstrap API и отдельного monitor-host описан в
[production runbook](ops/README.md). Секреты хранятся вне Git в
`/etc/her/api.env` и `/etc/her-monitor/monitor.env`; публичная конфигурация
production-сборки frontend — в контролируемом `/etc/her/client.env`. API и
монитор запускаются от разных непривилегированных пользователей.

После первичной установки systemd unit используется скрипт в корне:

```bash
sudo bash /var/www/st24/deploy.sh
```

Что делает скрипт:

1. не допускает параллельный деплой и локальные tracked-изменения;
2. получает только fast-forward revision без интерактивного запроса credentials;
3. выполняет `npm ci`, config preflight, тесты, lint и сборку всех workspace;
4. создаёт и проверяет PostgreSQL backup;
5. восстанавливает backup во временную БД и дважды прогоняет schema init;
6. сохраняет прежние systemd/tmpfiles/logrotate, устанавливает и проверяет новые;
7. перезапускает API и проверяет свежий readiness напрямую на loopback и через публичный URL;
8. при ошибке возвращает предыдущий код, настройки systemd и сервис. Миграции БД автоматически
   назад не откатываются.

Параметры (каталог и имя сервиса закреплены в production unit):

```bash
sudo bash ./deploy.sh /var/www/st24 <API_URL> her-api
```

Пример:

```bash
sudo bash ./deploy.sh /var/www/st24 https://xn---24-3edf.xn--p1ai her-api
```

Скрипт запускается от root и использует `/etc/her/api.env`, `/etc/her/client.env`
и `DEPLOY_BACKUP_DIR`. После backup и migration smoke он сохраняет прежние
API unit/tmpfiles/logrotate и устанавливает файлы из проверяемой revision. Для
migration smoke обычно передают отдельный
`MIGRATION_SMOKE_ADMIN_URL`, способный создать и удалить временную БД. Первый
переход со старого `deploy.sh` выполняйте по runbook: сначала отдельно получите
и проверьте новый скрипт и systemd unit, не запускайте старую версию деплоя.

Это безопасный in-place deploy, но не zero-downtime release layout: для строгого
zero-downtime следующим шагом понадобится blue/green или versioned releases.

## Бэкапы (рекомендуется)

Скрипты ежедневной защищённой копии и инструкция восстановления доступа к облаку:
[ops/backup/README.md](ops/backup/README.md). Это отдельный механизм от backup
перед деплоем. Автоматическое удаление старых ежедневных наборов пока отключено:
политику хранения нужно согласовать отдельно, даже после проверки облака.

Новые внешние копии шифруются age; ключ восстановления хранится вне VPS.
Формат и проверенная процедура восстановления — в
[ops/backup/ENCRYPTION.md](ops/backup/ENCRYPTION.md). Старые незашифрованные
копии пока сохранены, автоматическая очистка отдельно не включалась.

Контроль ошибок, давности последнего успешного бэкапа и свободного места:
[ops/backup/ALERTS.md](ops/backup/ALERTS.md). Доставка через внешний Cronitor
не зависит от Telegram-прокси магазина. Для включения нужны две настроенные
Heartbeat-проверки, закрытые Telemetry URL, активация таймера и проверка уведомлений.

Рекомендуемая схема:

- ежедневный backup БД (`pg_dump -Fc`);
- отдельный проверенный backup создаётся также перед каждым `deploy.sh`;
- настроенная очистка локальных backup и соседних `.ops.*` каталогов через 14 дней;
- внешний контроль свободного места на дисках backup и PostgreSQL;
- копия в облако (например, Яндекс.Диск через `rclone`);
- периодическая проверка восстановления.

## Полезно знать

- В `server/src/app.ts` есть in-memory кэш для поиска ПВЗ и расчета доставки. После деплоя/рестарта кэш очищается.
- Для CSV-выгрузок используется BOM (`\uFEFF`) для корректного открытия в Excel.
- `TRUST_PROXY` не следует безусловно включать в production: при прямом доступе оставьте `false`, а за известным reverse proxy перечислите только его явные IP/CIDR. Число hops, `true` и символические preset-имена в production отклоняются. Proxy обязан перезаписывать forwarded headers, поскольку `req.ip` участвует в проверке IP webhook YooKassa.

## Мониторинг

Для внешних HTTP-проверок главной страницы и готовности API подготовлены
[параметры Cronitor и инструкция](ops/monitoring/README.md). Настройка и приёмка
в аккаунте выполняются отдельно; эти проверки не заменяют browser smoke.

Backend предоставляет:

- `GET /api/health/live` — liveness Node-процесса;
- `GET /api/health/ready` — readiness PostgreSQL и локального uploads;
- `GET /api/health/notifications` — состояние Telegram outbox/worker, polling/webhook, payment/stock-reservation/PII-инварианты и `paid → notified` без PII. Активный `dead` делает health красным; `acknowledgedDead` хранит аудит уже разобранной невосстановимой потери и сам по себе не является ошибкой.

В каталоге `monitor/` находится независимый runner для DNS, TLS, сайта, API, каталога и трёх Telegram-ботов через production proxy. Он проверяет identity и `getWebhookInfo`, читает notification-health, при каждом запуске отдельно проверяет monitor-бот через независимое соединение, а в ежедневном `summary` выполняет реальный `sendMessage` canary каждым production-ботом в отдельный canary-чат. Runner поддерживает warning/fail/recovery алерты, защиту от параллельных запусков и внешний dead-man heartbeat. Если critical `getMe` monitor-бота не проходит, success-heartbeat подавляется и dead-man становится резервным каналом; обычные target failures heartbeat не подавляют. В production heartbeat обязателен; явный opt-out предназначен только для local/staging.

Быстрая локальная проверка:

```bash
npm ci --workspace monitor --include-workspace-root=false
test ! -e monitor/.env && install -m 600 monitor/.env.example monitor/.env
npm test --workspace monitor
# заполнить monitor/.env, затем:
npm run config:check --workspace monitor
npm run monitor:check
```

После устранения причины восстановимое dead-letter событие можно вернуть в очередь:

```bash
npm run outbox:redrive --workspace server -- <event-uuid>
```

Для безвозвратно scrubbed события и уже вручную разобранных payment anomalies предусмотрены аудитируемые команды `outbox:ack`, `payment-anomaly:resolve-order` и `payment-anomaly:resolve-provider`. Они требуют ожидаемый event key/anomaly code и тикет/причину; сами возврат денег или исправление заказа не выполняют. Точный runbook приведён в [документации мониторинга](docs/monitoring.md#операторское-восстановление).

Runner необходимо размещать вне production-сервера. Полная настройка, расписание и fault-injection checklist описаны в [документации мониторинга](docs/monitoring.md).
