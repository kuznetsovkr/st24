# Nginx без старых конфигов ISPmanager

Применено на VPS магазина 17 октября 2026. Это конфигурация существующего хоста,
не универсальный installer: `deploy.sh` её автоматически не устанавливает.
Пакеты, данные и старые конфиги панели не удалены. Магазин не перезапускался;
nginx применил настройки через graceful reload.

19 октября пакет nginx отдельно переведён на официальный 1.30.6 с удалением
неиспользуемых модулей старого ABI. Main/shop/default-deny сохранены; описание
миграции и **актуального package rollback** — [runtime runbook](../runtime/NGINX-UPGRADE.md).
Ниже история очистки 17 октября; её старый helper не применять вслепую после
новой пакетной миграции.

## Файлы и маршрутизация

| Источник | Файл на VPS |
| --- | --- |
| `nginx.conf` | `/etc/nginx/nginx.conf`, root:root `0644` |
| `00-karcher-default-deny.conf` | `/etc/nginx/conf.d/00-karcher-default-deny.conf`, root:root `0644` |

Основные настройки сохранены: пользователи/workers, лимит тела 128 MiB, MIME,
логи, TLS 1.2/1.3, загрузка существующих модулей. Из главного конфига исключены
include `vhosts/*/*.conf` и старый `localhost` server с `vhosts-includes` и
fallback в Apache на `127.0.0.1:8080`.

`/etc/nginx/conf.d/ssl_servers_inc.conf` переименован в
`ssl_servers_inc.conf.disabled` с сохранением содержимого и прав. Под `*.conf`
он больше не попадает. Поэтому не загружается `ssl_cert_servers/manager.conf`,
nginx больше **не слушает 1501**. Старые `ssl_cert_servers`, `vhosts-includes`
и файлы phpMyAdmin/Roundcube/awstats остаются на диске, но не входят в активную
конфигурацию. Не возвращать этот include без повторного аудита.

Публичный домен магазина `xn---24-3edf.xn--p1ai` обслуживается прежним
`/etc/nginx/sites-available/st24` через существующую ссылку `sites-enabled/st24`.
Этот файл, платёжный webhook gate и рабочий сертификат не менялись; сверены SHA-256.
API/uploads по-прежнему проксируются на `127.0.0.1:4000`.

Отдельный default virtual host возвращает 404 для чужого/пустого HTTP Host и
запросов по IP. На HTTPS неизвестный/отсутствующий SNI отклоняется до выдачи
сертификата. Известный SNI с чужим HTTP Host также не отдаёт магазин.
Это использует [выбор default server](https://nginx.org/en/docs/http/request_processing.html)
и [ssl_reject_handshake](https://nginx.org/en/docs/http/ngx_http_ssl_module.html#ssl_reject_handshake)
(nginx >= 1.19.4; на VPS проверены 1.28.2 и затем 1.30.6).

IPv4 HTTP/HTTPS и существующий IPv6 HTTP listener сохранены. IPv6 HTTPS магазину
здесь не добавлялся: у VPS нет глобального IPv6 и у shop vhost нет `listen [::]:443`.
При дальнейшем включении IPv6 нужно согласованно настроить shop и default vhosts,
DNS/AAAA и повторить внешние проверки; одной AAAA-записи недостаточно.

## Проверки

На Linux с nginx, OpenSSL, iproute2 и util-linux:

```sh
sudo python3 ops/nginx/test-config.py
```

Тест создаёт **новый network namespace** и отказывается работать в namespace
PID 1. Он использует отдельные дерево конфигов, PID, логи и временный тестовый
сертификат, не читает production secret и не посылает сигнал работающему nginx.
Проверены синтаксис, HTTP default denial IPv4/IPv6, маршрутизация тестового
домена, путь ACME, проверки TLS SNI/Host и фактическая загрузка нового ответа
через reload. Этот тест успешно выполнен на VPS; шаг добавлен в CI, удалённый
GitHub Actions run в рамках этой итерации не запускался.

На реальном VPS до изменений независимый systemd timer выполнил полный
обработчик отката на исходной конфигурации. Затем на период работ включался
отдельный 15-минутный rollback timer. После приёмки он отменён.

Итоговые проверки с рабочей станции:

- Сайт, JS/CSS, readiness — HTTP 200, UTF-8 и `Cache-Control: no-store` для readiness;
  PostgreSQL/uploads `ok`, HTTP → HTTPS — 301.
- 12 HTTP-проверок сочетаний чужого Host/IP/localhost и старых admin-путей — 404.
  Это не требование 404 для тех же путей с доменом магазина: там действует его SPA.
- Неизвестный/отсутствующий TLS SNI отклоняется; правильный SNI с чужим Host — 404.
- В `nginx -T` нет активных ссылок на mgr5, PHP-FPM, Apache, старые vhosts и 1501.
  В `ss -lnt` больше нет listener 1501. `nginx -t` успешен.
- `certbot renew --dry-run --non-interactive --no-random-sleep-on-renew` успешно
  выполнил тестовое продление в staging ACME без замены рабочего сертификата.
- API PID `743`, nginx master `151593`, SSH master `290283` не изменились.
  SSH, PostgreSQL, Redis, cron, Fail2ban, firewall, Certbot timer и backup health
  работают; отключённые ранее службы остаются masked.

### Backup новой конфигурации

После завершения Certbot создан набор `2026-10-17_15-19-00_UTC`. Локальные
checksums проверены, зашифрованный экспорт выгружен в Яндекс.Диск и проверен
скачиванием штатным backup-скриптом. Все 24 обычных файла nginx в локальном архиве
совпали с итоговыми файлами VPS, включая главный/default конфиги, shop vhost,
webhook gate и отключённый include. Временного `.certbot.lock` в наборе нет.
Watchdog успешно отправил реальные статусы. Новое восстановление БД и расшифровка
экспорта на ПК в этой итерации не выполнялись.

Первый пробный набор `2026-10-17_15-17-45_UTC` создавался параллельно с dry-run
Certbot: отличался только служебный `.certbot.lock`, сами конфиги совпали.
Копия не объявляется повреждённой и не удалена; для приёмки выбран следующий
стабильный набор. Наблюдение записано root-only рядом с локальными копиями.
Для дальнейших проверок запускать Certbot и контрольный backup последовательно.

Весь `/etc/nginx` уже входит в ежедневный зашифрованный backup; allowlist для
этого шага не менялся. Root-only снимок для отката ниже не экспортируется в облако;
сами новые nginx-конфиги в указанном offsite наборе есть.

## Изменения и откат

Нельзя слепо копировать эти host templates на другой VPS. Сначала сверить nginx
версию, существующие `conf.d`/`sites-enabled`, сертификат, модули, API/uploads и
webhook gate. В частности, не должно остаться второго `default_server` из
дистрибутивного сайта или активного `ssl_servers_inc.conf`.
Любые изменения применять после root-only snapshot и независимого rollback timer:

```sh
nginx -t
systemctl reload nginx
```

Проверить новые внешние соединения, а не только успешный exit code reload.
Семантика graceful reload — в [документации nginx](https://nginx.org/en/docs/control.html).

Снимок текущего изменения: `/root/karcher-nginx-cleanup-20261017T151500Z` (`0700`).
Там `nginx.before.tar.gz`, исходные два изменённых файла, `snapshot.json`,
`cleanup.py`, проверенные исходники, `acceptance.json`, журналы TLS/backup и marker
`committed`. Архив/логи могут содержать секреты; их не коммитить и не отправлять в чат.

Полный откат **только при необходимости**, пока эти файлы независимо не менялись:

```sh
sudo -i
cd /root/karcher-nginx-cleanup-20261017T151500Z
mv -- committed committed.before-manual-rollback
python3 ./cleanup.py rollback "$PWD"
```

Helper восстанавливает исходный main/include, снимает только свой default config,
проверяет синтаксис и выполняет reload. Shop vhost, webhook gate, TLS-ключи,
службы и firewall он не восстанавливает/не меняет. Старый listener панели снова
появится локально, но останется закрыт firewall, а службы панели останутся masked.
Если есть последующие правки, сначала сохранить их и выполнить точечный откат;
не распаковывать весь старый nginx поверх актуального вслепую.
