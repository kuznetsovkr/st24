#!/usr/bin/env python3
"""Conservative retention for the fixed Karcher age-v1 namespace, root only.

Default command is read-only planning. Applying requires an enabled root-private
policy, a fresh verified backup, the shared backup lock, and full validation of
all cloud exports. Legacy/plaintext-only, partial and unknown entries are never
deleted. Cloud removals explicitly go to Yandex trash, never account-wide cleanup.
"""
import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

from encrypted_backup import (COMPONENTS, ENCRYPTED_FILES, FORMAT, CONTENTS,
                              CryptoError, verify_checksums, recipient_id)

PLAIN = Path('/var/backups/st24')
ENCRYPTED = Path('/var/backups/karcher-encrypted')
REMOTE = 'yadisk:karcher-backups-encrypted/v1'
CONFIG = Path('/etc/karcher-backup/retention.json')
STATE = Path('/var/lib/karcher-retention')
RECIPIENTS = Path('/etc/karcher-backup/recipients.txt')
SET = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC')
EXPORT_FILES = ENCRYPTED_FILES | {'SHA256SUMS.txt'}
PLAIN_FILES = COMPONENTS | {'SHA256SUMS.txt'}
DEFAULT = {'version': 1, 'enabled': False, 'localDays': 7, 'allHours': 48,
           'dailyDays': 30, 'weeklyWeeks': 12, 'monthlyMonths': 12,
           'pinned': ['2026-10-17_04-57-48_UTC', '2026-10-17_14-06-57_UTC',
                      '2026-10-19_11-17-59_UTC']}
ZONE = ZoneInfo('Asia/Krasnoyarsk')


class RetentionError(Exception):
    pass


def moment(name):
    if not isinstance(name, str) or not SET.fullmatch(name):
        raise RetentionError('INVALID_SET_NAME')
    try:
        return datetime.strptime(name, '%Y-%m-%d_%H-%M-%S_UTC').replace(tzinfo=timezone.utc)
    except ValueError:
        raise RetentionError('INVALID_SET_DATE') from None


def policy(value):
    if (not isinstance(value, dict) or set(value) != set(DEFAULT)
            or type(value['version']) is not int or value['version'] != 1
            or type(value['enabled']) is not bool):
        raise RetentionError('POLICY_INVALID')
    for name in ['localDays', 'allHours', 'dailyDays', 'weeklyWeeks', 'monthlyMonths']:
        if type(value[name]) is not int or not 1 <= value[name] <= 366:
            raise RetentionError('POLICY_INVALID')
    if not isinstance(value['pinned'], list) or not 1 <= len(value['pinned']) <= 100:
        raise RetentionError('PINS_INVALID')
    for name in value['pinned']:
        moment(name)
    if len(set(value['pinned'])) != len(value['pinned']):
        raise RetentionError('PINS_INVALID')
    return value


def choose(names, settings, now, latest):
    names = sorted(set(names))
    if latest not in names or not set(settings['pinned']) <= set(names) or len(names) < 3:
        raise RetentionError('PROTECTED_BACKUPS_MISSING')
    times = {name: moment(name) for name in names}
    if any(value > now + timedelta(seconds=120) for value in times.values()):
        raise RetentionError('BACKUP_FROM_FUTURE')
    protected = set(settings['pinned']) | set(names[-3:]) | {latest}
    local = protected | {name for name in names if times[name] >= now-timedelta(days=settings['localDays'])}
    cloud = protected | {name for name in names if times[name] >= now-timedelta(hours=settings['allHours'])}
    today = now.astimezone(ZONE).date()
    monday = today - timedelta(days=today.weekday())
    month = today.year * 12 + today.month - 1
    seen = {'day': set(), 'week': set(), 'month': set()}
    for name in reversed(names):
        day = times[name].astimezone(ZONE).date()
        week = day - timedelta(days=day.weekday())
        m = day.year * 12 + day.month - 1
        buckets = [('day', day, 0 <= (today-day).days < settings['dailyDays']),
                   ('week', week, 0 <= (monday-week).days < settings['weeklyWeeks']*7),
                   ('month', m, 0 <= month-m < settings['monthlyMonths'])]
        for label, bucket, active in buckets:
            if active and bucket not in seen[label]:
                cloud.add(name)
                seen[label].add(bucket)
    delete_cloud = set(names)-cloud
    # An unexpectedly drastic policy change needs operator review, not guessing.
    if len(delete_cloud) > 100 or len(delete_cloud)*2 > len(names):
        raise RetentionError('DELETE_SAFETY_LIMIT')
    return local, cloud


def protected(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (not expected(info.st_mode) or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
            or (not directory and info.st_nlink != 1)):
        raise RetentionError('UNSAFE_LOCAL_STORAGE')
    return info


def json_file(path):
    protected(path)
    if path.stat().st_size > 16384:
        raise RetentionError('JSON_TOO_LARGE')
    return json.loads(path.read_text())


def signature(path):
    info = protected(path, directory=path.is_dir() and not path.is_symlink())
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns]


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def local_set(root, name, encrypted):
    moment(name)
    directory = root/name
    protected(directory, directory=True)
    expected = EXPORT_FILES if encrypted else PLAIN_FILES
    if {p.name for p in directory.iterdir()} != expected:
        raise RetentionError('LOCAL_SET_CONTENTS_INVALID')
    values = {key: signature(directory/key) for key in sorted(expected)}
    verify_checksums(directory, ENCRYPTED_FILES if encrypted else COMPONENTS)
    hashes = {key: digest(directory/key) for key in expected}
    if any(signature(directory/key) != value for key, value in values.items()):
        raise RetentionError('LOCAL_CHANGED_DURING_VALIDATION')
    return {'signatures': values, 'bytes': sum((directory/key).stat().st_size for key in expected),
            'digests': hashes}


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.retention-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


class Cloud:
    def __init__(self, log):
        self.log = log

    def call(self, args):
        result = subprocess.run(['rclone', *args, '--retries', '2', '--low-level-retries', '2',
                                 '--contimeout', '15s', '--timeout', '60s'], capture_output=True, timeout=180)
        if self.log.exists() or self.log.is_symlink():
            protected(self.log)
        fd = os.open(self.log, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'ab') as stream:
            stream.write(('operation='+args[0]+' target='+args[1]+'\n').encode())
            stream.write(result.stderr)
        if result.returncode:
            raise RetentionError('CLOUD_OPERATION_FAILED')
        return result.stdout

    def names(self):
        rows = json.loads(self.call(['lsjson', REMOTE, '--max-depth', '1']))
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise RetentionError('CLOUD_LISTING_INVALID')
        names = set()
        ignored = []
        for row in rows:
            name = row['Name']
            if row['IsDir'] and SET.fullmatch(name):
                moment(name)
                if name in names:
                    raise RetentionError('DUPLICATE_CLOUD_NAME')
                names.add(name)
            else:
                ignored.append(name)
        return names, ignored

    def listing(self, name):
        moment(name)
        rows = json.loads(self.call(['lsjson', REMOTE+'/'+name, '--max-depth', '1', '--hash']))
        if (not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows)
                or len(rows) != 3 or {row['Name'] for row in rows} != EXPORT_FILES
                or any(row['IsDir'] or row['Path'] != row['Name'] or row['Size'] <= 0 for row in rows)):
            raise RetentionError('CLOUD_SET_CONTENTS_INVALID')
        return sorted([{'name': row['Name'], 'bytes': row['Size'], 'time': row['ModTime'],
                        'hashes': row.get('Hashes', {})} for row in rows], key=lambda row: row['name'])

    def verify(self, name, temporary, recipient):
        before = self.listing(name)
        for attempt in range(3):
            try:
                self.call(['copy', REMOTE+'/'+name, str(temporary), '--max-depth', '1'])
                break
            except RetentionError:
                if attempt == 2:
                    raise
                time.sleep(5)
        if {p.name for p in temporary.iterdir()} != EXPORT_FILES:
            raise RetentionError('DOWNLOADED_CONTENTS_INVALID')
        verify_checksums(temporary, ENCRYPTED_FILES)
        manifest = json.loads((temporary/'MANIFEST.json').read_text())
        if (not isinstance(manifest, dict) or manifest.get('format') != FORMAT or manifest.get('contents') != sorted(CONTENTS)
                or manifest.get('recipientSha256') != recipient):
            raise RetentionError('CLOUD_FORMAT_OR_RECIPIENT_INVALID')
        created = datetime.fromisoformat(manifest['createdAt'])
        if created.tzinfo is None or not 0 <= (created-moment(name)).total_seconds() <= 7200:
            raise RetentionError('EXPORT_TIMESTAMP_INVALID')
        if self.listing(name) != before:
            raise RetentionError('CLOUD_CHANGED_DURING_VALIDATION')
        hashes = {}
        for key in EXPORT_FILES:
            with (temporary/key).open('rb') as stream:
                hashes[key] = hashlib.file_digest(stream, 'sha256').hexdigest()
        return {'listing': before, 'digests': hashes, 'bytes': sum(row['bytes'] for row in before)}

    def remove(self, name, expected):
        moment(name)
        if self.listing(name) != expected:
            raise RetentionError('CLOUD_CHANGED_BEFORE_DELETE')
        # Never purge the namespace root, legacy path, or the account trash.
        # Explicit false overrides any inherited hard-delete config/environment.
        self.call(['purge', REMOTE+'/'+name, '--yandex-hard-delete=false'])


def fresh_checkpoint(now):
    success = json_file(PLAIN/'.last-success.json')
    latest = json_file(PLAIN/'.last-run.json')
    if (not isinstance(success, dict) or latest != success or success.get('status') != 'verified'
            or success.get('stage') != 'complete' or success.get('encryption') != 'age-x25519-v1'):
        raise RetentionError('LATEST_BACKUP_NOT_VERIFIED')
    checked = datetime.strptime(success['checkedAt'], '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    moment(success['backupSet'])
    if not -120 <= (now-checked).total_seconds() <= 26*3600:
        raise RetentionError('LATEST_BACKUP_STALE_OR_FUTURE')
    return success


def plan(settings, now, cloud, work):
    protected(PLAIN, directory=True); protected(ENCRYPTED, directory=True)
    if PLAIN.resolve() != PLAIN or ENCRYPTED.resolve() != ENCRYPTED:
        raise RetentionError('REDIRECTED_BACKUP_ROOT')
    checkpoint = fresh_checkpoint(now)
    remote, ignored_remote = cloud.names()
    local = {}
    ignored_local = []
    plain_names = {p.name for p in PLAIN.iterdir()}
    for p in sorted(ENCRYPTED.iterdir()):
        if not SET.fullmatch(p.name):
            ignored_local.append(p.name); continue
        if p.name not in plain_names:
            raise RetentionError('INCOMPLETE_LOCAL_PAIR')
        local[p.name] = {'plain': local_set(PLAIN, p.name, False),
                         'encrypted': local_set(ENCRYPTED, p.name, True)}
    ignored_local += sorted(plain_names-set(local))
    keep_local, keep_cloud = choose(set(local)|remote, settings, now, checkpoint['backupSet'])
    if not keep_cloud <= remote or checkpoint['backupSet'] not in local:
        raise RetentionError('UNMIRRORED_RECOVERY_POINT')
    verified = {}
    for name in sorted(remote):
        with tempfile.TemporaryDirectory(prefix='verify-', dir=work) as directory:
            verified[name] = cloud.verify(name, Path(directory), recipient_id(RECIPIENTS))
        if name in local and verified[name]['digests'] != local[name]['encrypted']['digests']:
            raise RetentionError('LOCAL_CLOUD_EXPORT_MISMATCH')
    delete_local = sorted(set(local)-keep_local)
    if len(delete_local)>100 or len(delete_local)*2>len(local):
        raise RetentionError('DELETE_SAFETY_LIMIT')
    return {'createdAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'checkpoint': checkpoint,
            'settings': settings, 'cloudKeep': sorted(keep_cloud), 'localKeep': sorted(set(local)&keep_local),
            'cloudDelete': sorted(remote-keep_cloud), 'localDelete': delete_local,
            'local': local, 'cloud': verified, 'ignoredLocal': ignored_local,
            'ignoredCloud': ignored_remote}


def delete_local(root, name, expected):
    moment(name)
    if root not in (PLAIN, ENCRYPTED) or root.resolve() != root or set(expected) not in (PLAIN_FILES, EXPORT_FILES):
        raise RetentionError('UNSAFE_DELETE_TARGET')
    protected(root, directory=True)
    directory = root/name
    protected(directory, directory=True)
    if ({p.name for p in directory.iterdir()} != set(expected)
            or any(signature(directory/key) != value for key, value in expected.items())):
        raise RetentionError('LOCAL_CHANGED_BEFORE_DELETE')
    # Fixed finite files only: no recursive deletion and no symlink traversal.
    parent_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            for key in sorted(expected):
                os.unlink(key, dir_fd=fd)
        finally:
            os.close(fd)
        os.rmdir(name, dir_fd=parent_fd)
    finally:
        os.close(parent_fd)


def apply(value, cloud, checkpoint, journal):
    if not value['settings']['enabled']:
        raise RetentionError('POLICY_NOT_ENABLED')
    hard_protected = (set(value['settings']['pinned']) | {value['checkpoint']['backupSet']}
                      | set(sorted(set(value['local']) | set(value['cloud']))[-3:]))
    if ((set(value['cloudDelete']) & set(value['cloudKeep']))
            or (set(value['localDelete']) & set(value['localKeep']))
            or hard_protected & (set(value['cloudDelete']) | set(value['localDelete']))):
        raise RetentionError('PROTECTED_DELETE_ATTEMPT')
    if checkpoint() != value['checkpoint']:
        raise RetentionError('BACKUP_CHECKPOINT_CHANGED')
    for name, pair in value['local'].items():
        for root, kind in [(PLAIN, 'plain'), (ENCRYPTED, 'encrypted')]:
            if any(signature(root/name/key) != expected for key, expected in pair[kind]['signatures'].items()):
                raise RetentionError('LOCAL_CHANGED_BEFORE_DELETE')
    names, _ = cloud.names()
    if names != set(value['cloud']):
        raise RetentionError('CLOUD_INVENTORY_CHANGED')
    # Revalidate every survivor just before the first mutation. Snapshot listings
    # are tied to full downloaded SHA-256 checks, not listing-only verification.
    for name in value['cloudKeep']:
        if cloud.listing(name) != value['cloud'][name]['listing']:
            raise RetentionError('SURVIVOR_CHANGED')
    completed = {'cloud': [], 'local': []}
    for name in value['cloudDelete']:
        journal({'action': 'cloud-to-trash', 'backupSet': name, 'completed': completed})
        cloud.remove(name, value['cloud'][name]['listing'])
        completed['cloud'].append(name)
    for name in value['localDelete']:
        journal({'action': 'local-pair-delete', 'backupSet': name, 'completed': completed})
        for root, kind in [(PLAIN, 'plain'), (ENCRYPTED, 'encrypted')]:
            delete_local(root, name, value['local'][name][kind]['signatures'])
        completed['local'].append(name)
    remaining, _ = cloud.names()
    if remaining != set(value['cloudKeep']):
        raise RetentionError('POST_DELETE_CLOUD_MISMATCH')
    for name in value['localKeep']:
        local_set(PLAIN, name, False); local_set(ENCRYPTED, name, True)
    return completed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'run'], nargs='?', default='plan')
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0:
        print('retention: ROOT_REQUIRED', file=sys.stderr); return 1
    try:
        settings = policy(json_file(CONFIG)) if CONFIG.exists() or CONFIG.is_symlink() else policy(dict(DEFAULT))
        if args.command == 'run' and not settings['enabled']:
            raise RetentionError('POLICY_NOT_ENABLED')
        if not STATE.exists() and not STATE.is_symlink():
            STATE.mkdir(mode=0o700)
        protected(STATE, directory=True)
        with open('/var/lock/st24-backup.lock', 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                print('retention: backup lock busy; no changes'); return 0
            started = datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
            if args.command == 'run':
                atomic_json(STATE/'last-run.json', {'status': 'running', 'checkedAt': started})
            cloud = Cloud(STATE/'rclone.log')
            value = plan(settings, datetime.now(timezone.utc), cloud, STATE)
            atomic_json(STATE/'plan.json', value)
            completed = {'cloud': [], 'local': []}
            if args.command == 'run':
                completed = apply(value, cloud, lambda: fresh_checkpoint(datetime.now(timezone.utc)),
                                  lambda event: atomic_json(STATE/'action.json', event))
                atomic_json(STATE/'last-run.json', {'status': 'ok', 'checkedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
                            'backupSet': value['checkpoint']['backupSet'], 'deletedCloud': len(completed['cloud']), 'deletedLocalPairs': len(completed['local'])})
            print(json.dumps({'mode': args.command, 'backupSet': value['checkpoint']['backupSet'],
                  'localPairs': len(value['local']), 'cloudSets': len(value['cloud']),
                  'localKeep': value['localKeep'], 'cloudKeep': value['cloudKeep'],
                  'localDelete': value['localDelete'], 'cloudDelete': value['cloudDelete'],
                  'deleted': completed, 'cloudDeletion': 'trash-only'}))
            return 0
    except (RetentionError, CryptoError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, (RetentionError, CryptoError)) else type(error).__name__
        if args.command == 'run':
            try:
                protected(STATE, directory=True)
                atomic_json(STATE/'last-run.json', {'status': 'failed', 'checkedAt': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'code': code})
            except (OSError, RetentionError):
                pass  # Never write diagnostics through an unsafe state directory.
        print('retention: FAILED '+code, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
