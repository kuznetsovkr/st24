#!/usr/bin/env python3
"""Read-only host inventory and an explicit recovery-configuration allowlist.

Only the root-private inventory directory is written. No package/service/network
changes, database queries, secrets in stdout, or automatic restore operations.
"""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import tempfile

from files_archive import ArchiveError, inventory


REQUIRED = (
    'etc/apt/sources.list', 'etc/apt/sources.list.d', 'etc/apt/preferences.d',
    'etc/apt/apt.conf.d', 'etc/apt/keyrings', 'etc/apt/trusted.gpg.d',
    'usr/share/keyrings/nodesource.gpg', 'usr/share/keyrings/karcher-nginx.gpg',
    'usr/share/keyrings/ubuntu-archive-keyring.gpg',
    'etc/postgresql/16/main', 'etc/redis', 'etc/fail2ban',
    'etc/systemd/system/nginx.service.d',
    'etc/systemd/system/karcher-backup-health.service',
    'etc/systemd/system/karcher-backup-health.timer',
    'etc/systemd/system/timers.target.wants/karcher-backup-health.timer',
    'etc/systemd/system/timers.target.wants/certbot.timer',
    'etc/systemd/system/multi-user.target.wants/nginx.service',
    'var/spool/cron/crontabs/root', 'var/lib/dpkg/statoverride',
    'var/lib/dpkg/diversions', 'etc/cron.daily/phpsess_cron',
    'usr/local/lib/karcher-security/panel_autostart.py',
)
REFERENCE_ONLY = (
    'etc/os-release', 'usr/lib/os-release', 'etc/timezone', 'etc/localtime', 'etc/fstab',
    'etc/network/interfaces', 'etc/network/interfaces.d', 'etc/systemd/network',
    'etc/netplan', 'etc/default/grub', 'etc/dracut.conf', 'etc/dracut.conf.d',
    'etc/apparmor.d',
)
PACKAGE_QUERY = ('dpkg-query', '-W',
                 '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\t${Architecture}\n')
COMMANDS = {
    'architecture': ('dpkg', '--print-architecture'),
    'manualPackages': ('apt-mark', 'showmanual'),
    'heldPackages': ('apt-mark', 'showhold'),
    'unitFiles': ('systemctl', 'list-unit-files', '--no-legend', '--no-pager'),
    'timezone': ('timedatectl', 'show', '-p', 'Timezone', '--value'),
    'appCommit': ('git', '-C', '/var/www/st24', 'rev-parse', 'HEAD'),
}
ACCOUNTS = ('karcher-api', 'postgres', 'redis', 'www-data', 'root')
REQUIRED_DIRECTORIES = {
    'etc/apt/sources.list.d', 'etc/apt/preferences.d', 'etc/apt/apt.conf.d',
    'etc/apt/keyrings', 'etc/apt/trusted.gpg.d', 'etc/postgresql/16/main',
    'etc/redis', 'etc/fail2ban', 'etc/systemd/system/nginx.service.d',
}
REQUIRED_LINKS = {
    'etc/systemd/system/timers.target.wants/karcher-backup-health.timer':
        '/etc/systemd/system/karcher-backup-health.timer',
    'etc/systemd/system/timers.target.wants/certbot.timer':
        '/usr/lib/systemd/system/certbot.timer',
    'etc/systemd/system/multi-user.target.wants/nginx.service':
        '/usr/lib/systemd/system/nginx.service',
}


class RecoveryError(Exception):
    pass


def query(command):
    environment = dict(os.environ, LC_ALL='C.UTF-8', SYSTEMD_COLORS='0', SYSTEMD_PAGER='cat')
    result = subprocess.run(command, capture_output=True, timeout=30, env=environment)
    if result.returncode or len(result.stdout) > 4 * 1024 * 1024:
        raise RecoveryError('INVENTORY_COMMAND_FAILED')
    return result.stdout.decode('utf-8')


def packages(text):
    rows = []
    names = set()
    for line in text.splitlines():
        fields = line.split('\t')
        if len(fields) != 4 or len(fields[1]) != 3 or fields[0] in names:
            raise RecoveryError('PACKAGE_INVENTORY_INVALID')
        name, state, version, architecture = fields
        if not re.fullmatch(r'[a-z0-9][a-z0-9+.:\-]*', name):
            raise RecoveryError('PACKAGE_INVENTORY_INVALID')
        names.add(name)
        # Preserve installed holds, but never call a partial package "installed".
        if state[1:] == 'i ':
            rows.append({'name': name, 'version': version, 'architecture': architecture})
        elif state[1] not in ('n', 'c') or state[2] != ' ':
            raise RecoveryError('PACKAGE_TRANSACTION_INCOMPLETE')
    if not rows:
        raise RecoveryError('PACKAGE_INVENTORY_EMPTY')
    return sorted(rows, key=lambda row: row['name'])


def select_paths(root):
    selected = list(REQUIRED)
    for name in REQUIRED:
        path = root / name
        mode = path.lstat().st_mode
        if name in REQUIRED_LINKS:
            valid = stat.S_ISLNK(mode) and os.readlink(path) == REQUIRED_LINKS[name]
        else:
            valid = stat.S_ISDIR(mode) if name in REQUIRED_DIRECTORIES else stat.S_ISREG(mode)
        if not valid:
            raise RecoveryError('REQUIRED_CONFIGURATION_TYPE_INVALID')
    optional = []
    for name in REFERENCE_ONLY:
        path = root / name
        if path.exists() or path.is_symlink():
            selected.append(name)
        else:
            optional.append(name)
    retention_config = root/'etc/karcher-backup/retention.json'
    if retention_config.exists() or retention_config.is_symlink():
        if not stat.S_ISREG(retention_config.lstat().st_mode):
            raise RecoveryError('RETENTION_CONFIGURATION_INVALID')
        settings = json.loads(retention_config.read_text())
        if not isinstance(settings, dict) or type(settings.get('enabled')) is not bool:
            raise RecoveryError('RETENTION_CONFIGURATION_INVALID')
        selected.append('etc/karcher-backup/retention.json')
        for name in ['etc/systemd/system/karcher-backup-retention.service',
                     'etc/systemd/system/karcher-backup-retention.timer',
                     'etc/systemd/system/timers.target.wants/karcher-backup-retention.timer']:
            path = root/name
            if not path.exists() and not path.is_symlink() and not settings['enabled']:
                continue
            if 'timers.target.wants/' in name:
                valid = path.is_symlink() and os.readlink(path) == '/etc/systemd/system/karcher-backup-retention.timer'
            else:
                valid = stat.S_ISREG(path.lstat().st_mode)
            if not valid:
                raise RecoveryError('RETENTION_CONFIGURATION_INVALID')
            selected.append(name)
    # Preserve ONLY real service masks here, not the entire systemd config tree.
    # Boot state of all other units is recorded in unitFiles for manual review.
    directory = root / 'etc/systemd/system'
    for path in sorted(directory.iterdir()):
        if path.is_symlink() and os.readlink(path) == '/dev/null':
            selected.append(path.relative_to(root).as_posix())
    # inventory rejects missing required inputs and symlinked ancestors, never
    # follows links, and checks readability/hash/ACL/xattr for every chosen entry.
    return selected, optional, inventory(root, selected)


def account_metadata():
    import pwd
    import grp
    result = {}
    for name in ACCOUNTS:
        user = pwd.getpwnam(name)
        group = grp.getgrgid(user.pw_gid)
        result[name] = {'uid': user.pw_uid, 'gid': user.pw_gid,
                        'group': group.gr_name, 'home': user.pw_dir, 'shell': user.pw_shell}
    return result


def unit_file_states(text):
    if not isinstance(text, str):
        raise RecoveryError('RECOVERY_INVENTORY_INVALID')
    # systemctl pads ALL rows to the longest unit name, including transient
    # units filtered out below. Compare states/presets, not display alignment.
    return '\n'.join(sorted(' '.join(line.split()) for line in text.splitlines() if line.strip()))


def collect(root, backup_set, *, read=query, accounts=account_metadata):
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_UTC', backup_set):
        raise RecoveryError('BACKUP_SET_INVALID')
    initial_packages = read(PACKAGE_QUERY)
    package_rows = packages(initial_packages)
    selected, absent, entries = select_paths(root)
    commands = {name: read(command).strip() for name, command in COMMANDS.items()}
    # systemd-run creates temporary unit files for this very backup. They are
    # not boot configuration and must not cause a false drift after --collect.
    commands['unitFiles'] = unit_file_states('\n'.join(
        line for line in commands['unitFiles'].splitlines()
        if len(line.split()) >= 2 and line.split()[1] != 'transient'))
    if not re.fullmatch(r'[0-9a-f]{40}', commands['appCommit']):
        raise RecoveryError('APP_COMMIT_INVALID')
    if initial_packages != read(PACKAGE_QUERY):
        raise RecoveryError('PACKAGES_CHANGED_DURING_INVENTORY')
    records = []
    for name, entry in sorted(entries.items()):
        kind, mode, uid, gid, mtime, attrs, payload = entry.portable
        row = {'path': name, 'mode': format(mode, '04o'), 'uid': uid, 'gid': gid,
               'xattrSha256': {key: hashlib.sha256(value).hexdigest() for key, value in attrs}}
        if kind == stat.S_IFREG:
            row.update(type='file', sha256=payload.hex())
        elif kind == stat.S_IFLNK:
            row.update(type='symlink', target=payload)
        else:
            row.update(type='directory')
        records.append(row)
    document = {
        'format': 'karcher-host-recovery-v1', 'backupSet': backup_set,
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'kernel': platform.release(), 'packages': package_rows,
        'accounts': accounts(), **commands, 'configEntries': records,
        'selectedRoots': selected, 'referenceOnlyRoots': list(REFERENCE_ONLY),
        'absentOptionalPaths': absent,
        'limitations': ['not-a-disk-image', 'not-an-atomic-db-filesystem-snapshot',
                        'no-package-binaries-or-historical-rollback-snapshots',
                        'no-ssh-private-keys-or-age-identity-or-rclone-oauth-config',
                        'no-redis-data-or-global-postgres-roles-tablespaces',
                        'manual-review-required-before-restoring-os-config'],
    }
    return document, selected


def publish(directory, document):
    # Production runs as root; tests use their own private temporary directories.
    # Refuse redirected storage instead of fixing/chmod'ing someone else's tree.
    parent = directory.parent
    for path in (parent, *parent.parents):
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022:
            raise RecoveryError('UNTRUSTED_OUTPUT_PARENT')
    if not directory.exists() and not directory.is_symlink():
        directory.mkdir(mode=0o700)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o700:
        raise RecoveryError('PRIVATE_OUTPUT_DIRECTORY_REQUIRED')
    target = directory / 'recovery.json'
    if target.exists() or target.is_symlink():
        info = target.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o600:
            raise RecoveryError('PRIVATE_OUTPUT_FILE_REQUIRED')
    fd, temporary = tempfile.mkstemp(prefix='.recovery-', dir=directory)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(document, stream, ensure_ascii=True, sort_keys=True)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def verify(document, current):
    # The only variable field is collection time. In particular compare the
    # package set and config hashes again AFTER tar, not just during collection.
    if not isinstance(document, dict) or not isinstance(current, dict):
        raise RecoveryError('RECOVERY_INVENTORY_INVALID')
    def stable(value):
        result = {key: item for key, item in value.items() if key != 'createdAt'}
        if 'unitFiles' in result:
            # Accept earlier inventories with padded table output too. This
            # does not ignore a real unit, state, or preset change.
            result['unitFiles'] = unit_file_states(result['unitFiles'])
        return result
    if stable(document) != stable(current):
        raise RecoveryError('RECOVERY_INPUTS_CHANGED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backup-set', required=True)
    parser.add_argument('--verify', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0:
        print('recovery_inventory: ROOT_REQUIRED', file=sys.stderr)
        return 1
    try:
        document, paths = collect(Path('/'), args.backup_set)
        if args.verify:
            target = Path('/var/lib/karcher-backup/recovery.json')
            info = target.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o777 != 0o600:
                raise RecoveryError('PRIVATE_OUTPUT_FILE_REQUIRED')
            verify(json.loads(target.read_text()), document)
        else:
            publish(Path('/var/lib/karcher-backup'), document)
    except (RecoveryError, ArchiveError, OSError, KeyError, json.JSONDecodeError,
            subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, (RecoveryError, ArchiveError)) else type(error).__name__
        print('recovery_inventory: FAILED ' + code, file=sys.stderr)
        return 1
    if not args.verify:
        sys.stdout.buffer.write(b''.join(os.fsencode(path) + b'\0' for path in paths + ['var/lib/karcher-backup']))
    print('recovery_inventory: configuration and package inventory captured', file=sys.stderr)
    return 0


if __name__ == '__main__':
    sys.exit(main())
