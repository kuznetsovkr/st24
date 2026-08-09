# Мониторинг первой итерации

Первая итерация состоит из двух независимых частей:

1. Backend публикует liveness и readiness endpoints.
2. Standalone runner из каталога `monitor/` запускается на отдельной машине и проверяет production снаружи.

Runner нельзя размещать только на production-сервере: при остановке или неоплате этого сервера проверки исчезнут вместе с ним. Желательно использовать другого хостинг-провайдера или внешний scheduler.

## Backend endpoints

- `GET /api/health` — прежний совместимый ответ `{ status: 'ok' }`.
- `GET /api/health/live` — проверяет только способность Node-процесса отвечать.
- `GET /api/health/ready` — параллельно выполняет `SELECT 1` в PostgreSQL и `write → read → delete` canary-файла в рабочем каталоге uploads.

`/api/health/ready` возвращает `200`, только если обе проверки успешны, иначе `503`. Сырые исключения, пути и connection strings в ответ не попадают. Результат кратковременно кешируется, а параллельные запросы объединяются, чтобы публичный endpoint не создавал очередь запросов к БД и диску.

Uploads-probe не создаёт отсутствующий каталог и не запускает второй canary, пока фактически не завершился предыдущий. Он доказывает доступность текущего каталога для записи, но не сохранность старых файлов. Сейчас uploads локальный; если позже это будет отдельный mount, добавьте на уровне systemd `RequiresMountsFor=`/mount dependency или обязательный sentinel, иначе отсутствующий mount может быть заменён обычным локальным каталогом ещё при старте приложения.

Настройки backend:

- `HEALTH_CHECK_TIMEOUT_MS` — timeout каждой readiness-проверки, по умолчанию 3000 мс; допустимо 250–30000 мс.
- `HEALTH_CHECK_CACHE_TTL_MS` — TTL readiness-результата, по умолчанию 5000 мс; допустимо 250–60000 мс.
- `DATABASE_CONNECT_TIMEOUT_MS` — timeout получения обычного соединения PostgreSQL, по умолчанию 10000 мс; допустимо 250–30000 мс. Health-check использует отдельный пул на одно соединение и делит собственный budget между connect и `SELECT 1`.

## Что проверяет runner

- DNS-разрешение production hostname;
- TLS handshake, hostname сертификата и срок его действия;
- главную страницу и ожидаемый текстовый marker;
- API liveness со свежим `checkedAt`;
- API readiness со свежим `checkedAt` и семантической проверкой PostgreSQL/uploads;
- DB-backed каталог, минимальное количество элементов и поля `slug`/`name`;
- отдельную end-to-end доступность Telegram API через production proxy, не зависящую от production bot tokens;
- `getMe` основного, заказного и B2B Telegram-ботов строго через `TELEGRAM_OUTBOUND_PROXY_URL`.

Каждый check имеет стабильный идентификатор, статус, безопасное описание и latency. Любой critical failure завершает процесс с exit code `1`, даже если порог Telegram-алерта ещё не достигнут.

## Установка на отдельной машине

Требуется Node.js 20.19+, 22.13+ или 24+; используйте LTS-ветку.

```bash
cd /opt/her
npm ci --workspace monitor --include-workspace-root=false
npm test --workspace monitor
install -m 600 monitor/.env.example monitor/.env
```

Запускайте runner отдельным непривилегированным пользователем. Каталог с кодом и `dist/` может быть read-only, но пользователь должен иметь запись в каталог `MONITOR_STATE_FILE`. Не используйте обычный `cp` для `.env`: в нём находятся bot tokens, пароль proxy и секретный heartbeat URL, поэтому требуются права `0600`.

Заполните `.env`. Минимальный production-фрагмент:

```dotenv
MONITOR_SITE_URL=https://xn---24-3edf.xn--p1ai
MONITOR_HOMEPAGE_MARKER=Купить запчасти для Karcher
MONITOR_CATALOG_MIN_ITEMS=1
MONITOR_HEALTH_MAX_AGE_MS=60000

TELEGRAM_OUTBOUND_PROXY_URL=socks5://user:password@proxy.example.com:1080
TELEGRAM_BOT_TOKEN=
TELEGRAM_ORDERS_BOT_TOKEN=
TELEGRAM_B2B_BOT_TOKEN=
MONITOR_TELEGRAM_MAIN_USERNAME=
MONITOR_TELEGRAM_ORDERS_USERNAME=
MONITOR_TELEGRAM_B2B_USERNAME=

MONITOR_TELEGRAM_BOT_TOKEN=
MONITOR_TELEGRAM_CHAT_ID=
MONITOR_TELEGRAM_PROXY_URL=
MONITOR_HEARTBEAT_URL=
MONITOR_ALLOW_NO_HEARTBEAT=false
MONITOR_STATE_FILE=/var/lib/her-monitor/state.json
```

Три production token должны быть разными. `MONITOR_TELEGRAM_*_USERNAME` задаются без `@` и фиксируют ожидаемую identity: так runner обнаружит не только невалидный, но и случайно переставленный token. `MONITOR_TELEGRAM_BOT_TOKEN` обязан принадлежать отдельному боту и не может совпадать ни с одним production token. `MONITOR_TELEGRAM_PROXY_URL` не наследует production proxy: оставьте его пустым для прямого соединения либо задайте физически независимый proxy.

`MONITOR_HEARTBEAT_URL` — секретный HTTPS endpoint внешнего dead-man сервиса, который сам поднимает тревогу, если запуски runner прекратились. Redirects для него запрещены. Без URL конфигурация не запустится; `MONITOR_ALLOW_NO_HEARTBEAT=true` существует только для осознанного local/staging запуска и не рекомендуется в production.

## Режимы запуска

```bash
npm run monitor:check
npm run monitor:summary
```

- `check` отправляет сообщение после подтверждённого `OK → WARNING/FAIL`, при эскалации `WARNING → FAIL` и после `WARNING/FAIL → RECOVERY`.
- `summary` всегда отправляет полную текущую сводку.
- По умолчанию проблема подтверждается двумя последовательными запусками, RECOVERY — одним успешным.
- Состояние хранится атомарно в `MONITOR_STATE_FILE`; путь должен находиться на persistent volume. Повреждённый state сбрасывается с отдельным Telegram-предупреждением.
- Lock-файл с обновляемым lease не допускает параллельной записи state и дублирующих алертов даже для долгого живого запуска. Сборка TypeScript выполняется при деплое, а не в cron.

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
4. неверный token одного из трёх ботов.

Для каждого случая первый `monitor:check` должен завершиться с code `1`, второй — отправить один FAIL. После восстановления следующий запуск должен отправить один RECOVERY. В stdout, state-файле и Telegram-сообщении не должно быть token, proxy password, DB URL или абсолютного пути uploads.

## Ограничения первой итерации

`getMe` доказывает доступность proxy, Telegram Bot API и валидность token, но пока не доказывает доставку сообщения в рабочий чат и здоровье polling/webhook loop. Реальный canary `sendMessage`, durable outbox для заявок/оплаченных заказов и бизнес-инвариант `paid → notified` относятся ко второй итерации.

YooKassa, службы доставки, Telegram Gateway/SMS.ru, Redis и браузерный checkout будут добавляться последующими слоями.
