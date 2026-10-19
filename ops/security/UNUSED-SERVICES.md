# Отключённые службы старого окружения VPS

Применено 17 октября 2026 после коммита `3a2dfc8`. Владелец подтвердил, что VPS
используется только магазином, а ISPmanager, серверная почта и FTP не нужны.
Согласовано отключение служб **без удаления пакетов, конфигурации и данных**.

## Что отключено

| Назначение | Units в `inactive / masked` |
| --- | --- |
| ISPmanager | `ihttpd.service`; отдельно завершены через SIGTERM два core-процесса `core`/`ispmgr` |
| SMTP и обслуживание очереди | `exim4.service`, `exim4-base.timer`, `exim4-base.service` |
| IMAP/POP3 | `dovecot.service`, `dovecot.socket` |
| FTP | `proftpd.service`, `proftpd.socket` |
| DNS-сервер | `named.service`, `named-resolvconf.service`; masked также alias `bind9.service` |
| Старый web/PHP | `apache2.service`, `php-fpm74.service`, `php8.3-fpm.service` |
| Очистка PHP-сессий через systemd | `phpsessionclean.timer`, `phpsessionclean.service` |
| База старого окружения | `mysql.service` |

Активные 17 заданий root cron с `/usr/local/mgr5/` закомментированы с префиксом
`# KARCHER_DISABLED_ISPMANAGER`. Исходные строки сохранены в root-only снимке.
В root crontab осталась без изменений ежедневная задача:

```cron
30 3 * * * /usr/local/bin/st24-backup.sh >> /var/log/st24-backup.log 2>&1
```

Это 03:30 по серверу (Москва), 07:30 по Красноярску. Сам `cron.service` не отключён.
Пакетный `/etc/cron.daily/phpsess_cron` первоначально оставили. Предположение,
что он только очищает PHP-сессии и не запускает панель, оказалось ошибочным:
он вызывает `mgrctl`, который может поднять core панели в обход systemd-маски.
Этот остаточный запуск устранён отдельным изменением 18 октября, описанным ниже.
Уже неактивные другие версии PHP и шаблонные Apache units не удалялись и
отдельно не маскировались.

Сохранены nginx, `karcher-api`, PostgreSQL 16, Redis, SSH, Fail2ban, `systemd-resolved`,
firewall, Certbot и backup health timer. Fail2ban по-прежнему содержит jail
`sshd` и `exim-isp`; почтовый jail не удалялся.

## Почему это не зависимости магазина

- В shop virtual host nginx только статика React и proxy к `127.0.0.1:4000`;
  ссылок на Apache/PHP/панель в нём нет. Старые глобальные admin-конфиги оставлены.
- API использует PostgreSQL; в работающем MySQL были только системные схемы,
  `roundcube` и `phpmyadmin`. Их файлы не удалялись.
- NS домена — `ns1.reg.ru`/`ns2.reg.ru`. Сам VPS использует `systemd-resolved`
  с DNS провайдера, а не локальный BIND. Локальные stub-сокеты DNS остаются штатно.
- Certbot использует nginx authenticator/installer, без hooks панели.

`disable` сам по себе не препятствует запуску службы другими компонентами;
`mask` запрещает запуск через systemd. Он не защищает от ручного запуска бинарника
root-пользователем. Поэтому также остановлены core-процессы и задания панели.
Семантика описана в [systemctl](https://github.com/systemd/systemd/blob/main/man/systemctl.xml).

## Что проверено

- Перед изменениями независимый systemd timer выполнил обработчик отката на
  неизменённом состоянии: восстановление без ошибок, cron не изменился.
- Во время работ действовал отдельный 15-минутный автоматический откат.
- После каждого отключения — внешний HTTPS сайта/API и новое SSH-подключение.
- Итог: сайт, JS, CSS, readiness — 200; PostgreSQL/uploads `ok`, `no-store`,
  HTTP → HTTPS — 301; `nginx -t` и `sshd -t` успешны.
- DNS самого VPS, чтение квоты Яндекс.Диска и реальная отправка backup health
  успешны. Таймеры backup health и Certbot остались enabled/active.
- `certbot renew --dry-run --non-interactive --no-random-sleep-on-renew`:
  все тестовые продления успешны, рабочий сертификат не заменён.
  Это рекомендуемая [проверка Certbot](https://eff-certbot.readthedocs.io/en/stable/using.html).
- На приёмке процессы панели, MySQL, BIND, Apache, PHP-FPM, почты и FTP отсутствуют;
  службы не вернулись за несколько минут наблюдения. API PID `743`, nginx master
  `151593`, SSH master `290283` не изменились. Доступная RAM: примерно 2587 →
  3007 MiB на одном замере; реальные значения зависят от нагрузки и cache.
- Автоматический откат отменён после успешных проверок. VPS не перезагружался;
  поведение после reboot пока проверено конфигурацией, не реальной перезагрузкой.

На момент отключения служб порт 1501 ещё слушал nginx из старого panel virtual
host, оставаясь закрытым firewall. Следующим согласованным этапом эти include и
старый default server отключены; listener 1501 больше нет. Подробности и отдельный
откат — [nginx/README.md](../nginx/README.md). Откат только служб ниже не возвращает
удалённые из активной nginx-конфигурации подключения.

## Проверка состояния и откат

Только root, через настроенный SSH alias. Снимок:
`/root/karcher-services-retirement-20261017T145700Z` (`0700`).
Внутри — `snapshot.json` (исходные состояния и точные boot-ссылки), исходный и
изменённый root crontab, `rollback.py`, журналы, `acceptance.json`, marker `committed`.
Содержимое cron/log не отправлять в чат и не коммитить: там могут быть секреты.

Для осмотра достаточно:

```sh
systemctl is-enabled ihttpd exim4 dovecot proftpd named bind9 apache2 mysql php-fpm74 php8.3-fpm
systemctl is-active karcher-api nginx ssh postgresql@16-main redis-server cron fail2ban
systemctl is-active karcher-firewall karcher-backup-health.timer certbot.timer
ss -lnt
```

Первая команда должна печатать `masked`; не трактовать её ненулевой exit code
как ошибку применения. Для возврата одной службы сначала сверить зависимости,
затем `systemctl unmask ИМЯ` и `systemctl start ИМЯ`; автоматический запуск и задания
панели от этого не восстанавливаются. Не снимать маски SSH/firewall и не очищать
правила nftables ради запуска старой службы.

Полный откат **только при необходимости** на этом же VPS, пока конфигурация
не изменялась независимо после снимка. Он вернёт старый root cron и исходные
boot-ссылки, запустит только ранее активные службы и core-модули. Сначала защитить
актуальное состояние/cron, если после работ уже были другие изменения.

```sh
sudo -i
cd /root/karcher-services-retirement-20261017T145700Z
mv -- committed committed.before-manual-rollback
python3 ./rollback.py rollback "$PWD"
```

Marker специально предотвращает случайный откат уже принятого результата.
Не восстанавливать всё окружение только ради одной службы. После любого отката
проверить SSH, firewall, публичный магазин/readiness и backup health.

Этот снимок и маски отключённых служб **пока только на VPS**, не в allowlist
ежедневного offsite backup. Основной backup сохраняет магазин/PostgreSQL и защиту
SSH/firewall, но не данные старого MySQL. При развёртывании с нуля заново проверить
зависимости, применить согласованный список отключений и оставить только backup
в root cron; не копировать весь старый cron или каталоги `/etc/systemd/system` вслепую.

## Остаточный автозапуск ISPmanager — 18 октября 2026

Повторный аудит обнаружил `/usr/local/mgr5/bin/core ispmgr` в cgroup `cron.service`.
Он запустился около 10:25 по Красноярску (06:25 по серверу); в ту же минуту root
crontab получил 12 новых активных заданий панели. Ранее закомментированные
17 строк сохранились. Системный cron в 06:25 запускает `/etc/cron.daily`, где
`phpsess_cron` вызывает `phpsess_clean.sh`, а тот — `mgrctl -m ispmgr`.
По коду и времени это источник повторного запуска; отдельный запуск отключённого
PHP-cleaner на живом VPS для воспроизведения не выполнялся.

Применён ограниченный фикс без удаления пакетов/данных и без перезагрузки:

- `dpkg-statoverride --update --add root root 0644 /etc/cron.daily/phpsess_cron`:
  исходные байты файла сохранены, execute-биты сняты. `run-parts --test
  /etc/cron.daily` больше не выбирает его. Override сохраняет режим при обычном
  обновлении пакета; одного `chmod` для этого недостаточно.
- Новые 12 заданий панели закомментированы с прежним префиксом
  `# KARCHER_DISABLED_ISPMANAGER`. Ежедневный backup сохранён **байт-в-байт**.
- Core остановлен через SIGTERM с проверкой executable/module и pidfd-защитой
  от переиспользования PID. `cron.service` не останавливался; чужие процессы
  и службы не затрагивались. Существующие systemd-маски не менялись.
- Установлен root-only helper `/usr/local/lib/karcher-security/panel_autostart.py`
  из [panel_autostart.py](panel_autostart.py). Он отказывается работать с
  неизвестными cron-заданиями, чужим statoverride или изменённым снимком.

Файл является пакетным **conffile**, поэтому здесь используется statoverride,
а не `dpkg-divert`. Ограничение не запрещает root вручную вызвать `sh`/`mgrctl`,
принудительно сменить права или восстановить задания панели. После ручного
обновления старых panel-пакетов повторить проверки; переустановка ISPmanager
как продукта в этом шаге не тестировалась.

Механизмы: [dpkg-statoverride](https://manpages.debian.org/bookworm/dpkg/dpkg-statoverride.1.en.html),
[run-parts](https://manpages.debian.org/bookworm/debianutils/run-parts.8.en.html).

### Проверки и локальный снимок

Снимок — `/root/karcher-panel-autostart-20261018T062615Z`, root `0700`:
`state.json`, исходный/новый crontab, `acceptance.json`, `observation.json`,
результат независимого self-test и журнал отката. Содержимое cron не публиковать.
Self-test через systemd timer исполнил настоящий обработчик отката на исходном
состоянии до изменений. На период применения включён отдельный 15-минутный
rollback timer. После семи успешных раундов наблюдения за 301 секунду результат
принят около 13:33 по Красноярску, автоматический откат отменён. На всём интервале
panel jobs/core не возвращались; в cron journal после применения нет вызовов
`/usr/local/mgr5/`. Настоящая следующая суточная задача/reboot не ожидались:
проверены выборка планировщика и отдельный изолированный package upgrade.

Сравниваются PID/active-state защищённых служб и SHA-256 конфигов приложения,
nginx, SSH и firewall. Проверяются публичные readiness/notification health,
все три polling-бота и отсутствие panel cron/core. Реальные сообщения,
платежи, OTP или заказы для проверки не создаются.

На VPS прошли **18 тестов**, включая Linux root integration ниже; на Windows —
17 с одним ожидаемым пропуском Linux integration. Прямые внешние HTTP-проверки
с рабочего ПК подтвердили 200 для сайта, JS/CSS, readiness и notifications,
все три бота `ok`, получатели 3/4/3, pending/retry/dead и нарушения инвариантов —
0. `nginx -t`, `sshd -t`, `dpkg --audit` успешны, failed units нет. Маски старых
служб сохранены. Чтение квоты облака успешно, backup health в 13:30 по
Красноярску завершился с `Result=success`; ежедневный backup cron не изменён.
Последняя проверенная offsite-копия остаётся `2026-10-18_05-26-52_UTC`: новый
полный backup, расшифровка или восстановление БД в этом шаге не запускались.

Тесты без обращения к рабочему cron/БД пакетов:

```sh
python3 -m unittest discover -s ops/security -p 'test_panel_*.py'
```

На Linux root дополнительно тестируется реальная установка и обновление
безвредного dummy-пакета **только во временный `dpkg --root`**. Его conffile
обновляется, но сохраняет `0644`; запуск `run-parts` пропускает отключённый файл
и выполняет соседнее тестовое задание. На Windows этот интеграционный тест
пропускается. Проверки добавлены в CI; это не утверждение о новом GitHub run.

### Проверка действующей настройки

```sh
sudo dpkg-statoverride --list /etc/cron.daily/phpsess_cron
sudo stat -c '%U:%G %a' /etc/cron.daily/phpsess_cron
sudo run-parts --test /etc/cron.daily
sudo python3 /usr/local/lib/karcher-security/panel_autostart.py verify /root/karcher-panel-autostart-20261018T062615Z
```

Ожидаются override `root root 644`, режим `root:root 644`, отсутствие hook в
выборке `run-parts` и успешная проверка helper. После будущих штатных деплоев
helper намеренно может отвергнуть изменённые PID/конфиги: он проверяет именно
этот снимок, а не универсальное состояние любого будущего релиза.

### Откат только этого исправления

Не запускать полный откат 17 октября ради возврата одного cron-hook: он также
включает почту, FTP и другие отключённые службы. В пределах свежего снимка:

```sh
sudo python3 /usr/local/lib/karcher-security/panel_autostart.py revert /root/karcher-panel-autostart-20261018T062615Z
```

Явный `revert` возвращает только исходный режим hook, отсутствие **своего**
override, исходный root cron и ранее активные core-модули. Автоматический
`rollback` после принятой приёмки ничего не делает. Чужие изменения содержимого
hook/cron/override не перетираются; тогда требуется точечный ручной разбор.
Важно: `dpkg-statoverride --remove` сам по себе **не возвращает** execute-биты,
поэтому helper восстанавливает сохранённый режим отдельно.

Снимок, этот helper и statoverride не добавлены в allowlist ежедневного offsite
backup этим шагом. При восстановлении нового VPS применять эту инструкцию
отдельно; не восстанавливать всю `/var/lib/dpkg/statoverride` поверх другой ОС.

### Повторная проверка после прерывания — 19 октября 2026

Около 00:34 по Красноярску, спустя 11 часов после приёмки, настройка осталась
в силе: core-процессов панели нет, активных root jobs панели нет, после приёмки
в cron journal не было вызовов `/usr/local/mgr5/`. В root cron по-прежнему только
исходная backup-задача. Hook имеет `0644`, override сохранён, `run-parts --test`
его не выбирает. Проверка helper прошла с прежними PID и хешами защищённых
конфигов; автоматический rollback неактивен, состояние снимка `accepted`.

Сайт/readiness/notifications отвечают 200, PostgreSQL/uploads, worker и три бота
здоровы, pending/retry/dead и нарушения инвариантов — 0. Все 18 Linux-тестов
повторно успешны; `nginx -t`, `sshd -t` и `dpkg --audit` без ошибок, failed units
нет. Backup health успешно отработал в 00:30 по Красноярску; последняя полная
проверенная копия остаётся от 18 октября, следующий backup запланирован на
19 октября 07:30. Следующий суточный `cron.daily` — 19 октября в 10:25 — на момент
этой проверки ещё не выполнялся; его прохождение не объявляется проверенным.
Повторное применение изменения, перезапуски служб или новый деплой не требовались.

В 11:24 по Красноярску отдельно подтверждён реальный суточный запуск
`cron.daily` 19 октября в 10:25: панель не поднялась, её заданий в cron нет,
strict verification ещё прошла с прежними PID. Позднее в тот же день API PID
изменился из-за согласованного обновления Node, не из-за возвращения панели;
этот исторический снимок не переписывался. Продолжение —
[обновление runtime](../runtime/README.md).
