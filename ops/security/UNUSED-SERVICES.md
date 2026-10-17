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
Пакетный `/etc/cron.daily/phpsess_cron` оставлен: он очищает старые PHP-сессии,
не запускает панель или PHP-FPM. Уже неактивные другие версии PHP и шаблонные
Apache units не удалялись и отдельно не маскировались.

Сохранены nginx, `her-api`, PostgreSQL 16, Redis, SSH, Fail2ban, `systemd-resolved`,
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
systemctl is-active her-api nginx ssh postgresql@16-main redis-server cron fail2ban
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
