# Мониторинг первой и второй итераций

Первая итерация добавила две независимые части:

1. Backend публикует liveness и readiness endpoints.
2. Standalone runner из каталога `monitor/` запускается на отдельной машине и проверяет production снаружи.

Вторая итерация закрывает потерю бизнес-уведомлений: оплаченный заказ или заявка атомарно создают PostgreSQL outbox-событие, worker повторяет доставку по каждому чату и каждой части сообщения, а внешний runner проверяет backlog, режим входящих update и реальный `sendMessage`.

Runner нельзя размещать только на production-сервере: при остановке или неоплате этого сервера проверки исчезнут вместе с ним. Желательно использовать другого хостинг-провайдера или внешний scheduler.

## Backend endpoints

- `GET /api/health` — прежний совместимый ответ `{ status: 'ok' }`.
- `GET /api/health/live` — проверяет только способность Node-процесса отвечать.
- `GET /api/health/ready` — параллельно выполняет `SELECT 1` в PostgreSQL и `write → read → delete` canary-файла в рабочем каталоге uploads.
- `GET /api/health/notifications` — возвращает только безопасные статусы worker/outbox/ботов и счётчики бизнес-инвариантов, без текста сообщений, chat ID, PII и секретов.

`/api/health/ready` возвращает `200`, только если обе проверки успешны, иначе `503`. Сырые исключения, пути и connection strings в ответ не попадают. Результат кратковременно кешируется, а параллельные запросы объединяются, чтобы публичный endpoint не создавал очередь запросов к БД и диску.

Uploads-probe не создаёт отсутствующий каталог и не запускает второй canary, пока фактически не завершился предыдущий. Он доказывает доступность текущего каталога для записи, но не сохранность старых файлов. Сейчас uploads локальный; если позже это будет отдельный mount, добавьте на уровне systemd `RequiresMountsFor=`/mount dependency или обязательный sentinel, иначе отсутствующий mount может быть заменён обычным локальным каталогом ещё при старте приложения.

Outbox хранит immutable текст и временно хранит вложения в PostgreSQL `BYTEA`, поэтому lead/order и все данные для повторной отправки коммитятся одной транзакцией. Получатели фиксируются в момент события как пересечение активных подписчиков и явного allowlist; подписавшийся позже чат не получит старые PII. Успешные части не отправляются повторно из-за ошибки другого чата или документа. После полного успеха bytes удаляются. Transient/config/auth ошибки повторяются с backoff до персонального `retry_expires_at` события; по истечении окна payload, deliveries и вложения стираются, а событие становится невосстановимым dead-letter. Заблокированный или отписавшийся отдельный чат помечается skipped. Невосстановимая ошибка оставляет health красным до операторского разбора. Семантика — at-least-once: Bot API не поддерживает idempotency key, поэтому падение после принятия сообщения Telegram, но до записи receipt в БД, может дать редкий узнаваемый дубль.

Настройки backend:

- `HEALTH_CHECK_TIMEOUT_MS` — timeout каждой readiness-проверки, по умолчанию 3000 мс; допустимо 250–30000 мс.
- `HEALTH_CHECK_CACHE_TTL_MS` — TTL readiness-результата, по умолчанию 5000 мс; допустимо 250–60000 мс.
- `DATABASE_CONNECT_TIMEOUT_MS` — timeout получения обычного соединения PostgreSQL, по умолчанию 10000 мс; допустимо 250–30000 мс. Health-check использует отдельный пул на одно соединение и делит собственный budget между connect и `SELECT 1`.
- `TELEGRAM_OUTBOX_INTERVAL_MS` — пауза между worker cycles, по умолчанию 1000 мс.
- `TELEGRAM_OUTBOX_LEASE_MS` — lease одного события, по умолчанию 15 минут; lease продлевается перед каждым Bot API request.
- `TELEGRAM_OUTBOX_OVERDUE_MS` — SLA `paid → notified` и старого backlog, по умолчанию 5 минут.
- `TELEGRAM_OUTBOX_MAX_RETRY_AGE_DAYS` — максимальное окно повторных попыток, по умолчанию 7 дней; значение записывается в новое событие и не продлевает уже созданные события. После истечения данные события стираются и redrive невозможен.
- `TELEGRAM_OUTBOX_WORKER_STALE_MS` и `TELEGRAM_POLLING_STALE_MS` — допустимый возраст heartbeat, по умолчанию 2 минуты.
- `TELEGRAM_RUNTIME_PROBE_INTERVAL_MS`, `TELEGRAM_RUNTIME_PROBE_STALE_MS`, `TELEGRAM_MAX_PENDING_UPDATES` — период и freshness backend-проверок фактических bot token/proxy/webhook, а также допустимый backlog update.
- `NOTIFICATION_HEALTH_CACHE_TTL_MS` — короткий cache/coalescing публичного notification-health endpoint, по умолчанию 5 секунд.
- `TELEGRAM_OUTBOX_RETENTION_DAYS`, `TELEGRAM_UPDATE_INBOX_RETENTION_DAYS`, `TELEGRAM_OUTBOX_DEAD_ATTACHMENT_RETENTION_DAYS` — retention payload/inbox/dead bytes, по умолчанию 90/90/30 дней.

### Telegram routing и получатели

| Bot kind | Backend webhook route | Secret | Public URL |
|---|---|---|---|
| main | `/api/telegram/webhook` | `TELEGRAM_WEBHOOK_SECRET` | `TELEGRAM_MAIN_WEBHOOK_URL` |
| orders | `/api/telegram/orders-webhook` | `TELEGRAM_ORDERS_WEBHOOK_SECRET` | `TELEGRAM_ORDERS_WEBHOOK_URL` |
| b2b | `/api/telegram/b2b-webhook` | `TELEGRAM_B2B_WEBHOOK_SECRET` | `TELEGRAM_B2B_WEBHOOK_URL` |

В webhook mode зарегистрированный через Bot API URL и `secret_token` должны точно совпадать с этой таблицей и backend `.env`; в monitor задайте тот же полный HTTPS URL через соответствующий `MONITOR_TELEGRAM_*_WEBHOOK_URL`. В polling и disabled mode вызовите Bot API `deleteWebhook`, а secret/URL оставьте пустыми: backend и monitor считают оставшийся webhook или непустую monitor-переменную ошибкой. Для каждого настроенного token заполните соответствующий `TELEGRAM_*_ALLOWED_CHAT_IDS`; каждый разрешённый чат должен один раз отправить `/start` до приёма реальных заявок. Произвольный пользователь с `/start` в список получателей не попадёт. Disabled без token означает полностью отключённого бота; disabled с token отключает только inbound и по-прежнему допускает outbox/canary.

### YooKassa: return URL и доверенный proxy

Если YooKassa включена в production, `YOOKASSA_RETURN_BASE_URL` обязателен и должен быть точным публичным HTTPS origin без credentials, path, query и fragment, например `https://shop.example.com`. Это исключает построение платёжного return URL из клиентских `Origin`/forwarded headers.

`YOOKASSA_API_BASE_URL` в production фиксируется на официальном `https://api.yookassa.ru/v3` (допускается один trailing slash). Другой protocol, host, port/path, credentials, query или fragment останавливает запуск до отправки Basic credentials.

Проверка официальных IP webhook использует `req.ip`, поэтому `TRUST_PROXY` является частью security boundary. При прямом доступе оставьте `false`; за известным reverse proxy перечислите только его явные IP/CIDR и настройте его на перезапись forwarded headers. В production число hops, `true` и символические preset-имена отклоняются. `YOOKASSA_WEBHOOK_SECRET` — только defense-in-depth: сама YooKassa этот header не отправляет, поэтому доверенный proxy должен проверить источник, удалить одноимённый входящий клиентский header и добавить собственный.

## Что проверяет runner

- DNS-разрешение production hostname;
- TLS handshake, hostname сертификата и срок его действия;
- главную страницу и ожидаемый текстовый marker;
- API liveness со свежим `checkedAt`;
- API readiness со свежим `checkedAt` и семантической проверкой PostgreSQL/uploads;
- notification health: живой worker, backlog/dead-letter, `paid → outbox → notified`, payment-status drift, stock-reservation drift, PII-retention drift и runtime всех трёх ботов. `dead` означает активную ошибку; `acknowledgedDead` остаётся аудитируемой историей и сам по себе не красит health;
- DB-backed каталог, минимальное количество элементов и поля `slug`/`name`;
- отдельную end-to-end доступность Telegram API через production proxy, не зависящую от production bot tokens;
- `getMe` и `getWebhookInfo` основного, заказного и B2B Telegram-ботов строго через `TELEGRAM_OUTBOUND_PROXY_URL`;
- `getMe` независимого monitor-бота при каждом запуске через его прямое соединение или `MONITOR_TELEGRAM_PROXY_URL`;
- соответствие webhook URL либо отсутствие webhook в polling mode;
- реальный тихий `sendMessage` canary каждым production-ботом с настроенным token в режиме `summary`, даже если его inbound mode — `disabled`.

Каждый check имеет стабильный идентификатор, статус, безопасное описание и latency. Любой critical failure завершает процесс с exit code `1`, даже если порог Telegram-алерта ещё не достигнут.

## Установка на отдельной машине

Требуется Node.js 20.19+, 22.13+ или 24+; используйте LTS-ветку.

```bash
cd /opt/her
npm ci --workspace monitor --include-workspace-root=false
npm test --workspace monitor
test ! -e monitor/.env && install -m 600 monitor/.env.example monitor/.env
```

Запускайте runner отдельным непривилегированным пользователем и создавайте `.env` от его имени. Если setup выполняет root, передайте `install` правильные `-o/-g`. Каталог с кодом и `dist/` может быть read-only, но пользователь должен иметь запись в каталог `MONITOR_STATE_FILE`. Не перезаписывайте существующий `.env` шаблоном и не используйте обычный `cp`: в файле находятся bot tokens, пароль proxy и секретный heartbeat URL, поэтому требуются права `0600`.

Заполните `.env`. Минимальный production-фрагмент:

```dotenv
MONITOR_SITE_URL=https://xn---24-3edf.xn--p1ai
MONITOR_HOMEPAGE_MARKER=Купить запчасти для Karcher
MONITOR_CATALOG_MIN_ITEMS=1
MONITOR_HEALTH_MAX_AGE_MS=60000
MONITOR_NOTIFICATIONS_URL=/api/health/notifications
MONITOR_TELEGRAM_MAX_PENDING_UPDATES=100

TELEGRAM_OUTBOUND_PROXY_URL=socks5://user:password@proxy.example.com:1080
TELEGRAM_BOT_TOKEN=
TELEGRAM_ORDERS_BOT_TOKEN=
TELEGRAM_B2B_BOT_TOKEN=
MONITOR_TELEGRAM_MAIN_MODE=polling
MONITOR_TELEGRAM_ORDERS_MODE=polling
MONITOR_TELEGRAM_B2B_MODE=polling
MONITOR_TELEGRAM_MAIN_WEBHOOK_URL=
MONITOR_TELEGRAM_ORDERS_WEBHOOK_URL=
MONITOR_TELEGRAM_B2B_WEBHOOK_URL=
MONITOR_TELEGRAM_MAIN_USERNAME=
MONITOR_TELEGRAM_ORDERS_USERNAME=
MONITOR_TELEGRAM_B2B_USERNAME=
MONITOR_TELEGRAM_CANARY_CHAT_ID=

MONITOR_TELEGRAM_BOT_TOKEN=
MONITOR_TELEGRAM_BOT_USERNAME=
MONITOR_TELEGRAM_CHAT_ID=
MONITOR_TELEGRAM_PROXY_URL=
MONITOR_HEARTBEAT_URL=
MONITOR_ALLOW_NO_HEARTBEAT=false
MONITOR_STATE_FILE=/var/lib/her-monitor/state.json
```

Три production token должны быть разными. Режимы monitor должны совпадать с `TELEGRAM_MAIN_MODE`/`TELEGRAM_ORDERS_MODE`/`TELEGRAM_B2B_MODE` backend. Для webhook обязателен точный публичный HTTPS URL, для polling/disabled Telegram webhook URL обязан быть пустым. `MONITOR_TELEGRAM_*_USERNAME` обязательны для каждого настроенного production token, задаются без `@` и фиксируют ожидаемую identity: так runner обнаружит не только невалидный, но и случайно переставленный token. Все production-боты с token должны иметь право писать в отдельный `MONITOR_TELEGRAM_CANARY_CHAT_ID`; `summary` отправляет туда по одному тихому сообщению. `MONITOR_TELEGRAM_BOT_TOKEN` обязан принадлежать отдельному боту и не может совпадать ни с одним production token. `MONITOR_TELEGRAM_BOT_USERNAME` формально опционален, но в production настоятельно рекомендуется: он pin-ит identity независимого бота; даже без pin runner строго проверяет `getMe`, bot ID, username и `is_bot`. `MONITOR_TELEGRAM_PROXY_URL` не наследует production proxy: оставьте его пустым для прямого соединения либо задайте физически независимый proxy.

`MONITOR_HEARTBEAT_URL` — секретный HTTPS endpoint внешнего dead-man сервиса, который сам поднимает тревогу, если запуски runner прекратились. Redirects для него запрещены. Каждый запуск сначала проверяет независимый monitor-бот через `getMe`; при его critical failure success-heartbeat намеренно не отправляется, чтобы dead-man стал резервным каналом тревоги. Обычные target failures не подавляют heartbeat: он продолжает доказывать, что cron/runner жив, пока детали инцидента отправляются monitor-ботом. Без URL конфигурация не запустится; `MONITOR_ALLOW_NO_HEARTBEAT=true` существует только для осознанного local/staging запуска и не рекомендуется в production.

## Режимы запуска

```bash
npm run monitor:check
npm run monitor:summary
```

- `check` отправляет сообщение после подтверждённого `OK → WARNING/FAIL`, при эскалации `WARNING → FAIL` и после `WARNING/FAIL → RECOVERY`.
- `summary` выполняет production `sendMessage` canary и всегда отправляет полную текущую сводку независимым monitor-ботом.
- По умолчанию проблема подтверждается двумя последовательными запусками, RECOVERY — одним успешным.
- Состояние хранится атомарно в `MONITOR_STATE_FILE`; путь должен находиться на persistent volume. Повреждённый state сбрасывается с отдельным Telegram-предупреждением.
- Lock-файл с обновляемым lease не допускает параллельной записи state и дублирующих алертов даже для долгого живого запуска. Сборка TypeScript выполняется при деплое, а не в cron.

## Операторское восстановление

Все команды ниже запускаются на собранном backend с доступом к той же PostgreSQL. Они не печатают payload/PII, фиксируют локальную OS identity оператора и завершаются с code `2`, если optimistic guard не совпал или действие неприменимо.

После устранения причины повторите восстановимое dead-letter событие:

```bash
npm run outbox:redrive --workspace server -- <event-uuid>
```

Redrive не переотправляет уже подтверждённые части. Для `no_targets` он заново фиксирует текущих активных allowlisted получателей. Acknowledged или уже scrubbed/expired событие повторно отправить нельзя.

Если payload уже безвозвратно удалён retention/retry-expiry и бизнес-последствия разобраны вручную, признайте потерю с ожидаемым `event_key` и номером тикета/причиной (не помещайте PII в reason):

```bash
npm run outbox:ack --workspace server -- <event-uuid> <expected-event-key> "INC-1234: reconciled manually"
```

Ack разрешён только для действительно невосстановимого dead-letter. Он убирает событие из активного счётчика `dead`, но сохраняет его в `acknowledgedDead` и отдельном audit trail. Ненулевой `piiRetentionDrift` никогда не маскируется ack и остаётся критической ошибкой до исправления retention.

`paymentStatusDrift` включает аномалии конкретного заказа и orphan/provider payments. `stockReservationDrift` отдельно сигнализирует о противоречии или брони старше 23 часов; такую бронь нельзя освобождать автоматически без сверки актуального платежа в YooKassa. Сначала сверьте платёж, заказ, остатки, возврат/исполнение и журнал инцидента; затем очистите только ожидаемый текущий код:

```bash
npm run payment-anomaly:resolve-order --workspace server -- <order-uuid> <expected-code> "INC-1234: reconciled manually"
npm run payment-anomaly:resolve-provider --workspace server -- <anomaly-id> <expected-code> "INC-1234: reconciled manually"
```

Эти команды не выполняют возврат денег и не меняют заказ автоматически — они только аудитируемо закрывают уже устранённую аномалию. Перед запуском сделайте backup и сохраните ссылку на подтверждение ручного reconciliation.

Пример cron:

```cron
*/5 * * * * cd /opt/her && /usr/bin/npm run monitor:check >> /var/log/her-monitor.log 2>&1
2 9 * * * cd /opt/her && /usr/bin/npm run monitor:summary >> /var/log/her-monitor.log 2>&1
```

Запускайте эти записи из crontab пользователя runner. До установки cron создайте state-каталог и лог с нужным владельцем, например `install -d -o her-monitor -g her-monitor -m 700 /var/lib/her-monitor` и `install -o her-monitor -g her-monitor -m 640 /dev/null /var/log/her-monitor.log`; иначе shell может не открыть redirect и runner вообще не стартует. Время ежедневной сводки интерпретируется в timezone машины с cron.

Включите синхронизацию времени (NTP) на production и monitor host: freshness `checkedAt`, TLS expiry и время outage зависят от корректных часов.

## Проверка перед production

На staging последовательно воспроизведите:

1. недоступную PostgreSQL;
2. запрет записи в uploads;
3. неверный production proxy;
4. неверный token одного из трёх ботов;
5. polling-бот с зарегистрированным webhook и webhook-бот с неверным URL;
6. временный ответ `429`, timeout и `5xx` при outbox delivery с последующим восстановлением;
7. `403` одного подписчика при успешном втором подписчике;
8. остановку процесса сразу после commit заявки/paid-заказа: после рестарта событие должно уйти из outbox;
9. paid-заказ без уведомления старше `TELEGRAM_OUTBOX_OVERDUE_MS`, payment status drift и stock-reservation drift;
10. retry-событие после `retry_expires_at`: оно должно стать scrubbed dead-letter, поднять `dead`, не создать `piiRetentionDrift` и отказаться от redrive;
11. отдельно проверить optimistic guards для outbox ack и обоих payment-anomaly resolve: неверный event key/code не должен менять health или audit state.

Для случаев 1–5, 9 и 10 первый `monitor:check` должен завершиться с code `1`, второй — отправить один FAIL; после корректного восстановления или обоснованного ack следующий запуск отправляет один RECOVERY. Случаи 6–8 проверяют durable recovery: событие должно доставиться в пределах SLA без dead-letter и обычно без внешней тревоги; code `1` ожидается только если backlog превысил SLA, возник dead-letter или нарушился бизнес-инвариант. В случае 11 защитная CLI-команда должна завершиться с code `2`. При `403` одного из нескольких адресатов успешные адресаты не получают дубль, а заблокированный чат деактивируется. В stdout, state-файле и Telegram-сообщении не должно быть token, proxy password, DB URL или абсолютного пути uploads.

## Ограничения второй итерации

- Send-canary доказывает outbound Bot API до отдельного чата; полный inbound E2E потребовал бы отдельный Telegram user/MTProto synthetic client. Сейчас inbound покрыт `getWebhookInfo`, runtime heartbeat, durable update inbox и persistent polling offset.
- Ровно-однократная доставка невозможна без idempotency key со стороны Telegram; гарантируется durable at-least-once и отсутствие повторов уже подтверждённых chat/part.
- Вложения dead-letter увеличивают PostgreSQL до retention cleanup; для БД и backups нужны шифрование, контролируемый доступ, autovacuum и согласованная политика хранения персональных данных. Восстановимое событие можно redrive после исправления причины. Для уже scrubbed невосстановимой потери доступен только аудитируемый ack после ручного reconciliation; он не восстанавливает сообщение и не скрывает PII-retention drift.
- Polling одного bot token должен запускаться в единственном экземпляре. Для нескольких backend-реплик перед production потребуется distributed leader lock; update cursor и inbox уже persistent, но сами `getUpdates` не являются multi-consumer очередью.
- На этой итерации schema создаётся idempotent DDL в `initDb`; перед production всё равно нужен backup и migration smoke на копии БД.

YooKassa provider availability, службы доставки, Telegram Gateway/SMS.ru, Redis и браузерный checkout остаются следующими слоями мониторинга.
