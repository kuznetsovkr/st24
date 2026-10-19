# Официальный nginx — применено 19 октября 2026

Host-specific операция для существующего VPS, не универсальный installer и не
часть deploy.sh. С разрешения владельца в **11:52 по Красноярску** выполнен переход
с ISPmanager `1:1.28.2-142-ubuntu24` на официальный **`1.30.6-1~noble`**.
Удалены только `nginx-common`, `nginx-core` и шесть модулей старого ABI:
HTTP GeoIP, image filter, XSLT, mail, stream, stream GeoIP. Их директивы/переменные
не использовались активной конфигурацией. Другие пакеты и данные панели сохранены.
APT называет замену downgrade из-за epoch `1:`, а не снижения upstream-версии.

## Подготовка и переключение

- Ключ [nginx.org](https://nginx.org/en/linux_packages.html) и подписанные APT
  индексы сначала проверены в отдельном private staging. Основной fingerprint
  `573BFD6B3D8FBC641079A6ABABF5BD827BD9BF62`; официальный keyring содержит также
  опубликованные ключи `8540A6F18833A80E9C1653A42FD21310B49F6B46` и
  `9E9BE90EACBCDE69FE9B204CBCDCD8A38D88A2B3`.
- SHA-256 нового `.deb` из подписанного индекса:
  `86f0f503139203e8d75f1832b309ec084b0de5dfb6b72e11d0327790d3ffb90b`.
- Все девять старых пакетов сохранены приватным `dpkg-repack --tag=none`.
  Его инструменты извлечены отдельно, глобально не устанавливались. 57 обычных
  payload-файлов, режимы и symlinks сверены с установленными. Это repack текущего
  состояния, не исходные vendor `.deb`: текущие conffiles становятся baseline
  пакета. При откате нужны `--force-confold` и сохранённое дерево конфигов;
  будущие обновления repack-пакетов требуют проверки conffile semantics.
- Извлечённый новый бинарник прошёл изолированные network-namespace тесты
  маршрутизации, IPv4/IPv6 default denial, ACME, SNI/Host и reload. Также успешен
  `-t` на приватной копии реальной конфигурации без модулей старого ABI.
- До переключения проверен offsite backup `2026-10-19_04-50-24_UTC`, сохранены
  конфиги, init/logrotate/default, unit/drop-in, хеши env/сборки и PID других служб.
- Независимый systemd self-test подтвердил исходную read-only ветку rollback;
  **реальная обратная переустановка девяти пакетов не репетировалась**. Первый
  self-test отказал до изменений из-за режима staging `0755`; установлен `0700`,
  повторный запуск успешен, failed state сброшен. Затем поставлен 15-минутный
  timer отката и отдельный systemd apply unit, независимый от SSH.
- Перед установкой APT simulation повторно разрешила ровно восемь оговорённых
  удалений и один `nginx`. nginx остановлен, а временный scoped `policy-rc.d`
  запретил его запуск package scripts. Это важно: официальный postinst при живом
  PID вызывает binary upgrade в обход `invoke-rc.d`.
- Локальный проверенный `.deb` установлен с `--force-confold`, без других
  установок/обновлений и purge. Новый `conf.d/default.conf` отключён до старта
  (суффикс `.disabled-karcher`); старые module includes больше не активны.
  Main, shop vhost, платёжный gate и default-deny сохранены побайтово.

Между остановкой и запуском nginx по systemd journal прошло **8,91 секунды**.
Новый master PID `368384`; API `365791`, SSH `290283`, PostgreSQL `289404`, Redis
`289356` не перезапускались. App release остаётся `4a2d790`, Node — 24.22.0.
nginx workers — `www-data`, temp paths `/var/cache/nginx/*_temp` принадлежат
`www-data`; drop-in `LimitNOFILE=16384` и enabled boot сохранены.
`nginx-debug.service` не включён. Временный `policy-rc.d` удалён. VPS не перезагружался.

## Репозиторий и последующие обновления

| Источник | Файл на VPS |
| --- | --- |
| `nginx.sources` | `/etc/apt/sources.list.d/karcher-nginx.sources` |
| `karcher-nginx.pref` | `/etc/apt/preferences.d/karcher-nginx` |
| Проверенный публичный keyring | `/usr/share/keyrings/karcher-nginx.gpg` |

Все три файла root:root `0644`. Pin priority **1001** действует только на nginx:
иначе ISPmanager-пакет с epoch может оказаться предпочтительнее. Старый
`ispmanager-repo-nginx.list` сохранён как `.list.disabled-karcher`.
Установлен hold только `ispmanager-pkg-nginx`, чтобы обновление оболочки панели
не вернуло её пакетную схему. Сама оболочка остаётся установленной; прежде чем
снимать hold, проверить её dependencies/scripts и новый APT plan.
Остальные источники ISPmanager/Ubuntu сохранены. Целевой signed APT update с
`APT::Get::List-Cleanup=0` подтвердил installed/candidate `1.30.6-1~noble`.
Политика unattended-upgrades не менялась; это не включение автообновлений nginx.
`nginx-plan.sources` остаётся только историческим private staging template.

При следующем package upgrade повторно исключить запуск vendor default vhost,
проверить сохранение main/site, отсутствие старых ABI-модулей, worker account,
temp permissions, live HTTP/TLS, Certbot и offsite backup. Не делать общий
`apt upgrade` или purge старых nginx conffiles без отдельного разбора.

## Приёмка и бэкапы

С VPS и рабочего ПК сайт/readiness/notifications — 200; HTML UTF-8, API JSON и
`no-store`. JS/CSS и существующее изображение совпали с диском. HTTP redirect —
301, чужой Host — 404, чужой/отсутствующий SNI отвергнут. POST с телом 2 MiB на
специально несуществующий API route вернул 404, без создания заявки/заказа.
Платёжный webhook не вызывался. Certbot staging dry-run успешен, рабочий
сертификат не заменялся. `nginx -t`, `dpkg --audit` успешны; новых nginx/API errors,
failed units, panel processes и самопроизвольных API restarts нет.

Пять health-раундов за две минуты подтвердили прежние API instance/PID,
здоровье worker/трёх polling-ботов и пустую очередь. В **11:57** результат принят,
таймер автоотката остановлен. 13 новых safeguard tests прошли на Linux; на Windows
12 прошли, один Linux-only пропущен. Вместе с Node guards — 23 теста, CI уже
подхватывает их существующим glob; новый GitHub run без push не запускался.

Post-upgrade backup **`2026-10-19_04-57-04_UTC`** зашифрован, загружен и проверен
полным downloaded-content comparison. Все 27 обычных файлов `/etc/nginx`, режимы,
владельцы и symlinks совпали с локальным архивом; `.certbot.lock` в архиве нет.
Новый restore БД и расшифровка на ПК не выполнялись.

Первая попытка `04-55-54_UTC` корректно отказала на `files_archive`:
`tar: var/www/st24/server/uploads: file changed as we read it`. В это время шли
readiness rounds, создающие/удаляющие исключённые `.health-*.tmp` в uploads;
это вероятная причина directory-mtime race. После их завершения повтор успешен,
`.last-run` и `.last-success` verified. Partial-набор сохранён и не принят за backup.
Не подавлять tar errors: устойчивость к параллельным canary/записям uploads —
отдельное оставшееся улучшение backup workflow.

Controller [nginx_upgrade.py](nginx_upgrade.py), пакеты, receipts и конфиги:
`/root/karcher-nginx-upgrade-plan-20261019` (`0700`). Эта приватная директория,
новые APT configs/keyring и package-level unit/init/logrotate не добавлены
в offsite allowlist. `/etc/nginx` и TLS в offsite есть, но это не образ ОС:
при восстановлении заново установить официальный nginx, репозиторий и проверить
temp paths/unit; затем восстановить согласованные конфиги. Снимки Node/panel
строго привязаны к прежним PID: после этой миграции не менять их ради зелёного verify.

## Точечный откат

Проверка принятого snapshot (последующий deploy/package update может её отвергнуть):

```sh
sudo python3 /root/karcher-nginx-upgrade-plan-20261019/nginx_upgrade.py verify
```

Аварийный ручной откат nginx, пока snapshot/config/PID других служб актуальны:

```sh
sudo python3 /root/karcher-nginx-upgrade-plan-20261019/nginx_upgrade.py revert
```

Handler блокирует посторонние изменения, останавливает только nginx, восстанавливает
девять локальных пакетов без сети/purge и полное исходное дерево конфигов, затем
unit/repo/hold и сайт. БД, исходники, API и другие службы не откатывает.
Обычный `rollback` после accepted намеренно ничего не делает. При независимом
изменении файлов/пакетов сначала ручной разбор; не редактировать receipt/state
для обхода защиты. Общие OS updates и перезагрузка VPS здесь не выполнялись.
