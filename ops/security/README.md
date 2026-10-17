# SSH и входящий firewall VPS

Эти файлы — версия конфигурации, установленной 17 октября 2026 на существующем
VPS магазина. Они **не применяются автоматически** при деплое приложения.
Хронология, согласование работы без веб-консоли и результат проверок — в
[отчёте](../../docs/production-hardening.md).

## Файлы на сервере

| Источник | Установленное назначение |
| --- | --- |
| `00-karcher-access.conf` | `/etc/ssh/sshd_config.d/00-karcher-access.conf`, root:root `0644` |
| `inbound.nft` | `/etc/karcher-security/inbound.nft`, root:root `0644` |
| `load-firewall.sh` | `/usr/local/lib/karcher-security/load-firewall.sh`, root:root `0700` |
| `karcher-firewall.service` | `/etc/systemd/system/karcher-firewall.service`, root:root `0644` |

SSH принимает только publickey, включая root. Действующие ключи не заменяются,
порт остаётся 22. Для пользователя рабочего ПК настроен `ssh karcher-firstvds`;
парольный вход через SSH больше не работает. Это не меняет пароль root для
локальной/VNC-консоли и не является отказом от административного root-доступа.

Firewall использует **собственную** таблицу `inet karcher_ingress`, input hook
priority `-10`. Разрешены loopback, established/related, ICMP/ICMPv6 и новые
TCP-соединения на 22, 80 и 443; прочие входящие соединения отбрасываются.
Исходящие соединения и forwarding эта таблица не изменяет. На текущем VPS
не обнаружены DHCP-настройки и глобальный IPv6; перед переносом на DHCP-хост
нужно отдельно адаптировать разрешения для получения/продления адреса.

Таблица обрабатывается до существующих iptables-nft filter chains. Последующий
`accept` ISPmanager не отменяет её `drop`, а последующие запреты/баны
ISPmanager и Fail2ban продолжают действовать. Чужие таблицы не очищаются.
UFW оставлен неактивным, его прежние конфиги сохранены.

Обычный `nftables.service` **masked / inactive**: его стандартный ruleset
может содержать глобальный `flush ruleset`, поэтому он не используется вместе
с этой схемой. За автозапуск отвечает только `karcher-firewall.service`.
Не включать параллельно UFW или стандартный nftables unit без нового аудита.

## Проверки и изменения

На Linux с установленным nftables:

```sh
shellcheck ops/security/load-firewall.sh
sudo python3 ops/security/test-firewall.py
systemd-analyze verify ops/security/karcher-firewall.service
```

Для последней команды loader должен уже существовать по установленному пути.
Тест создаёт новый network namespace и отказывается работать в namespace PID 1.
Он проверяет синтаксис, default deny, точный список портов, приоритет,
атомарную перезагрузку без дублей, сохранение чужой таблицы и удаление только
своей. Живую сеть VPS тест не меняет. Отдельный CI-шаг повторяет эти проверки;
`npm run test:ops` сам по себе покрывает старый пакет `ops/systemd`, не этот unit.

После согласованного изменения файла правил и подготовки независимого таймера
отката выполнить `systemctl reload karcher-firewall.service`. Loader сначала
проверяет batch и затем атомарно заменяет только свою таблицу; при ошибке
синтаксиса действующие правила остаются. Сразу проверить **новое**, а не
мультиплексированное SSH-подключение и публичные HTTP/HTTPS/readiness.
Не перезапускать VPS ради такой проверки без резервного доступа.

Текущее состояние:

```sh
systemctl status karcher-firewall.service
systemctl is-enabled karcher-firewall.service
sudo nft list table inet karcher_ingress
sudo sshd -t
sudo sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication|authenticationmethods) '
```

`systemctl stop` намеренно **не снимает** firewall: отсутствует `ExecStop`,
чтобы случайная остановка unit не открывала все старые службы.
Аварийное снятие защиты требует двух явных действий:

```sh
sudo systemctl disable --now karcher-firewall.service
sudo nft delete table inet karcher_ingress
```

Это снова откроет доступ к слушающим FTP/почте/панели, если они не отключены.
Остальные таблицы останутся нетронутыми. Никогда не использовать для такого
отката глобальные `nft flush ruleset`, `iptables -F` или `ufw reset`.

Новые файлы безопасности **добавлены** в allowlist ежедневного архива
`ops/backup/karcher-backup.sh`. Marker `/etc/karcher-backup/security-required`
требует полного набора и корректных системных ссылок; отсутствие обязательного
файла больше не может дать ложный успешный backup. Облачный набор
`2026-10-17_14-06-57_UTC` скачан, локально расшифрован и сверен с VPS без записи
открытого dump на диск. Состав и ограничения восстановления описаны в
[backup/README.md](../backup/README.md#настройки-ssh-и-firewall).
Приватные SSH-ключи/ключ age в этот каталог или Git не помещать.

Основание схемы: [семантика nftables](https://netfilter.org/projects/nftables/manpage.html),
[Ubuntu OpenSSH](https://ubuntu.com/server/docs/how-to/security/openssh-server/).
