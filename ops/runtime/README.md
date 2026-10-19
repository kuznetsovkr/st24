# Обновление runtime существующего VPS

Host-specific операции для `/var/www/st24`, не универсальный installer и не
часть `deploy.sh`. Секреты, .deb, receipts и служебные логи в Git не помещать.

## Node.js — применено 19 октября 2026

Около 11:34 по Красноярску production переведён с Node.js **20.20.0** на
**24.22.0 LTS**, Debian package `24.22.0-1nodesource1`. Изменён только пакет
`nodejs`; приложение осталось на `4a2d790`, исходники/сборки/секреты и unit не
заменялись. Выполнен один управляемый restart `karcher-api`, новый PID `365791`.
PID nginx `151593`, SSH `290283`, PostgreSQL `289404`, Redis `289356` сохранены.

Node.js 20 уже EOL; ветка 24 — LTS по [графику Node.js](https://nodejs.org/en/about/previous-releases).
Проект допускает 22.13+ и 24.x, но production рекомендуется актуальный патч 24.x.
Prerelease/нерассмотренные major-ветки отклоняются. CI закреплён на 24.22.0;
новая политика исходников попадёт на VPS при следующем обычном деплое приложения,
а не подменялась отдельно в production checkout.

### Подготовка

- Существующий публичный ключ `/usr/share/keyrings/nodesource.gpg`, primary
  fingerprint `6F71F525282841EEDAF851B42F59B5F99B1BE0B4`, проверил новый подписанный
  NodeSource InRelease/Packages через APT. SHA-256 Node 24 `.deb` совпал с индексом.
  Использован [репозиторий NodeSource](https://github.com/nodesource/distributions);
  удалённый `setup_24.x` не исполнялся.
- Репозиторий сначала обновлён **только в отдельный root-only APT lists/cache**.
  Симуляция допускает один upgrade `nodejs`, без других установок/удалений.
- Старый `.deb` сохранён для отката: все 4323 payload-файла совпали с установленным
  `nodejs.md5sums`. Новая версия предварительно извлечена отдельно от `/usr/bin/node`.
- Под точной Node 24.22 в изолированном исходном дереве без production `.env`
  выполнены `npm ci`, unit tests/сборки, lint, browser types, deploy shell tests,
  backup/security tests. На ПК с Node 24.21 дополнительно прошли 24 изолированные
  browser tests. Реальные заказы/платежи/OTP/тестовые сообщения не создавались.
- Pre-upgrade backup `2026-10-19_04-31-42_UTC` проверен в облаке до переключения.
  Снимок сохраняет SHA-256 конфигов/сборок и PID защищённых служб.

### Действующая конфигурация

| Источник | Путь на VPS |
| --- | --- |
| `nodesource24.sources` | `/etc/apt/sources.list.d/karcher-nodesource.sources`, root:root `0644` |
| `karcher-nodejs.pref` | `/etc/apt/preferences.d/karcher-nodejs`, root:root `0644` |

Подключена только ветка `node_24.x` для amd64, `Signed-By` указывает на существующий
публичный ключ. Pin действует только для `nodejs`. Глобальные индексы обновлены
целевым запросом NodeSource с `APT::Get::List-Cleanup=0`, без удаления списков
Ubuntu/ISPmanager. Installed/candidate — `24.22.0-1nodesource1` из NodeSource.
Политика unattended-upgrades **не менялась**: добавление репозитория само по себе
не включает автоматические обновления Node.

Первая попытка `apt-get --no-download install /absolute/package.deb` остановилась
до изменения пакета: APT 2.7 сообщил `Pathname to install is not absolute`.
Подготовительные repo-файлы откачены, API остался со старым PID. Неудачный state
и self-test сохранены отдельно. Повторная установка использовала `dpkg --install`
строго одного уже проверенного `.deb`; зависимости перед ней повторно проверены
симуляцией APT. Ничего дополнительно не скачивалось и пакеты не удалялись.

### Приёмка и откат

Независимый systemd timer до изменения исполнил настоящий rollback handler на
исходном состоянии. На переключение поставлен 15-минутный откат. Фактический
`/proc/365791/exe --version` после restart подтвердил Node 24.22.0. Публичная и
loopback readiness относятся к одному свежему instance, worker и три polling-бота
здоровы, pending/retry/dead и нарушения инвариантов — 0. Пять раундов за 120 секунд
успешны; около 11:38 результат принят и rollback timer остановлен.

Post-upgrade backup **`2026-10-19_04-36-03_UTC`** завершён 11:36 по Красноярску:
age encryption, upload и downloaded-content comparison успешны. Это также
проверяет Node-based backup helpers под новым runtime. Отдельный restore БД или
расшифровка на ПК не выполнялись. `nginx -t`, `dpkg --audit` успешны, failed units
и самопроизвольные API restarts отсутствуют. VPS не перезагружался.

Controller, пакеты, receipts и логи — `/root/karcher-node24-20261019` (`0700`),
source — [node_upgrade.py](node_upgrade.py). **Снимок, APT configs и .deb не добавлены
в ежедневный offsite allowlist**. При восстановлении нового VPS сначала повторно
установить проверенный Node 24 и настроить репозиторий по шаблону; backup магазина
не является образом ОС.

Проверка именно принятого снимка:

```sh
sudo python3 /root/karcher-node24-20261019/node_upgrade.py verify
```

После нового деплоя/смены других PID строгая проверка может отвергнуть снимок —
это приёмка конкретного переключения, не постоянный монитор. Старый
`panel_autostart.py verify` теперь ожидаемо видит иной API PID: не переписывать
исторический снимок ради зелёного результата. Hook/statoverride и отсутствие
panel jobs/core проверяются отдельно.

Аварийный откат **только runtime**, пока не менялись исходники/конфиги:

```sh
sudo python3 /root/karcher-node24-20261019/node_upgrade.py revert
```

Удаляются только свои неизменённые repo/pin-файлы, старый `.deb` устанавливается
без сети, затем перезапускается API. Чужой runtime/изменённые конфиги требуют
ручного разбора. Node 20 — только временный аварийный откат, не целевой runtime.

Тесты без изменения системы:

```sh
python3 -B -m unittest discover -s ops/runtime -p 'test_*.py'
```

Все десять тестов прошли на VPS и ПК; шаг добавлен в CI, но новый GitHub run
этим этапом не запускался. Lint без ошибок, с восемью существующими warnings
в клиентском коде, не относящимися к runtime.

## nginx — только подготовка, production не менялся

На VPS остаётся `1:1.28.2-142-ubuntu24` из ISPmanager. В private APT namespace
`/root/karcher-nginx-upgrade-plan-20261019` проверены ключ и подписанный индекс
[nginx.org](https://nginx.org/en/linux_packages.html), доступен `1.30.6-1~noble`.
`nginx-plan.sources` — **только шаблон этого staging**, не production APT config.

Переход требует убрать `nginx-common`, `nginx-core` и шесть модулей старого ABI:
HTTP GeoIP, image filter, XSLT, mail, stream, stream GeoIP. Их директивы в активной
конфигурации не используются, но `.so` загружены; просто заменить бинарник нельзя.
`ispmanager-pkg-nginx` симуляция не удаляет. APT называет это downgrade из-за
epoch `1:` старого пакета, хотя версия nginx растёт с 1.28.2 до 1.30.6.

Переход требует отдельного подтверждения пакетных замен, артефактов отката **всех**
затронутых пакетов и проверки maintainer scripts. Нужно предотвратить автозапуск
с дефолтным сайтом nginx.org/другим пользователем, сохранить shop vhost, платёжный
secret gate, UTF-8, ACME и default denial и адаптировать include модулей. Пока
nginx repository, пакеты, конфигурация и процесс production не менялись.
Обновления остальных пакетов ОС и reboot также не выполнялись.
