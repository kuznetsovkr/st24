# Восстановление магазина на другом VPS

Этот runbook и `recovery_inventory.py` устанавливаются в
`/usr/local/lib/karcher-backup` и входят в новые зашифрованные копии. Инвентаризация
обновляется **при каждом запуске** бэкапа, до dump/архива; после tar повторно
проверяются package inventory, настройки, права/ACL/xattr и состояния автозапуска.
Изменения или отсутствие обязательных входов прерывают запуск без `verified`.

Это инструкция ручного восстановления, **не установщик и не образ диска**.
Новый VPS в этой итерации не создавался; полного восстановления магазина на нём
пока не было. Проверки извлечения/расшифровки не заменяют такой DR drill.

## Что добавлено в ежедневную копию

В `st24_files.tar.gz`, без изменения age-формата и списка внешних компонентов:

- `/var/lib/karcher-backup/recovery.json`: время/backupSet, текущие версии и
  архитектуры установленных пакетов, manual/hold lists, unit-file states,
  timezone, kernel, Git commit приложения, UID/GID/group/home/shell пяти
  сервисных пользователей, allowlist и хеши/права/владельцы/ACL/xattr конфигов;
- APT sources, preferences, apt.conf.d, публичные keyrings Ubuntu/NodeSource/nginx;
  отдельные APT auth.conf/auth.conf.d не выбираются;
- `/etc/postgresql/16/main`, `/etc/redis`, `/etc/fail2ban`;
- backup watchdog service/timer и его boot link, nginx drop-in и boot link,
  Certbot timer boot link, существующие systemd masks `/dev/null`;
- root-crontab, dpkg statoverride/diversions, неисполняемый ISPmanager PHP hook
  и `panel_autostart.py` для понимания защиты от повторного запуска панели;
- имеющиеся network interfaces, fstab, timezone/localtime, OS release, GRUB,
  dracut и AppArmor config — **справочно**, не для переноса поверх новой ОС.

Прежнее покрытие приложения, uploads, nginx/TLS, env, SSH/firewall и backup tools
сохранено. Коллектор читает только выбранные пути, не следует symlink и не
выполняет команды из конфигов. Имена/хеши хранятся внутри шифрованного payload,
не в открытом внешнем MANIFEST. Каталог inventory — root:root `700`, JSON — `600`.

Не добавлены: личные/host SSH private keys, age identity, OAuth-конфиг rclone,
старые package/boot rollback snapshots из `/root`, `.deb`/kernel binaries,
полная dpkg database, содержимое Redis и PostgreSQL global roles/tablespaces.
Пароли/роли и внешние доступы нужно подготовить отдельно, доверенные пакеты —
получить заново из проверенных репозиториев. Наличие точной версии в inventory
не гарантирует её будущую доступность; поддерживаемые обновления и отличия
окружения проверяются отдельно. Исторические root-only rollback snapshots
по-прежнему только на исходном VPS, этот шаг не экспортирует их в облако.

## Порядок восстановления

1. Сохранить доступ к исходному VPS, если он ещё жив. На новом VPS открыть
   независимую веб-консоль и проверить собственный SSH-ключ. Не менять DNS
   рабочего магазина до проверки нового экземпляра. Сначала восстановление
   выполняется в изолированной среде без реальных отправок Telegram/OTP/платежей.
2. Через собственный аккаунт Яндекс.Диска скачать **три файла одного** проверенного
   набора. На доверенном компьютере взять ключ из менеджера паролей и выполнить
   `encrypted_backup.py open` по [ENCRYPTION.md](ENCRYPTION.md). Проверить age MAC,
   внешние/внутренние SHA-256; не передавать identity на VPS или в Git/чат.
3. Перенести расшифрованные компоненты в отдельный root-only staging нового
   сервера. Проверить список tar и извлекать **только в этот каталог**, с ACL/xattr,
   а не поверх `/`. Восстановленные env/TLS содержат секреты, не печатать их.
4. Прочитать `var/lib/karcher-backup/recovery.json`. Сопоставить backupSet, ОС,
   архитектуру, appCommit, версии, выбранные настройки и accounts. Не применять
   весь package list: он содержит также отключённые пакеты старой панели.
   Не импортировать старую dpkg database, fstab/disk UUID, network/IP, GRUB,
   AppArmor policy или systemd masks без проверки новой ОС и резервной консоли.
5. Подготовить поддерживаемую Ubuntu 24.04 amd64 и подписанные Ubuntu sources,
   затем официальные NodeSource 24.x и nginx stable. Проверить fingerprints,
   Signed-By и источник пакетов независимо от архива; не включать старые
   ISPmanager sources. Сохранённые pins/holds — для анализа, не автоматического
   `apt-mark` replay. Установить PostgreSQL 16, Redis, nginx, Node 24, SSH,
   nftables/fail2ban, cron, Certbot, Python 3.11+, rsync, age, rclone и ACL tools.
6. Создать karcher-api и остальные нужные service accounts. Либо согласовать
   UID/GID с inventory, либо явно переназначить владельцев файлов **и числовые
   ACL** на новые identities. Имена одинаковые не гарантируют одинаковые числа.
   Не подменять passwd/shadow/groups старого сервера.
7. Создать новую БД и роль из параметров env через скрытый ввод/закрытый файл;
   global roles/пароли не входят в `pg_dump`. Сначала восстановить dump в уникальную
   тестовую БД под non-superuser, проверив `SELECT current_database()`, без
   `--create` и без выбора рабочей БД. Проверить схему, строки и FK; конфиги
   PostgreSQL переносить после сверки путей/locale/версий, не восстанавливать
   старый cluster data directory. [Ограничения SQL dump](https://www.postgresql.org/docs/16/backup-dump.html).
8. Подготовить `/var/www/st24` из нужного commit/build, восстановить uploads и
   env (`0640` нужной группе), systemd unit/tmpfiles/logrotate. Исходные каталоги
   и dist не должны стать writable для API; проверить UID, uploads ACL и tmp.
   В тестовой среде запретить рабочие внешние отправки и polling реальных ботов.
   Redis оставить loopback-only; этот набор не восстанавливает его старые данные.
9. Проверить nginx и сертификаты: пути, www-data, default-deny, proxy к API на
   loopback, UTF-8 и защиту payment/webhook endpoint. `nginx -t`, затем локальные
   запросы с правильными Host/SNI без смены DNS; никакие секретные gate не печатать.
10. SSH/firewall переносить по [security runbook](../security/README.md): сначала
    рабочий ключ и новое SSH-подключение, затем проверенные правила/boot links.
    Настроить fail2ban и не публиковать PostgreSQL/Redis/API порты. Маски старой
    панели/почты/FTP осмысленны только при наличии таких пакетов на новом сервере.
11. Поставить root-owned backup tools и публичный recipient, watchdog units и
    Cronitor-конфиг. Выполнить новую OAuth-авторизацию rclone скрыто через SSH.
    Восстановить **проверенную** root-crontab через `crontab`, учитывая timezone;
    не копировать spool file с чужим GID. Включить таймеры и сделать полный
    зашифрованный бэкап с downloaded-content comparison. Убедиться в доставке
    уведомлений; чужие credentials/старый возраст копии не заменяют проверку.
12. Выполнить browser/API/БД/upload checks, business invariants, только тестовые
    Telegram/payment сценарии, проверку reboot с доступной консолью и новый
    restore-test бэкапа. Согласовать перенос трафика и остановку старого polling
    перед запуском рабочих ботов на новом VPS. Только после приёмки менять DNS.

Без отдельной проверки recovery environment не объявлять RTO/RPO выполненными.
Обычные dump/files делаются последовательно, не общим атомарным snapshot.
Хранение старых копий и их удаление — отдельная согласуемая retention-итерация.

## Проверки исходников

```sh
python3 -B -m unittest discover -s ops/backup -p 'test_*.py'
```

На существующем VPS проверка именно последнего собранного inventory, read-only:

```sh
sudo python3 -B /usr/local/lib/karcher-backup/recovery_inventory.py \
  --backup-set ИМЯ_НАБОРА_UTC --verify
```

После новых установок/конфигурационных изменений старый inventory ожидаемо
отвергается — не переписывать прошлую копию. Следующий успешный бэкап создаст
свежий inventory. Утилита host-specific для текущего layout Ubuntu/PG16 и не
подменяет отсутствующие обязательные файлы пустым или частичным набором.
