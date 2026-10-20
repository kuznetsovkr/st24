# Перенос старой истории в зашифрованный архив

Утилита выполняет отдельную **разовую операцию копирования**, не изменение
ежедневного бэкапа. Она не удаляет и не перезаписывает старые plaintext-копии.
Их последующее удаление требует отдельного согласования владельца; фактически
выполненная на текущем VPS операция зафиксирована в конце этого документа.

## Пути и совместимость

- Источники при копировании: `/var/backups/st24/<исходное-имя>` и
  `yadisk:st24-backups/<исходное-имя>`; 23 согласованных оригинальных набора
  впоследствии удалены, это не актуальные пути для восстановления истории.
- Новые экспорты: `/var/backups/karcher-legacy-encrypted/<исходное-имя>` и
  `yadisk:karcher-backups-encrypted/legacy-v1/<исходное-имя>`.
- Root-only отчёты: `/var/lib/karcher-legacy-migration`, `700`, файлы `600`:
  `plan.json`, `verified.json`, `last-run.json`, `rclone.log`, `pc-verified.json`,
  отдельный итог последующего удаления — `originals-retired.json`.
- Публичный recipient: существующий `/etc/karcher-backup/recipients.txt`.
  Секретный identity остаётся на доверенном ПК и в менеджере паролей, не на VPS.

Все исходные имена сохраняются. Старые имена без `_UTC` не переинтерпретируются
и не получают придуманную временную зону. `MANIFEST.json.createdAt` — настоящее
время шифрования, не дата исходного dump. Поэтому архив находится отдельно от
`v1` и **не участвует** в ежедневной retention-политике. Пока хранится бессрочно;
другая политика для legacy потребует отдельного решения.

Age-формат `karcher-age-v1` и три внешних файла те же:
`backup.tar.age`, `MANIFEST.json`, `SHA256SUMS.txt`. В manifest добавлен
`legacySource`: исходное имя/remote, SHA-256 и размеры трёх plaintext-компонентов.
Открытых dump/архивов в этом metadata нет. Обычный `encrypted_backup.py open`
совместим с экспортом; порядок восстановления — [ENCRYPTION.md](ENCRYPTION.md).
Старые копии не содержат новые hardening/recovery-настройки — перенос их не добавляет.

## Предохранители

1. Режим по умолчанию `plan`: только чтение копий и закрытый отчёт. Источник
   определяется составом старого cloud namespace; максимум 100 наборов.
2. Разрешены только валидные исходные имена и три фиксированных обычных файла.
   Root storage без symlink, права `700/600`, single-link файлы; SHA-256 и metadata
   проверяются до/после чтения. Лишние/неполные наборы и изменения — ошибка.
3. Каждый исходный cloud set **скачивается заново** в private temp и сверяется
   по SHA-256 с локальным. Записи plan привязаны к listing и локальным signatures.
   Узкое исключение при HTTP-сбое только `SHA256SUMS.txt`: оба payload обязаны
   действительно скачаться и совпасть по SHA-256 с проверенным local checksum;
   сам локальный checksum обязан совпасть с cloud size/MD5. Это отдельное
   предупреждение `payloads-downloaded-checksum-local`/`sourceChecksumReadWarnings`,
   **не** успешное скачивание всех трёх cloud-файлов и не исправление старого объекта.
   Сбой чтения payload, несовпадение данных или отсутствие MD5 блокируют перенос.
4. `migrate` использует проверенный plan, заново сверяет source inventory и
   recipient, затем источники до/после каждого набора и в конце. Общий
   `/var/lock/st24-backup.lock` исключает параллельный backup/retention; busy —
   exit 75 без подмены статуса другого worker.
   Lock открывается только для чтения: Linux exclusive flock не требует записи,
   поэтому источники и `/run/lock` могут оставаться read-only в sandbox.
5. До записи проверяется запас места: conservative `2 × sourceBytes` плюс
   5 GiB локально / 512 MiB в облаке. Новые локальные exports публикуются
   переименованием; незавершённый собственный `.partial-*` сохраняется для разбора.
6. Единственная запись в облако — encrypted root → **legacy-v1**, через
   [`rclone copy --immutable --checksum`](https://rclone.org/docs/#immutable).
   Нет команд sync/move/delete/purge/cleanup. Совпадающие exports не шифруются
   повторно. Частичная выгрузка продолжается только после проверки всех уже
   существующих файлов; конфликт не перезаписывается.
7. Новый export скачивается целиком и сверяется по SHA-256, manifest/provenance,
   recipient и source signatures. HTTP-сбои чтения имеют ограниченные повторы;
   сохраняющийся сбой — failure, не доказательство пригодности копии.
8. `verified.json` подтверждает скачанные bytes, **не расшифровку**: на VPS нет
   identity. В `last-run.json` это отдельно обозначено `decryptionVerified=false`.
   При ошибке originals сохранены. Никаких успешных stamps ежедневного backup
   или внешних green heartbeat этот worker не подделывает.

## Запуск оператором

Нужны Linux, Python 3.11+, age/rclone и модули `encrypted_backup.py`, `retention.py`.
Новые инструменты устанавливаются в `/usr/local/lib/karcher-backup` как root:root
`600`; это не команда деплоя магазина, изменения cron или включения timer.
Сначала тесты, затем последовательные команды (долгие операции — через
`systemd-run`, с закрытыми логами и наблюдением статуса):

```sh
python3 -B -m unittest discover -s ops/backup -p 'test_*.py'
sudo python3 -B /usr/local/lib/karcher-backup/legacy_migration.py plan
# Проверить точный список, объём и доступное место. Только после согласования копирования:
sudo python3 -B /usr/local/lib/karcher-backup/legacy_migration.py migrate
```

Не повторять `plan` поверх прежнего без понимания, что изменилось. При partial
failure сначала изучить закрытые логи/отчёты, не удалять ни originals, ни конфликтующие
объекты. Повтор `migrate` не означает игнорирование ошибок или восстановление объекта
на месте. Перезапись даже теми же байтами при постоянном HTTP 500 — отдельное решение.

## Проверка ключом на Windows без открытых файлов

После cloud verification перенести **только зашифрованные exports** в закрытый
каталог вне проекта под `~/.config/karcher-backup`. Сверить все три файла каждого
набора с cloud-verified hashes из отчёта, проверить NTFS ACL. Затем:

```powershell
$Private = Join-Path $env:USERPROFILE '.config\karcher-backup'
$Age = Join-Path $env:LOCALAPPDATA 'karcher-backup-tools\age-v1.3.2\age\age.exe'
python ops/backup/verify_legacy_stream.py `
  --root (Join-Path $Private 'legacy-check-YYYYMMDD\exports') `
  --identity (Join-Path $Private 'identity.txt') --age $Age --expected-count 23
if ($LASTEXITCODE -ne 0) { throw 'Проверка legacy не пройдена' }
```

Утилита ничего не извлекает и не пишет. Поток age → tar → SHA-256 проверяет
строго три обычных компонента, их размеры, исходные hash/provenance и внутренний
checksum. После tar EOF поток дочитывается до конца, проверяется exit age
(аутентификация последнего блока обязательна). Логи не содержат plaintext.

Это проверка расшифровки и побайтного совпадения, **не** restore всех старых БД,
не доказательство происхождения архива (age — не подпись) и не clean-VPS drill.
После приёмки можно отдельно согласовать удаление точного списка originals;
корзина аккаунта и остальные копии остаются вне этого этапа.

## Приёмка отдельного удаления оригиналов — 20 октября 2026

После явного разрешения владельца в **11:51:17 по Красноярску** удалены ровно
**23 согласованных plaintext-набора** за 27 сентября — 17 октября:
по 69 файлов / 345 563 784 байта на VPS и Яндекс.Диске. Перед этим все 23
encrypted exports заново скачаны из облака и сверены по SHA-256; на ПК повторно
проверены age authentication, внутренние SHA-256 и размеры без записи plaintext.
Ключ не передавался на VPS.

Это отдельная закрытая операторская операция, **не** новый режим `legacy_migration.py`
и не часть ежедневной retention. Точный список, хэши неизменных migration/PC proofs,
согласование, свежая read-only preflight-проверка и пооперационный журнал хранятся
в `/root/karcher-legacy-retire-20261020` (`700/600`). После десяти synthetic guard
tests разовый worker работал под общим backup flock, с root-only журналом,
`ProtectSystem=strict`, без capabilities и с read-only encrypted roots.

Каждый cloud-файл удалялся отдельно через
[`rclone deletefile`](https://rclone.org/commands/rclone_deletefile/)
с [`--yandex-hard-delete=true`](https://rclone.org/yandex/#yandex-hard-delete).
Только после проверки пустоты удалялась точная директория через
[`rclone rmdir`](https://rclone.org/commands/rclone_rmdir/).
Локально разрешались только три известных обычных single-link файла с прежними
SHA-256/signatures, затем пустая директория; symlink/лишние файлы/другие имена
блокировали действие. Рекурсивного purge, sync и очистки общей корзины не было.
Это удаление файлов, а не подтверждённое физическое стирание носителя провайдера.

Все 23 encrypted набора сохранены на VPS, в `legacy-v1` и на ПК. Остальные
31 modern local pair, 25 modern cloud sets, закреплённые точки и старый partial
не изменены. Современные локальные plaintext-копии остаются под root-only
доступом и собственной retention-политикой. Прежний `yadisk:st24-backups` пуст;
сам родительский каталог оставлен, общая корзина Disk не затронута.

Успешный итог — `/var/lib/karcher-legacy-migration/originals-retired.json`,
независимая итоговая проверка — `/root/karcher-legacy-retire-20261020/accepted.json`.
Исторические `plan.json`, `verified.json`, `pc-verified.json` и worker
`last-run.json` не переписываются. `originalsDeleted=false` в старом worker state
относится только к этапу копирования; последующее удаление имеет отдельный receipt.
Не повторять `plan`/`migrate` поверх этой завершённой истории: прежних источников
уже нет. Для восстановления использовать сохранённые encrypted exports и
[ENCRYPTION.md](ENCRYPTION.md), а для повторной потоковой проверки —
`verify_legacy_stream.py` на доверенном ПК.
