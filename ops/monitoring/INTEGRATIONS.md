# Диагностика интеграций — этап 1

`GET /api/health/integrations` объединяет безопасные активные проверки внешних
API с существующими readiness и Telegram/outbox/invariants. Новая диагностика
не влияет на запуск API и не заменяет `/api/health/ready` в deploy-check.

| Интеграция | Проверка | Что она НЕ доказывает |
| --- | --- | --- |
| ЮKassa | `GET /v3/me`: авторизация, нужный магазин, enabled, production, методы оплаты | Успешную оплату, webhook, возврат |
| SMS.ru | `POST /my/balance`: авторизация, наличие средств | Доставку SMS, звонка или OTP |
| СДЭК | OAuth client credentials и чтение одного города | Расчёт тарифа, создание и доставку заказа |
| Деловые линии | `POST /v3/public/terminals.json`: метаданные справочника с appkey | Скачивание справочника, расчёт или перевозку |
| Почта России | `GET /1.0/user-shipping-points`: авторизованное чтение настроек | Наличие пунктов, расчёт или создание отправления |
| Redis | Подключение и `PING` | Корректность распределённого rate limiting при нагрузке |
| Telegram | Существующий health: proxy/Bot API, runtime, outbox, бизнес-инварианты | Новый end-to-end тест сообщения от пользователя |
| PostgreSQL/uploads | Существующий readiness: SELECT и файловый canary | Полную исправность всех данных/запросов |
| Turnstile | Ожидаемая отрицательная реакция Siteverify без secret/response | Валидность рабочего ключа и CAPTCHA в браузере: `unverified` |
| Яндекс.Карты | Пока `unverified`, запросы не выполняются | Работу frontend-ключа и виджетов в браузере |
| Telegram Gateway | В `sms_only` — `disabled`; иначе `unverified` | Доставку OTP: проверка ничего не отправляет |

Доставочные API опрашиваются только при `is_enabled=true` в БД. Отсутствие
флагов — ошибка, а не основание объявлять их выключенными. Обязательные
production-ключи SMS/Turnstile и ключи включённых доставок проверяются явно.
Не настроенная ЮKassa — `disabled`; частичные реквизиты — ошибка.
Необязательный Redis без URL — `disabled/optional_memory_fallback`.

## Контракт и защита

- `checks.<id>.status`: `ok`, `warning`, `error`, `disabled`, `unverified`.
- `availability`: `error` при любой ошибке; иначе `warning` при предупреждении;
  иначе `ok`. `status=partial` означает доступные проверенные API, но неполное
  покрытие. Полнота отдельно в `coverage.complete/unverified/disabled`.
- HTTP 503 при `availability=error`, иначе 200. HTTP 200 сам по себе недостаточен:
  Cronitor должен проверять `availability=ok`, включая предупреждение о балансе.
- В ответе только фиксированные коды, время и длительность. Нет ключей, токенов,
  баланса, адресов, provider bodies, proxy/DB URL или текста исключений.
- Внешние HTTPS-хосты фиксированы; redirects запрещены, ответ ограничен 128 KiB.
  Таймаут отдельной пробы 6 секунд, загрузки флагов — 1 секунда. Запросы идут
  параллельно; свой transport не меняет business circuit breakers.
- Общие для всех клиентов single-flight и кеш внешних проб 4 минуты; повторные
  публичные запросы не вызывают отдельный provider request на каждого клиента.
  `checkedAt` пробы сохраняется из реального измерения; HTTP — `no-store`.
  Core health обновляется отдельно с кешем 5 секунд и deadline 3,5 секунды.
- CDEK access token хранится только в памяти, с запасом до expiry; после 401/403
  сбрасывается. Новых таблиц, cron, портов и секретов для endpoint не требуется.

Необязательные env: `INTEGRATION_HEALTH_TIMEOUT_MS` (250–8000, default 6000),
`INTEGRATION_HEALTH_CACHE_TTL_MS` (60000–300000, default 240000),
`INTEGRATION_HEALTH_SMS_MIN_BALANCE_RUB` (целое 0–1000000, default 10).
Баланс <=0 — ошибка; положительный ниже порога — предупреждение. Не понижать
порог только ради зелёного статуса. Изменения managed env требуют рестарта API.

Разовая операторская проверка без запуска ботов или бизнес-воркеров:

```bash
cd /var/www/st24/server
INTEGRATION_HEALTH_ENV_FILE=/etc/karcher/api.env npm run integrations:check
```

CLI читает флаги доставок из публичного API; выдаёт только безопасный provider
report, без core health. Exit 0 — availability ok, 1 — warning/error, 2 — ошибка
загрузки конфигурации. Доступ к managed env нужен оператору, не внешнему сервису.

## Cronitor без шестого монитора

Шаблон [cronitor-integrations-monitor.json](cronitor-integrations-monitor.json)
**заменяет настройки существующего HTTP-монитора Telegram**, а не создаёт ещё
одну проверку. Сохранить его реальный key/id, историю, notification list, Alerts
On и работающие site/readiness/backup/storage monitors. Старый шаблон Telegram
остаётся для отката; оба одновременно в один слот не устанавливаются.

После выкладки и проверки endpoint открыть **Edit** существующего Telegram
HTTP-монитора, переименовать в «Karcher — интеграции», заменить URL на
`https://xn---24-3edf.xn--p1ai/api/health/integrations`. Оставить GET, every
5 minutes, timeout 10 seconds, SSL verification, redirects off, default recipients.
Удалить старые assertions `status`, `worker.status`, `outbox.dead`,
`invariants.failedLeadNotifications`: у нового endpoint другая форма ответа.
Внести assertions нового шаблона целиком. Management key и Telemetry URL не нужны.

Не требовать `status=ok` или `coverage.complete=true`: браузерный этап ещё не
сделан. При `balance_low` ожидается настоящая тревога, не ошибка шаблона.
Зелёный внешний запуск должен содержать `availability=ok` и core checks ok.
Затем отдельным безопасным изменением assertion проверить тревогу и восстановление
в Telegram по инструкции [README.md](README.md#приёмка-без-остановки-магазина).
Не отключать провайдер, сайт, proxy, БД или очередь ради такого теста.

**Endpoint, подготовленный шаблон и успешный запрос с VPS ещё не доказывают,
что новый монитор настроен в аккаунте и его уведомления доставляются.**
Stage 2 — production browser smoke, stage 3 — приёмка тревог/восстановлений.

## Выкладка и проверка 25 октября 2026

В 15:05 по Красноярску endpoint выложен на VPS после согласованного рестарта
только `karcher-api.service`. Предварительный зашифрованный бэкап
`2026-10-25_08-00-40_UTC` verified/complete. Прямой и публичный readiness
подтвердили новый process instance; nginx/PostgreSQL/Redis/SSH не перезапускались,
9 защищённых конфигураций, env, proxy и зависимости не менялись. Production
engine declaration сохранён; старые ограничения Node не являются частью этой
точечной выкладки. Перед изменением сохранены исходные файлы и подготовлен откат.

С VPS и рабочего ПК проверены HTTP 200, JSON и `no-store` нового endpoint:
ЮKassa, СДЭК, Деловые линии, Почта России, Redis и core checks — `ok`.
SMS.ru — настоящее `warning/balance_low`: баланс положительный, но ниже 100 ₽.
Turnstile/карты — `unverified`, Gateway — `disabled` в `sms_only`. После рестарта
все три бота `ok`, pending/retry/dead и бизнес-инварианты — 0, failed units — 0.
Платежи, OTP, SMS, заявки и тестовые сообщения не создавались.

Финальный `2026-10-25_08-05-47_UTC` verified/complete в 15:05:59, включая обратное
cloud-чтение; SHA-256 всех 15 выложенных файлов совпал с содержимым tar.
Backup/storage watchdog здоров. Root-only receipts и rollback:
`/root/karcher-integrations-20261025/`. Это не новый restore БД на чистом VPS.

При выкладке агент не использовал доступ к управлению аккаунтом Cronitor и не
менял существующие пять мониторов. После выкладки владелец подтвердил
переименование существующего Telegram HTTP-монитора и смену URL на новый endpoint;
дополнительный монитор не создавался.
Затем владелец подтвердил скриншотом все семь Assertions и прислал ответ
внешнего запуска в 15:29 по Красноярску: `availability=warning` из-за SMS.ru.
Тревога о старом условии `worker.status` при переключении URL в 15:14 дошла
в Telegram, что подтверждает доставку FAIL этим монитором на тот момент.
**Восстановление после согласования порога SMS.ru пока не подтверждено**.

### Уточнение политики SMS.ru

Владелец уточнил: рабочий баланс ниже 100 ₽ допустим; тревога нужна при
приближении к нулю, а не при таком штатном остатке. Порог предупреждения изменён
со 100 на 10 ₽: `0 < balance < 10` — warning, `balance <= 0` — error,
`balance >= 10` — ok. Это уточнение эксплуатационного порога; ошибки авторизации,
сети и пустой баланс не подавляются. Исходный результат проверки выше сохранён
как история первоначальной настройки. На VPS порог фиксируется явным managed env.

Применено 25 октября в 15:38 по Красноярску после 207 успешных тестов и
предварительного verified/complete бэкапа `2026-10-25_08-36-10_UTC`.
Перезапущен только API; после проверки нового instance все три бота здоровы,
очередь и инварианты — 0. С VPS и рабочего ПК получены `availability=ok`,
`sms_ru.status=ok`, `balance_sufficient`; `status=partial` сохраняется из-за
браузерного покрытия. В env изменён только согласованный порог, остальные
защищённые настройки и службы не затронуты. Итоговый
`2026-10-25_08-38-40_UTC` verified/complete в 15:38:52, включая cloud-чтение;
в tar сверены все шесть изменённых файлов, в том числе managed env.
Backup watchdog здоров, failed units — 0. Root-only receipts/rollback:
`/root/karcher-sms-threshold-20261025/`. Внешнее восстановление Cronitor и его
доставка ещё требуют подтверждения владельца.

Методы сверены с официальными источниками: [ЮKassa](https://yookassa.ru/developers/api#get_me),
[SMS.ru](https://sms.ru/docs/api/api_group_sms/balance), [СДЭК](https://apidoc.cdek.ru/),
[Деловые линии](https://dev.dellin.ru/api/terminals/directory/),
[Почта России](https://otpravka.pochta.ru/static/views/specification/settings-shipping_points.html),
[Cloudflare](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).
