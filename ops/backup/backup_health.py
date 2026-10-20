#!/usr/bin/env python3
"""Root-only backup watchdog. Never sends credentials, archives, or raw errors."""

import argparse
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import getpass
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib import request
import warnings


BACKUP_ROOT = Path('/var/backups/st24')
ENCRYPTED_ROOT = Path('/var/backups/karcher-encrypted')
CONFIG = Path('/etc/karcher-backup/alerts.json')
SET_PATTERN = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC')
PING_PATTERN = re.compile(
    r'https://(?:eu\.)?cronitor\.link/p/[A-Za-z0-9_-]{1,256}/'
    r'(?P<monitor>[A-Za-z0-9][A-Za-z0-9_.-]{0,127})'
)
STAGES = {'initialization', 'encryption_configuration', 'security_configuration',
          'configuration', 'system_recovery', 'system_recovery_verification', 'database_dump',
          'files_archive', 'checksums', 'encryption', 'offsite_copy',
          'offsite_verification', 'complete'}


class HealthError(ValueError):
    pass


@dataclass(frozen=True)
class Limits:
    max_age_hours: float = 26
    max_run_hours: float = 2
    min_free_gib: float = 5
    min_free_percent: float = 15
    min_free_inodes_percent: float = 10


def protected(path, directory=False):
    info = path.lstat()
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected(info.st_mode):
        raise HealthError('UNSAFE_FILE_TYPE')
    if os.name == 'posix' and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
        raise HealthError('UNSAFE_PERMISSIONS')
    return info


def read_json(path):
    protected(path)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0)
    with os.fdopen(os.open(path, flags), 'rb') as file:
        data = file.read(16385)
    if len(data) > 16384:
        raise HealthError('JSON_TOO_LARGE')
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise HealthError('JSON_INVALID') from None
    if not isinstance(value, dict):
        raise HealthError('JSON_INVALID')
    return value


def timestamp(value, now):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z', value):
        raise HealthError('TIMESTAMP_INVALID')
    try:
        parsed = datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc)
    except ValueError:
        raise HealthError('TIMESTAMP_INVALID') from None
    if (parsed - now).total_seconds() > 120:
        raise HealthError('CLOCK_IN_FUTURE')
    return parsed


def validate_stamp(value, now, success=False):
    if (not isinstance(value.get('backupSet'), str)
            or not SET_PATTERN.fullmatch(value['backupSet'])
            or not isinstance(value.get('stage'), str)
            or value.get('stage') not in STAGES
            or value.get('encryption') != 'age-x25519-v1'
            or not isinstance(value.get('status'), str)
            or value.get('status') not in {'running', 'local_verified', 'failed', 'verified'}):
        raise HealthError('STAMP_INVALID')
    checked = timestamp(value.get('checkedAt'), now)
    try:
        created = datetime.strptime(value['backupSet'], '%Y-%m-%d_%H-%M-%S_UTC').replace(tzinfo=timezone.utc)
    except ValueError:
        raise HealthError('STAMP_INVALID') from None
    if (created - checked).total_seconds() > 120:
        raise HealthError('STAMP_INVALID')
    if value['status'] == 'verified' and value['stage'] != 'complete':
        raise HealthError('STAMP_INVALID')
    if success and value['status'] != 'verified':
        raise HealthError('SUCCESS_NOT_VERIFIED')
    return checked


def backup_check(root, encrypted_root, now, limits):
    try:
        protected(root, directory=True)
        protected(encrypted_root, directory=True)
        try:
            success = read_json(root / '.last-success.json')
        except FileNotFoundError:
            raise HealthError('LAST_SUCCESS_MISSING') from None
        checked = validate_stamp(success, now, success=True)
        age = max(0, (now - checked).total_seconds())
        if age > limits.max_age_hours * 3600:
            raise HealthError('BACKUP_STALE')
        latest = read_json(root / '.last-run.json')
        latest_checked = validate_stamp(latest, now)
        # The success checkpoint is published just before last-run. Reading
        # during that atomic transition must not report the previous failure.
        if latest_checked >= checked and latest['status'] == 'failed':
            raise HealthError('BACKUP_RUN_FAILED')
        if latest_checked >= checked and latest['status'] in {'running', 'local_verified'}:
            started = timestamp(latest.get('startedAt'), now)
            if started > latest_checked:
                raise HealthError('STAMP_INVALID')
            if (now - started).total_seconds() > limits.max_run_hours * 3600:
                raise HealthError('BACKUP_RUN_STUCK')
        for parent, names in (
            (root, ('st24_db.dump', 'st24_files.tar.gz', 'SHA256SUMS.txt')),
            (encrypted_root, ('backup.tar.age', 'MANIFEST.json', 'SHA256SUMS.txt')),
        ):
            directory = parent / success['backupSet']
            protected(directory, directory=True)
            for name in names:
                if protected(directory / name).st_size <= 0:
                    raise HealthError('BACKUP_COMPONENT_EMPTY')
        return {'status': 'ok', 'code': 'BACKUP_VERIFIED', 'ageHours': round(age / 3600, 2)}
    except HealthError as error:
        return {'status': 'failed', 'code': str(error)}
    except OSError:
        return {'status': 'failed', 'code': 'BACKUP_FILES_UNAVAILABLE'}


def storage_check(paths, limits, statvfs=None):
    statvfs = statvfs or os.statvfs
    disks = []
    try:
        for path in paths:
            info = statvfs(path)
            if info.f_blocks <= 0 or info.f_frsize <= 0 or info.f_bavail < 0:
                raise HealthError('DISK_STATS_INVALID')
            free_gib = info.f_bavail * info.f_frsize / 1024**3
            free_percent = info.f_bavail * 100 / info.f_blocks
            # Filesystems reporting no inode capacity (e.g. some network FS)
            # cannot supply a meaningful inode percentage.
            inodes = info.f_favail * 100 / info.f_files if info.f_files > 0 else None
            disks.append({'freeGiB': round(free_gib, 2), 'freePercent': round(free_percent, 2),
                          'freeInodesPercent': round(inodes, 2) if inodes is not None else None})
            if free_gib < limits.min_free_gib or free_percent < limits.min_free_percent:
                raise HealthError('DISK_SPACE_LOW')
            if inodes is not None and inodes < limits.min_free_inodes_percent:
                raise HealthError('DISK_INODES_LOW')
        return {'status': 'ok', 'code': 'DISK_SPACE_OK', 'filesystems': disks}
    except HealthError as error:
        return {'status': 'failed', 'code': str(error), 'filesystems': disks}
    except OSError:
        return {'status': 'failed', 'code': 'DISK_STATS_UNAVAILABLE'}


def collect(limits=Limits()):
    now = datetime.now(timezone.utc)
    checks = {'backup': backup_check(BACKUP_ROOT, ENCRYPTED_ROOT, now, limits),
              'storage': storage_check((BACKUP_ROOT, ENCRYPTED_ROOT), limits)}
    retention = retention_check(now)
    if retention is not None and retention['status'] != 'ok' and checks['backup']['status'] == 'ok':
        checks['backup'] = retention
    return {'checkedAt': now.strftime('%Y-%m-%dT%H:%M:%SZ'),
            'status': 'ok' if all(c['status'] == 'ok' for c in checks.values()) else 'failed',
            'checks': checks}


def retention_check(now, configuration=None, state=None):
    configuration = configuration or Path('/etc/karcher-backup/retention.json')
    state = state or Path('/var/lib/karcher-retention/last-run.json')
    if not configuration.exists() and not configuration.is_symlink():
        return None
    try:
        settings = read_json(configuration)
        if type(settings.get('enabled')) is not bool:
            raise HealthError('RETENTION_CONFIG_INVALID')
        if not settings['enabled']:
            return None
        protected(state.parent, directory=True)
        value = read_json(state)
        checked = timestamp(value.get('checkedAt'), now)
        age = (now-checked).total_seconds()
        if value.get('status') == 'failed':
            raise HealthError('RETENTION_FAILED')
        if value.get('status') == 'running':
            if age > 25*60:
                raise HealthError('RETENTION_STUCK')
        elif value.get('status') != 'ok':
            raise HealthError('RETENTION_STATE_INVALID')
        elif age > 30*3600:
            raise HealthError('RETENTION_STALE')
        return {'status': 'ok', 'code': 'RETENTION_OK'}
    except HealthError as error:
        return {'status': 'failed', 'code': str(error)}
    except OSError:
        return {'status': 'failed', 'code': 'RETENTION_STATE_UNAVAILABLE'}


def validate_config(value):
    if (type(value.get('version')) is not int or value['version'] != 2
            or value.get('provider') != 'cronitor' or not isinstance(value.get('checks'), dict)):
        raise HealthError('ALERT_CONFIG_INVALID')
    urls = value['checks']
    if set(urls) != {'backup', 'storage'} or any(
            not isinstance(url, str) or not PING_PATTERN.fullmatch(url) for url in urls.values()):
        raise HealthError('PING_URL_INVALID')
    if len(set(urls.values())) != 2:
        raise HealthError('CHECK_URLS_MUST_DIFFER')
    # Different tokens or regional hosts can still point at the SAME monitor.
    if len({PING_PATTERN.fullmatch(url)['monitor'] for url in urls.values()}) != 2:
        raise HealthError('CHECK_MONITORS_MUST_DIFFER')
    thresholds = value.get('limits', {})
    if not isinstance(thresholds, dict) or set(thresholds) - set(asdict(Limits())):
        raise HealthError('LIMITS_INVALID')
    for number in thresholds.values():
        if type(number) not in (int, float) or not math.isfinite(number) or number <= 0:
            raise HealthError('LIMITS_INVALID')
    limits = Limits(**thresholds)
    if (limits.max_run_hours >= limits.max_age_hours or limits.max_age_hours > 168
            or limits.min_free_percent >= 100 or limits.min_free_inodes_percent >= 100):
        raise HealthError('LIMITS_INVALID')
    return urls, limits


class NoRedirect(request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def ping(url, event, payload, opener=None):
    if not isinstance(url, str) or not PING_PATTERN.fullmatch(url) or event not in {'tick', 'fail'}:
        raise HealthError('PING_URL_INVALID')
    # Ignore HTTP(S)_PROXY environment variables. In particular, never use the
    # shop's broken Telegram proxy or follow a redirect containing the secret URL.
    opener = opener or request.build_opener(request.ProxyHandler({}), NoRedirect())
    message = json.dumps(payload, separators=(',', ':'), ensure_ascii=True)
    if len(message) > 2000:
        raise HealthError('PING_MESSAGE_TOO_LARGE')
    # Cronitor discards POST bodies. Event parameters and safe diagnostic data
    # must be encoded in the query, not appended as Healthchecks /fail or /log.
    query = urlencode({'state': event, 'env': 'production', 'message': message})
    code = 'PING_DELIVERY_FAILED'
    for attempt in range(2):
        try:
            req = request.Request(url + '?' + query, data=b'', method='POST',
                                  headers={'User-Agent': 'karcher-backup-health/2'})
            with opener.open(req, timeout=10) as response:
                if not 200 <= response.status < 300:
                    raise HealthError('PING_HTTP_REJECTED')
            # A 2xx only confirms HTTP acceptance. Monitor event persistence,
            # recipients, and failure/recovery delivery require dashboard checks.
            return
        except HTTPError as error:
            status = error.code
            error.close()
            if status in (401, 403):
                raise HealthError('PING_AUTH_REJECTED') from None
            if status == 429:
                code = 'PING_RATE_LIMITED'
            elif 500 <= status < 600:
                code = 'PING_SERVICE_UNAVAILABLE'
            else:
                raise HealthError('PING_HTTP_REJECTED') from None
        except HealthError:
            raise
        except Exception:
            code = 'PING_DELIVERY_FAILED'
        if attempt == 0:
            time.sleep(1)
    raise HealthError(code)


def deliver(urls, report):
    delivery = {}
    for name in ('backup', 'storage'):
        check = report['checks'][name]
        try:
            ping(urls[name], 'tick' if check['status'] == 'ok' else 'fail',
                 {'checkedAt': report['checkedAt'], 'check': name, **check})
            delivery[name] = 'accepted'
        except HealthError as error:
            delivery[name] = str(error)
    report['delivery'] = delivery
    return all(value == 'accepted' for value in delivery.values())


def configure(path=CONFIG):
    if os.name != 'posix' or os.geteuid() != 0:
        raise HealthError('ROOT_REQUIRED')
    if not sys.stdin.isatty():
        raise HealthError('SECURE_TERMINAL_REQUIRED')
    protected(path.parent, directory=True)
    if path.exists() or path.is_symlink():
        protected(path)
    print('Create TWO Cronitor HEARTBEAT monitors: backup and storage.')
    print('For BOTH: every 5 minutes, grace period 10 minutes. Connect Telegram and email.')
    print('Paste full base https://cronitor.link/p/<telemetry-key>/<monitor-key> URLs.')
    print('Use telemetry-only keys, NOT management keys. Input is hidden; never send URLs to chat.')
    print('Setup submits ACTUAL health and may send failure/recovery notifications. It does not fake success.')
    try:
        with warnings.catch_warnings():
            # getpass must never fall back to visible input if TTY control fails.
            warnings.simplefilter('error', getpass.GetPassWarning)
            config = {'version': 2, 'provider': 'cronitor', 'checks': {
                'backup': getpass.getpass('Backup Telemetry URL (hidden): ').strip(),
                'storage': getpass.getpass('Storage Telemetry URL (hidden): ').strip(),
            }, 'limits': asdict(Limits())}
    except getpass.GetPassWarning:
        raise HealthError('SECURE_TERMINAL_REQUIRED') from None
    urls, limits = validate_config(config)
    report = collect(limits)
    if not deliver(urls, report):
        raise HealthError('CONFIGURATION_DELIVERY_FAILED')
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.alerts-', dir=path.parent)
        with os.fdopen(descriptor, 'w', encoding='ascii') as file:
            json.dump(config, file)
            file.write('\n')
            file.flush()
            os.fsync(file.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    print('Both HTTP submissions accepted; root-only Cronitor configuration installed. No secrets printed.')
    print('HTTP acceptance does NOT prove event storage or alert delivery.')
    print('Confirm both events in the Cronitor dashboard. Tell the operator setup is ready; timer stays off.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('check', 'send', 'configure'))
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if args.mode == 'configure':
            configure()
            return 0
        urls, limits = None, Limits()
        if CONFIG.exists() or CONFIG.is_symlink():
            protected(CONFIG.parent, directory=True)
            urls, limits = validate_config(read_json(CONFIG))
        if args.mode == 'send' and urls is None:
            raise HealthError('ALERT_CONFIG_MISSING')
        report = collect(limits)
        sent = deliver(urls, report) if args.mode == 'send' else True
        print(json.dumps(report, separators=(',', ':')))
        return 0 if sent and report['status'] == 'ok' else 1
    except (HealthError, OSError, EOFError, KeyboardInterrupt) as error:
        code = str(error) if isinstance(error, HealthError) else 'OPERATION_NOT_COMPLETED'
        print(json.dumps({'status': 'failed', 'code': code}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
