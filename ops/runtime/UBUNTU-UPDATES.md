# Обновления Ubuntu без перезагрузки — 19 октября 2026

Это история первого этапа в 12:14–12:20. Позднее в тот же день оставшиеся
пять пакетов обновлены и reboot успешно проверен —
[завершение maintenance](BOOT-MAINTENANCE.md). Ниже сохранены состояние и решения
на момент первой приёмки, не текущий список pending updates.

Host-specific операция на существующем VPS после миграции Node/nginx. В **12:14
по Красноярску** установлены 30 заранее отобранных обновлений Ubuntu; в **12:20**
результат принят. Это не полное обновление всех пакетов и не upgrade дистрибутива.
После обновления `base-files` `/etc/os-release` сообщает **Ubuntu 24.04.5 LTS**,
ветка остаётся 24.04. VPS не перезагружался.

## Выбор пакетов и защита операции

Обновлены base-files, binutils и его библиотеки, dmidecode, iproute2, kpartx,
языковые пакеты, libapparmor1 (без policy package), audit/Kerberos/procps libraries,
linux-base (не kernel image), procps, python-apt, release-upgrader tools,
qemu-guest-agent и tzdata. Полный allowlist — [ubuntu_update.py](ubuntu_update.py),
точные версии и SHA-256 `.deb` — в приватных receipts VPS.

1. Обновлены только индексы трёх существующих Ubuntu sources, с проверкой
   `ubuntu-archive-keyring.gpg` и `APT::Get::List-Cleanup=0`. URI зеркала не менялся.
   Отобраны только версии с trusted Ubuntu origin. Репозитории ISPmanager,
   NodeSource/nginx и настройки unattended-upgrades не менялись.
2. Из 35 доступных обновлений отложены пять пакетов, перечисленных ниже.
   Первая симуляция автоматически добавляла AppArmor даже без явного выбора;
   точная проверка отказала. В повторной симуляции пять deferred versions явно
   закреплены на установленных значениях **только аргументами команды**, без
   новых постоянных holds/pins. Итог: 30 upgrades, 0 new installs, 0 removals.
3. Новые `.deb` скачаны отдельно, SHA-256 сверены с подписанным индексом,
   maintainer scripts проверены на запуск служб/изменения загрузки/политики.
   Старые пакеты сохранены через private dpkg-repack. Для 30 выбранных пакетов
   проверены 1873 обычных payload-файла, их режимы и symlinks.
4. Private dpkg-repack 1.52 не смог упаковать два legacy `/bin` файла на usrmerged
   Ubuntu (`/bin/ip`, `/bin/setupcon`): родитель не был в package filelist.
   Исправлена только приватная копия инструмента: создание отсутствующего parent
   с исходным mode/UID/GID перед copy. Повторная упаковка и payload comparison
   успешны; глобальный пакет инструмента не устанавливался/не менялся.
5. Проверен зашифрованный pre-update backup **`2026-10-19_05-11-32_UTC`**.
   В root-only staging создан отдельный архив `/etc` и package database
   `etc-dpkg-before.tar.gz`. Подготовительный guard также отказал до изменения
   системы при несовпадении native Multi-Arch names (`:amd64`) с python-apt;
   нормализация исправлена и покрыта тестом, foreign architecture сохраняет suffix.
6. Применение выполнялось отдельным systemd unit, независимо от SSH. APT timers
   временно остановлены, scoped `policy-rc.d` запрещал автоматические действия
   со службами. Зависимости проверены APT simulation; `dpkg --force-confold
   --install` получил **ровно 30 проверенных локальных артефактов**, без resolver,
   скачиваний и APT hooks. [needrestart](https://manpages.ubuntu.com/manpages/noble/man1/needrestart.1.html)
   после обновления вызывался явно в read-only list mode, не auto restart.
7. Cleanup выполнен в `finally` и продублирован независимым `ExecStopPost`;
   его исходная ветка заранее проверена отдельным systemd unit. Снимается только
   свой policy и восстанавливается исходное active state двух APT timers.
   Затем один раз явно перезапущен **только qemu-guest-agent**, новый PID `376188`.

Главные PID сохранены: nginx `368384`, API `365791`, SSH `290283`, PostgreSQL
`289404`, Redis `289356`, systemd-resolved `279925`. Сохранены env/сборка/API unit,
nginx main/shop/payment gate/default-deny, sshd config, firewall config, root cron,
statoverride PHP hook, boot image/GRUB bytes и активная AppArmor policy.
Приложение остаётся на `4a2d790`, Node 24.22.0, nginx 1.30.6. Reboot/autoremove,
переконфигурация сети и обновление пакетов панели не выполнялись; старый hold
`ispmanager-pkg-nginx` сохранён. Другие 38 pending candidates — не Ubuntu origin.

### Проверка после установки и краткая блокировка APT

При возвращении persistent `apt-daily.timer` штатный apt-daily немедленно
отработал и на секунду занял frontend lock. Пакеты уже были успешно установлены,
но самый первый `apt-get check` вернул lock contention: apply unit завершился
ошибкой проверки, state остался `applied`, cleanup выполнился. **Повторной
установки и отката пакетов не было**. Повторный независимый verify успешен;
добавлено ожидание `DPkg::Lock::Timeout=60`, запись в журнале сохранена,
failed state сброшен после проверки. Lock files не удалялись, процессы не убивались.

После этого пять health-раундов за две минуты успешны. Сайт/readiness/notifications
с VPS и ПК — 200, HTML UTF-8/API JSON, чужой Host — 404. Worker и три бота `ok`,
очередь и все семь business invariants — 0, новых API errors/restarts нет.
`dpkg --audit`, `apt-get check`, `nginx -t`, `sshd -t` успешны, failed units нет,
панель не вернулась. Временного policy нет, APT timers работают как прежде.
Плановая backup health проверка в 12:20 успешна.

Post-update backup **`2026-10-19_05-17-20_UTC`** зашифрован, загружен и проверен
полным downloaded-content comparison. Restore БД и расшифровка на ПК здесь не
выполнялись. Runtime/private package snapshots и полный архив `/etc`/dpkg **не
входят в ежедневный offsite allowlist**: облачный backup магазина не образ ОС.
Не распаковывать старую package database поверх обновлённой системы.

13 новых guard tests прошли на Linux и Windows. Полный runtime suite на VPS —
36 passed; на Windows — 35 passed, один Linux-only test nginx пропущен.
После обновления также повторно прошли изолированные nginx/IPv4/IPv6/TLS/reload
тесты с новым iproute2. Существующий CI glob подхватывает новые тесты;
GitHub Actions run без push не запускался.

## Что осталось и почему reboot ещё впереди

Отложены ровно пять Ubuntu updates:

- `linux-firmware`: новая упаковка тянет 18 дополнительных firmware packages;
  не добавлялась большим неявным dependency set в текущую операцию.
- `console-setup`, `console-setup-linux`, `keyboard-configuration`: postinst
  вызывает update-initramfs при наличии этого executable. Изменения отложены
  в boot maintenance window; позже уточнён фактический dracut trigger данного
  образа — см. [завершение maintenance](BOOT-MAINTENANCE.md).
- `apparmor`: service сейчас disabled/inactive, в ядре только прежний профиль
  `named`, без confined processes. Новый postinst напрямую вызывает profile
  reload и может загрузить ранее неактивные политики в обход service policy.
  Обновление/активацию разбирать отдельно, не обходить reload защитными хаками.

На диске уже **до этого этапа** было ядро `6.8.0-147-generic`, но работает
`6.8.0-142-generic`. Образы/GRUB не менялись. Read-only `needrestart -b -r l`
по-прежнему показывает необходимость restart ряда служб, в том числе PostgreSQL,
SSH, cron, resolved, journald и systemd-manager: установка новых библиотек **не
означает**, что уже работающие процессы их загрузили. Финальная активация
обновлений/ядра и проверка старта после reboot ещё не выполнены.

Предварительно проверены enabled boot units магазина/firewall/SSH/сети,
PostgreSQL `start.conf=auto`, `systemd-analyze verify`, `findmnt --verify`,
`grub-probe` и SSH config. GRUB default 0 указывает первым на 147, запасные 142/88
сохранены. ESP смонтирован; у этого образа EFI binaries находятся в `EFI/BOOT`,
не `EFI/ubuntu`. bootx64/shim, grubx64 и mmx64 побайтово совпали с установленными
signed packages; оба EFI grub.cfg указывают на существующий UUID root FS.
BootCurrent entry не содержит отдельного file-path node. Стандартная проверка
только `EFI/ubuntu/*.efi` дала бы ложный отказ: итоговая receipt учитывает реально
существующий fallback layout. Загрузчик/NVRAM не менялись, efibootmgr не устанавливался.
Это статическая проверка, не гарантия успешной загрузки VPS.

Владелец сообщил, что заказчик сможет быть на связи с консолью FirstVDS. До
следующего этапа согласовать конкретное окно и убедиться, что консоль реально
открывается. Потом по отдельному решению разобрать deferred packages, проверить
boot inputs/backup ещё раз, выполнить согласованную перезагрузку и проверить
свежие SSH-соединения, firewall, kernel, boot services, health/ботов/очередь.
Не удалять старые ядра до успешной проверки нового. Исправление directory-mtime
race backup/readiness из предыдущего этапа остаётся отдельной задачей.

## Приватные receipts и восстановление

`/root/karcher-ubuntu-updates-20261019` — root:root `0700`. Внутри selected/version
и artifact receipts, старые/новые `.deb`, etc/dpkg snapshot, controller, tests,
логи, observation и boot-readiness receipts. Там есть секреты — не публиковать.
Точная проверка принятого snapshot:

```sh
sudo python3 /root/karcher-ubuntu-updates-20261019/ubuntu_update.py verify
```

После нового deploy/reboot/package changes strict verify ожидаемо может отказать.
Это приёмка конкретной операции, а не постоянный монитор. Прежний nginx package
snapshot тоже теперь увидит новые Ubuntu versions: не переписывать его state
ради зелёного результата. Облачные HTTP/heartbeat monitors продолжают работать.

Автоматического массового downgrade системных библиотек **нет**: это не атомарный
откат и он может требовать перезапуска служб. При сбое сначала изучить private
transaction log и состояние dpkg; затем согласовать точечное восстановление
с локальными пакетами/конфигами. Данные приложения и БД назад не откатывать.
Для снятия только оставшейся собственной transient policy/возврата APT timers:

```sh
sudo python3 /root/karcher-ubuntu-updates-20261019/ubuntu_update.py cleanup
```
