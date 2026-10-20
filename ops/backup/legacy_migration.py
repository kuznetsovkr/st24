#!/usr/bin/env python3
"""Copy legacy backup history to a separate encrypted namespace; NEVER delete.

Run plan first, then migrate. Originals, modern backups, checkpoints, retention
and the account trash are not modified. A failed/partial upload is not success.
"""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from encrypted_backup import (COMPONENTS, CONTENTS, ENCRYPTED_FILES, FORMAT,
                              CryptoError, recipient_id, seal, verify_checksums)
from retention import (Cloud as Rclone, RetentionError, atomic_json, digest,
                       protected, signature)

SOURCE = Path('/var/backups/st24')
ENCRYPTED = Path('/var/backups/karcher-legacy-encrypted')
STATE = Path('/var/lib/karcher-legacy-migration')
RECIPIENTS = Path('/etc/karcher-backup/recipients.txt')
SOURCE_REMOTE = 'yadisk:st24-backups'
DESTINATION_PARENT = 'yadisk:karcher-backups-encrypted'
DESTINATION_REMOTE = DESTINATION_PARENT+'/legacy-v1'
EXPORT_FILES = ENCRYPTED_FILES | {'SHA256SUMS.txt'}
NAME = re.compile(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_UTC)?')
PLAN_FORMAT = 'karcher-legacy-migration-plan-v1'


class MigrationError(Exception):
    pass


def backup_name(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise MigrationError('INVALID_LEGACY_NAME')
    datetime.strptime(name.removesuffix('_UTC'), '%Y-%m-%d_%H-%M-%S')
    return name  # Preserve the original label; do not guess its timezone.


def snapshot(root, name, files):
    backup_name(name)
    protected(root, directory=True)
    if root.resolve() != root:
        raise MigrationError('REDIRECTED_ROOT')
    directory = root/name
    protected(directory, directory=True)
    if {p.name for p in directory.iterdir()} != files:
        raise MigrationError('UNEXPECTED_LOCAL_CONTENTS')
    signatures = {key: signature(directory/key) for key in sorted(files)}
    verify_checksums(directory, files-{'SHA256SUMS.txt'})
    hashes = {key: digest(directory/key) for key in sorted(files)}
    sizes = {key: (directory/key).stat().st_size for key in sorted(files)}
    if any(size <= 0 for size in sizes.values()):
        raise MigrationError('EMPTY_COMPONENT')
    if any(signature(directory/key) != value for key, value in signatures.items()):
        raise MigrationError('LOCAL_CHANGED_DURING_READ')
    return {'signatures': signatures, 'sha256': hashes, 'sizes': sizes}


def provenance(name, source):
    return {'backupSet': backup_name(name), 'sourceRemote': SOURCE_REMOTE+'/'+name,
            'componentsSha256': source['sha256'], 'componentsBytes': source['sizes']}


def export_snapshot(name, source):
    value = snapshot(ENCRYPTED, name, EXPORT_FILES)
    path = ENCRYPTED/name/'MANIFEST.json'
    if path.stat().st_size > 4096:
        raise MigrationError('MANIFEST_TOO_LARGE')
    manifest = json.loads(path.read_text())
    if (not isinstance(manifest, dict) or manifest.get('format') != FORMAT
            or manifest.get('contents') != sorted(CONTENTS)
            or manifest.get('recipientSha256') != recipient_id(RECIPIENTS)
            or manifest.get('legacySource') != provenance(name, source)):
        raise MigrationError('EXPORT_PROVENANCE_MISMATCH')
    with (ENCRYPTED/name/'backup.tar.age').open('rb') as stream:
        if not stream.read(32).startswith(b'age-encryption.org/v1\n'):
            raise MigrationError('ENCRYPTED_HEADER_REQUIRED')
    return value


class LegacyCloud:
    def __init__(self, log):
        self.transport = Rclone(log)

    def rows(self, root):
        rows = json.loads(self.transport.call(['lsjson', root, '--max-depth', '1', '--hash']))
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise MigrationError('REMOTE_LISTING_INVALID')
        return rows

    def names(self, root):
        if root == DESTINATION_REMOTE:
            matches = [r for r in self.rows(DESTINATION_PARENT) if r['Name']=='legacy-v1']
            if not matches:
                return set()
            if len(matches) != 1 or not matches[0]['IsDir']:
                raise MigrationError('UNSAFE_DESTINATION')
        rows = self.rows(root)
        if any(not r['IsDir'] or r['Path'] != r['Name'] for r in rows):
            raise MigrationError('UNEXPECTED_REMOTE_ROOT_CONTENTS')
        names = [backup_name(r['Name']) for r in rows]
        if len(set(names)) != len(names) or len(names)>100:
            raise MigrationError('REMOTE_SET_LIMIT_OR_DUPLICATE')
        return set(names)

    def listing(self, root, name, expected, partial=False):
        rows = self.rows(root+'/'+backup_name(name))
        keys = {r['Name'] for r in rows}
        if (len(keys)!=len(rows) or not keys <= expected or (not partial and keys!=expected)
                or any(r['IsDir'] or r['Name']!=r['Path'] or r['Size']<=0 for r in rows)):
            raise MigrationError('UNEXPECTED_REMOTE_SET_CONTENTS')
        return sorted([{'name': r['Name'], 'bytes': r['Size'], 'time': r['ModTime'],
                        'hashes': r.get('Hashes', {})} for r in rows], key=lambda r: r['name'])

    def download(self, root, name, directory, files):
        if root not in (SOURCE_REMOTE, DESTINATION_REMOTE):
            raise MigrationError('UNSAFE_DOWNLOAD_SOURCE')
        if not directory.resolve().is_relative_to(STATE.resolve()):
            raise MigrationError('UNSAFE_DOWNLOAD_DESTINATION')
        for attempt in range(3):
            try:
                self.transport.call(['copy', root+'/'+backup_name(name), str(directory), '--max-depth', '1'])
                break
            except RetentionError:
                if attempt==2:
                    raise
                time.sleep(5)
        if {p.name for p in directory.iterdir()} != files:
            raise MigrationError('DOWNLOADED_CONTENTS_INVALID')
        return {key: digest(directory/key) for key in sorted(files)}

    def upload(self, name):
        # The only cloud write in this module: encrypted export -> legacy-v1.
        # copy --immutable never overwrites existing objects; no sync/move/delete.
        self.transport.call(['copy', str(ENCRYPTED/backup_name(name)),
                             DESTINATION_REMOTE+'/'+name, '--immutable', '--checksum', '--max-depth', '1'])

    def free_bytes(self):
        value = json.loads(self.transport.call(['about', 'yadisk:', '--json']))
        if type(value.get('free')) is not int or value['free']<0:
            raise MigrationError('REMOTE_QUOTA_UNAVAILABLE')
        return value['free']


def plan(cloud):
    names = cloud.names(SOURCE_REMOTE)
    if not names:
        raise MigrationError('NO_LEGACY_SETS')
    target_names = cloud.names(DESTINATION_REMOTE)
    if not target_names <= names:
        raise MigrationError('UNEXPECTED_DESTINATION_SETS')
    if ENCRYPTED.exists() or ENCRYPTED.is_symlink():
        protected(ENCRYPTED, directory=True)
        if ENCRYPTED.resolve()!=ENCRYPTED:
            raise MigrationError('REDIRECTED_ROOT')
    result = {'format': PLAN_FORMAT, 'createdAt': datetime.now(timezone.utc).isoformat(),
              'sourceRemote': SOURCE_REMOTE, 'destinationRemote': DESTINATION_REMOTE,
              'recipientSha256': recipient_id(RECIPIENTS), 'sets': {}, 'deletionSupported': False}
    for name in sorted(names):
        source = snapshot(SOURCE, name, CONTENTS)
        before = cloud.listing(SOURCE_REMOTE, name, CONTENTS)
        with tempfile.TemporaryDirectory(prefix='source-read-', dir=STATE) as directory:
            directory = Path(directory)
            try:
                hashes = cloud.download(SOURCE_REMOTE, name, directory, CONTENTS)
                read_proof = {'mode': 'all-components-downloaded'}
            except RetentionError:
                # A checksum is redundant metadata: never replace it in the
                # old cloud. Accept this narrow fallback ONLY when BOTH actual
                # payloads were downloaded and hash correctly, and the local
                # checksum bytes match the cloud object's size AND MD5.
                if {p.name for p in directory.iterdir()} != COMPONENTS:
                    raise
                hashes = {key: digest(directory/key) for key in COMPONENTS}
                if hashes != {key: source['sha256'][key] for key in COMPONENTS}:
                    raise MigrationError('CLOUD_SOURCE_PAYLOAD_MISMATCH')
                checksum = next(row for row in before if row['name']=='SHA256SUMS.txt')
                md5 = {key.lower(): value for key, value in checksum['hashes'].items()}.get('md5')
                data = (SOURCE/name/'SHA256SUMS.txt').read_bytes()
                if checksum['bytes']!=len(data) or md5!=hashlib.md5(data).hexdigest():
                    raise MigrationError('UNREADABLE_CHECKSUM_METADATA_MISMATCH')
                hashes['SHA256SUMS.txt'] = source['sha256']['SHA256SUMS.txt']
                read_proof = {'mode': 'payloads-downloaded-checksum-local',
                              'unreadableCloudComponent': 'SHA256SUMS.txt',
                              'checksumCloudSizeMd5Matched': True}
        if hashes != source['sha256'] or cloud.listing(SOURCE_REMOTE, name, CONTENTS)!=before:
            raise MigrationError('CLOUD_SOURCE_MISMATCH_OR_CHANGED')
        if snapshot(SOURCE, name, CONTENTS)!=source:
            raise MigrationError('LOCAL_SOURCE_CHANGED')
        result['sets'][name] = {'source': source, 'cloudSource': before, 'sourceRead': read_proof}
        print(json.dumps({'stage': 'source-verified', 'backupSet': name,
                          'sourceReadMode': read_proof['mode']}), flush=True)
    if cloud.names(SOURCE_REMOTE)!=names:
        raise MigrationError('SOURCE_INVENTORY_CHANGED')
    return result


def validate_source(cloud, name, expected):
    if (snapshot(SOURCE, name, CONTENTS)!=expected['source']
            or cloud.listing(SOURCE_REMOTE, name, CONTENTS)!=expected['cloudSource']):
        raise MigrationError('SOURCE_CHANGED_SINCE_PLAN')


def make_export(name, source):
    if not (ENCRYPTED/name).exists() and not (ENCRYPTED/name).is_symlink():
        stage = Path(tempfile.mkdtemp(prefix='.'+backup_name(name)+'.partial-', dir=ENCRYPTED))
        manifest = seal(SOURCE/name, stage, RECIPIENTS, '/usr/bin/age')
        manifest['legacySource'] = provenance(name, source)
        (stage/'MANIFEST.json').write_text(json.dumps(manifest, sort_keys=True)+'\n')
        (stage/'SHA256SUMS.txt').write_text(''.join(
            digest(stage/key)+'  '+key+'\n' for key in sorted(ENCRYPTED_FILES)), encoding='ascii')
        verify_checksums(stage, ENCRYPTED_FILES)
        os.rename(stage, ENCRYPTED/name)
    return export_snapshot(name, source)


def migrate(cloud, value, progress):
    if (not isinstance(value, dict) or value.get('format')!=PLAN_FORMAT
            or value.get('sourceRemote')!=SOURCE_REMOTE or value.get('destinationRemote')!=DESTINATION_REMOTE
            or value.get('recipientSha256')!=recipient_id(RECIPIENTS)
            or value.get('deletionSupported') is not False or not isinstance(value.get('sets'), dict)
            or not 1<=len(value['sets'])<=100):
        raise MigrationError('PLAN_INVALID')
    names = {backup_name(n) for n in value['sets']}
    if cloud.names(SOURCE_REMOTE)!=names or not cloud.names(DESTINATION_REMOTE)<=names:
        raise MigrationError('INVENTORY_CHANGED_SINCE_PLAN')
    for name, row in value['sets'].items():
        validate_source(cloud, name, row)
    total = sum(sum(row['source']['sizes'].values()) for row in value['sets'].values())
    # Keep at least 5 GiB locally and 512 MiB in Disk beyond the conservative estimate.
    if shutil.disk_usage(SOURCE).free < total*2+5*1024**3 or cloud.free_bytes()<total*2+512*1024**2:
        raise MigrationError('INSUFFICIENT_MIGRATION_SPACE')
    if not ENCRYPTED.exists() and not ENCRYPTED.is_symlink():
        ENCRYPTED.mkdir(mode=0o700)
    protected(ENCRYPTED, directory=True)
    if ENCRYPTED.resolve()!=ENCRYPTED:
        raise MigrationError('REDIRECTED_ROOT')
    completed = {}
    for name, row in sorted(value['sets'].items()):
        progress({'status': 'running', 'backupSet': name, 'completedSets': len(completed)})
        validate_source(cloud, name, row)
        local = make_export(name, row['source'])
        existing = cloud.names(DESTINATION_REMOTE)
        if not existing<=names:
            raise MigrationError('UNEXPECTED_DESTINATION_SETS')
        partial = []
        if name in existing:
            partial = cloud.listing(DESTINATION_REMOTE, name, EXPORT_FILES, partial=True)
            files = {r['name'] for r in partial}
            with tempfile.TemporaryDirectory(prefix='destination-read-', dir=STATE) as directory:
                hashes = cloud.download(DESTINATION_REMOTE, name, Path(directory), files)
            if any(hashes[key]!=local['sha256'][key] for key in files):
                raise MigrationError('EXISTING_EXPORT_CONFLICT')
        if {r['name'] for r in partial} != EXPORT_FILES:
            cloud.upload(name)
        before = cloud.listing(DESTINATION_REMOTE, name, EXPORT_FILES)
        with tempfile.TemporaryDirectory(prefix='export-read-', dir=STATE) as directory:
            hashes = cloud.download(DESTINATION_REMOTE, name, Path(directory), EXPORT_FILES)
        if hashes!=local['sha256'] or cloud.listing(DESTINATION_REMOTE, name, EXPORT_FILES)!=before:
            raise MigrationError('DOWNLOADED_EXPORT_MISMATCH_OR_CHANGED')
        if export_snapshot(name, row['source'])!=local:
            raise MigrationError('LOCAL_EXPORT_CHANGED')
        validate_source(cloud, name, row)
        completed[name] = {'verifiedAt': datetime.now(timezone.utc).isoformat(),
                           'source': row, 'export': local, 'cloudExport': before}
        atomic_json(STATE/'verified.json', completed)
        print(json.dumps({'stage': 'encrypted-cloud-verified', 'backupSet': name,
                          'completedSets': len(completed)}), flush=True)
    if cloud.names(SOURCE_REMOTE)!=names or cloud.names(DESTINATION_REMOTE)!=names:
        raise MigrationError('POST_MIGRATION_INVENTORY_CHANGED')
    for name, row in value['sets'].items():
        validate_source(cloud, name, row)
    warnings = sum(row.get('sourceRead', {}).get('mode')=='payloads-downloaded-checksum-local'
                   for row in value['sets'].values())
    progress({'status': 'ok', 'completedSets': len(completed), 'originalsDeleted': False,
              'sourceChecksumReadWarnings': warnings,
              'decryptionVerified': False})  # Key verification is a separate PC step.
    return completed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['plan', 'migrate'], nargs='?', default='plan')
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid()!=0:
        print('legacy migration: ROOT_REQUIRED', file=sys.stderr); return 1
    try:
        if not STATE.exists() and not STATE.is_symlink():
            STATE.mkdir(mode=0o700)
        protected(STATE, directory=True)
        if STATE.resolve()!=STATE:
            raise MigrationError('REDIRECTED_STATE')
        protected(Path('/var/lock/st24-backup.lock'))
        # flock on Linux needs no file writes. Keep the source and /run/lock
        # read-only in the sandbox; the existing daily backup owns lock creation.
        with open('/var/lock/st24-backup.lock', 'r') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                print('legacy migration: backup lock busy; no changes', file=sys.stderr)
                return 75
            cloud = LegacyCloud(STATE/'rclone.log')
            def progress(value):
                atomic_json(STATE/'last-run.json', {**value, 'checkedAt': datetime.now(timezone.utc).isoformat()})
            if args.command=='plan':
                value = plan(cloud)
                atomic_json(STATE/'plan.json', value)
                print(json.dumps({'mode': 'plan', 'sourceSets': len(value['sets']), 'backupDataWritten': False}))
            else:
                path = STATE/'plan.json'; protected(path)
                if path.stat().st_size>2*1024**2:
                    raise MigrationError('PLAN_TOO_LARGE')
                progress({'status': 'running', 'completedSets': 0})
                migrate(cloud, json.loads(path.read_text()), progress)
        return 0
    except (MigrationError, RetentionError, CryptoError, OSError, ValueError, KeyError,
            TypeError, subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, (MigrationError, RetentionError, CryptoError)) else type(error).__name__
        if args.command=='migrate':
            try:
                protected(STATE, directory=True)
                atomic_json(STATE/'last-run.json', {'status': 'failed', 'checkedAt': datetime.now(timezone.utc).isoformat(), 'code': code})
            except (OSError, RetentionError):
                pass
        print('legacy migration: FAILED '+code, file=sys.stderr); return 1


if __name__=='__main__':
    sys.exit(main())
