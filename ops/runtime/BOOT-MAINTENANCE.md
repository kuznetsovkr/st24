# Завершение обновлений и проверенная перезагрузка — 19 октября 2026

После [первых 30 обновлений](UBUNTU-UPDATES.md) владелец согласовал продолжение
с заказчиком на связи. Заказчик подтвердил, что веб-консоль нужного VPS FirstVDS
открыта и работает. Время ниже — **Красноярск (UTC+07)**.

## Обновления и резерв восстановления

В 17:30 установлены пять отложенных обновлений Ubuntu:

- AppArmor `4.0.1really4.0.1-0ubuntu0.24.04.9`;
- console-setup, console-setup-linux, keyboard-configuration `1.226ubuntu1.1`;
- linux-firmware `20240318.git3b128b60.0ubuntu3.1` и 18 firmware packages новой
  упаковки. [Разделение firmware описано Ubuntu](https://discourse.ubuntu.com/t/linux-firmware-split-in-noble-and-resolute/87528/).

Новых загрузок около 627,6 MiB; симуляция разрешила ровно 5 upgrades + 18 new
installs без removals/purge и без ISPmanager/Node/nginx/SSH/БД upgrades.
Существующие Ubuntu sources/keyring не менялись; целевой signed index update
сохранил прочие APT lists. Все новые `.deb` проверены по SHA-256 подписанного
индекса. Сохранены старые пять пакетов, проверены 4314 обычных payload-файлов,
их режимы и symlinks. Пакеты панели, persistent hold nginx wrapper и данные
магазина не удалялись; `autoremove` не выполнялся.

До установки создан и проверен offsite backup **`2026-10-19_10-20-32_UTC`**.
В root-only staging сохранён отдельный `boot-etc-dpkg-before.tar.gz` (~248,5 MiB):
полный `/boot`, `/etc`, package database; checksum и читаемость архива проверены.
Новые профили AppArmor собраны в shadow tree с сохранением custom conffiles;
`apparmor_parser -Q -K` проверил компиляцию **без загрузки в ядро**.
[Семантика -Q](https://manpages.ubuntu.com/manpages/noble/man8/apparmor_parser.8.html).

Операция выполнялась отдельным systemd unit, не зависела от SSH-сессии. Временная
policy запрещала service actions, APT timers на время установки остановлены.
APT получил точные version selectors и private cache с проверенными `.deb`,
`--no-download --no-remove --no-install-recommends --force-confold`; install
по absolute `.deb` paths не использовался. `NEEDRESTART_SUSPEND=1` исключил APT
auto-restarts. Cleanup продублирован в `finally`/`ExecStopPost`, foreign policy
не удаляется. После завершения policy снята, исходные APT timer states возвращены.

## Dracut и запасные загрузочные образы

Образ этого VPS использует **dracut 060+5-1ubuntu3.4**, не initramfs-tools.
Исполняемых `update-initramfs`/`lsinitramfs` нет; штатные инструменты — dracut
и lsinitrd. Поэтому прежнее предположение о безусловном запуске update-initramfs
из console postinst было неточным: там вызов условный и здесь пропускается.

При этом пакет **dracut зарегистрирован для dpkg trigger `update-initramfs`**.
Firmware update запустил этот trigger и пересобрал initrds **всех трёх ядер**
(142/147/88). Первичный строгий guard остановил приёмку из-за изменённого
защищённого fallback 142, хотя пакетная транзакция уже успешно завершилась.
Cleanup отработал; магазин/SSH/БД не перезапускались, readiness оставалась `ok`.

Без повторной установки пакетов проверены точный installed inventory,
`dpkg --audit` и зависимости. Автоматически созданные initrds сохранены отдельно.
Из проверенного snapshot восстановлены **только три initrd images**, с проверкой
происхождения изменений в transaction log и concurrent-change fencing.
Исходные config/PID guards не ослаблялись, их baseline не переписывался.
Функция `recover-packages` возобновила именно завершённую транзакцию, не reinstall.
Исходная запись ошибки в журнале сохранена, failed state сброшен после проверки.

Для ядра **6.8.0-147-generic** затем отдельно собран private candidate штатным
[dracut](https://manpages.ubuntu.com/manpages/noble/man8/dracut.8.html), без новых
hostonly/custom options. lsinitrd проверил читаемость, целевую версию и init.
Virtio, virtio_pci, virtio_blk, virtio_net, ext4 у этого kernel — builtin;
отсутствие отдельных `.ko` в initrd не трактовалось как поломка. Проверен GRUB
script, candidate установлен атомарно с исходными root/mode.

В 17:35 образ 147 готов. Исходные fallback **142/88 сохранены**, kernel images,
GRUB config, EFI binaries/NVRAM не менялись. Default GRUB 0 уже указывал на 147,
раньше установленное обычными kernel updates. Новое ядро в этом шаге не скачивалось.
Pre-reboot offsite backup **`2026-10-19_10-36-49_UTC`** проверен уже после подготовки
boot image. Private boot/package snapshots не входят в ежедневный offsite
allowlist: облачный backup магазина по-прежнему не является образом ОС.

### AppArmor — пакет обновлён, новая постоянная политика не включалась

До операции AppArmor service был disabled/inactive, в ядре оставался профиль
named без confined processes. Штатный postinst загрузил 105 профилей, confined
processes не появились. Настройка **disabled** сохранена: после reboot профилей
нет ([aa-status exit 2](https://manpages.ubuntu.com/manpages/noble/man8/aa-status.8.html)
при включённом kernel subsystem без загруженных profiles).
Это не поломка запуска и не новая защита всех процессов: постоянная активация/
настройка AppArmor — отдельное решение. Службу не включали и security restrictions
ради установки не обходили. Systemd hardening API/firewall/SSH сохранён.

## Перезагрузка и фактические проверки

В **17:37:32** после проверки boot image, fresh offsite backup и здоровья всех
трёх ботов выполнен согласованный `shutdown -r +1`. Старый boot ID зафиксирован.
Никаких forced reboot/power-cycle и изменений host-key trust не было.

Новый boot начался **17:38:43**, kernel **6.8.0-147-generic**, boot ID изменился.
Внешний наблюдатель с ПК проверял свежие SSH-соединения, сайт и readiness:
после краткой недоступности SSH/сайт вернулись, readiness сначала 502 при запуске
API, затем дважды 200. Перерыв API ориентировочно **20–30 секунд**, оценка по
периодическим пробам, а не точный SLA-замер. Готовность подтверждена до 17:39:10.

Проверено после reboot:

- system state `running`, failed units и error journal текущей загрузки — 0;
- nginx PID `742`, API `801`, SSH `746`, PostgreSQL `770`, Redis `737` стартовали
  автоматически, `NRestarts=0`; Node процесса API — 24.22.0, его UID — 999;
- API public/loopback readiness относятся к одному **новому** instance, worker и
  три polling-бота `ok`, pending/retry/dead и business invariants — 0;
- реальная nftables input chain имеет drop policy, firewall unit активен;
  публично слушаются только 22/80/443, DB/Redis/API/DNS остаются loopback;
- PHP hook по-прежнему 0644, root cron не изменился, panel core не поднялся,
  старые service masks и все protected config/SSH key hashes сохранены;
- сайт HTML UTF-8, API JSON/no-store, JS/CSS совпали с диском;
  unknown/missing SNI отклоняется, default denial сохранён;
- `dpkg --audit`, APT dependency check, nginx/sshd config checks успешны;
  `needrestart -b -r l`: expected/current kernel совпадают, stale services **нет**;
  reboot-required marker отсутствует;
- все доступные Ubuntu updates применены; 38 candidates других origins, включая
  ненужные пакеты ISPmanager, намеренно не устанавливались;
- 51 runtime guard tests прошли на VPS; на Windows — 50 passed, один Linux-only
  test пропущен. Isolated nginx HTTP/TLS/default-denial/reload test снова успешен.

Контрольный backup **`2026-10-19_10-42-27_UTC`** после reboot зашифрован, загружен
и проверен полным downloaded-content comparison. Новый restore БД/расшифровка на
ПК не выполнялись. Backup health и Certbot timers активны; новый Certbot dry-run
не запускался (последний успешный — этап миграции nginx, сертификат не заменён).
Пять health-раундов за две минуты успешны; в **17:47** результат принят и сохранён
в private receipt, консоль больше не требовалась. GitHub CI/push этим этапом
не запускались.

## Snapshot, helper и последующие работы

Root-only `/root/karcher-ubuntu-boot-maintenance-20261019` (`0700`): manifest и
signed-index/artifact receipts, 5 старых/23 новых `.deb`, boot/etc/dpkg snapshot,
automatic/original/candidate initrds, compiler logs, controller/tests, observation
и acceptance. Там секреты: не коммитить, не отправлять в чат и не выгружать без
шифрования. Source — [boot_maintenance.py](boot_maintenance.py).

Проверка принятой операции:

```sh
sudo python3 /root/karcher-ubuntu-boot-maintenance-20261019/boot_maintenance.py verify
```

После новых package/config changes strict verify может отказать: это receipt
конкретной операции, не замена мониторингу. Старые snapshots Node/nginx/Ubuntu
30 теперь ожидаемо не совпадут по PID/пакетам/boot image; не переписывать их
ради зелёного результата. Нет автоматического downgrade системных библиотек/
firmware. Для восстановления требуется разбор состояния, сохранённые recovery
inputs и при необходимости консоль; не распаковывать старую dpkg database поверх
новой и не откатывать заказы/БД назад.

Отдельно остались backup/readiness directory-mtime race, расширение offsite
recovery coverage и решение о постоянной политике AppArmor. Удаление пакетов/
данных панели и старых ядер в эту операцию не входило.
