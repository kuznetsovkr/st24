#!/usr/bin/env python3
"""Seal backup sets with an age public key; open them only on a recovery host."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


COMPONENTS = {'st24_db.dump', 'st24_files.tar.gz'}
CONTENTS = COMPONENTS | {'SHA256SUMS.txt'}
ENCRYPTED_FILES = {'backup.tar.age', 'MANIFEST.json'}
FORMAT = 'karcher-age-v1'


class CryptoError(ValueError):
    pass


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise CryptoError('REGULAR_FILE_REQUIRED')
    return path


def digest(path):
    with regular(path).open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def verify_checksums(directory, expected):
    sums = regular(directory/'SHA256SUMS.txt')
    if sums.stat().st_size > 4096:
        raise CryptoError('CHECKSUM_MANIFEST_INVALID')
    found = {}
    for line in sums.read_text(encoding='ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64}) [ *]([A-Za-z0-9_.-]+)', line)
        if not match or match[2] in found:
            raise CryptoError('CHECKSUM_MANIFEST_INVALID')
        found[match[2]] = match[1]
    if set(found) != expected:
        raise CryptoError('CHECKSUM_MANIFEST_INVALID')
    if any(digest(directory/name) != value for name, value in found.items()):
        raise CryptoError('CHECKSUM_MISMATCH')


def recipient_id(recipients):
    file = regular(recipients)
    if file.stat().st_size > 4096:
        raise CryptoError('RECIPIENT_INVALID')
    value = file.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'age1[0-9a-z]+', value):
        raise CryptoError('PUBLIC_X25519_RECIPIENT_REQUIRED')
    return hashlib.sha256((value+'\n').encode('ascii')).hexdigest()


def check_recipient(recipients, age):
    fingerprint = recipient_id(recipients)
    result = subprocess.run([age, '--encrypt', '-R', str(recipients)], input=b'backup-key-check',
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    if result.returncode:
        raise CryptoError('RECIPIENT_REJECTED_BY_AGE')
    return fingerprint


def prepare_output(directory):
    if directory.is_symlink():
        raise CryptoError('OUTPUT_SYMLINK_FORBIDDEN')
    if directory.exists():
        if not directory.is_dir() or any(directory.iterdir()):
            raise CryptoError('OUTPUT_MUST_BE_EMPTY')
    else:
        directory.mkdir(mode=0o700)


def seal(source, output, recipients, age='age'):
    if source.is_symlink() or not source.is_dir():
        raise CryptoError('SOURCE_DIRECTORY_INVALID')
    verify_checksums(source, COMPONENTS)
    fingerprint = check_recipient(recipients, age)
    prepare_output(output)
    # Stream the uncompressed outer tar directly into age. Never create a
    # plaintext bundle alongside the encrypted export that rclone uploads.
    with (output/'backup.tar.age').open('xb') as encrypted, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen([age, '--encrypt', '-R', str(recipients)],
                                   stdin=subprocess.PIPE, stdout=encrypted, stderr=errors)
        try:
            with tarfile.open(fileobj=process.stdin, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
                for name in sorted(CONTENTS):
                    archive.add(regular(source/name), arcname=name, recursive=False)
            process.stdin.close()
            if process.wait(timeout=600):
                raise CryptoError('ENCRYPTION_FAILED')
        except BaseException:
            if process.poll() is None:
                process.kill()
                process.wait()
            raise
    verify_checksums(source, COMPONENTS)
    manifest = {'format': FORMAT, 'recipientSha256': fingerprint,
                'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'contents': sorted(CONTENTS)}
    with (output/'MANIFEST.json').open('x', encoding='utf-8') as file:
        json.dump(manifest, file)
        file.write('\n')
    with (output/'SHA256SUMS.txt').open('x', encoding='ascii') as file:
        for name in sorted(ENCRYPTED_FILES):
            file.write(digest(output/name)+'  '+name+'\n')
    for path in output.iterdir():
        path.chmod(0o600)
    verify_checksums(output, ENCRYPTED_FILES)
    return manifest


def open_set(source, output, identity, age='age'):
    verify_checksums(source, ENCRYPTED_FILES)
    manifest_file = regular(source/'MANIFEST.json')
    if manifest_file.stat().st_size > 4096:
        raise CryptoError('ENCRYPTED_MANIFEST_INVALID')
    manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
    if (not isinstance(manifest, dict) or manifest.get('format') != FORMAT
            or manifest.get('contents') != sorted(CONTENTS)):
        raise CryptoError('ENCRYPTED_MANIFEST_INVALID')
    regular(identity)
    prepare_output(output)
    payload = output/'.decrypted-bundle.tar'
    with payload.open('xb') as file:
        result = subprocess.run([age, '--decrypt', '-i', str(identity), str(source/'backup.tar.age')],
                                stdout=file, stderr=subprocess.DEVNULL, timeout=600)
    if result.returncode:
        raise CryptoError('DECRYPTION_FAILED')
    # No extractall: even an encrypted archive must not select filesystem paths,
    # owners, permissions, symlink targets, devices, sparse files or duplicates.
    payload_size = payload.stat().st_size
    with tarfile.open(payload, mode='r:') as archive:
        members = archive.getmembers()
        if (len(members) != len(CONTENTS) or {m.name for m in members} != CONTENTS
                or any(not m.isfile() or m.issparse() or m.size < 0 for m in members)
                or sum(m.size for m in members) > payload_size):
            raise CryptoError('ARCHIVE_CONTENTS_INVALID')
        if shutil.disk_usage(output).free < sum(m.size for m in members):
            raise CryptoError('RECOVERY_DISK_SPACE_LOW')
        for member in members:
            with archive.extractfile(member) as incoming, (output/member.name).open('xb') as outgoing:
                shutil.copyfileobj(incoming, outgoing, length=1024*1024)
            (output/member.name).chmod(0o600)
    verify_checksums(output, COMPONENTS)
    payload.unlink()  # Only our own generated temporary file, after validation.
    return {'format': FORMAT, 'verified': True, 'components': len(CONTENTS)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ['check-recipient', 'seal', 'open']:
        command = commands.add_parser(name)
        command.add_argument('--age', default='age')
        if name in ['check-recipient', 'seal']:
            command.add_argument('--recipients', type=Path, required=True)
        if name in ['seal', 'open']:
            command.add_argument('--source', type=Path, required=True)
            command.add_argument('--output', type=Path, required=True)
        if name == 'open':
            command.add_argument('--identity', type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    if args.command == 'check-recipient':
        result = {'recipientSha256': check_recipient(args.recipients, args.age)}
    elif args.command == 'seal':
        result = seal(args.source, args.output, args.recipients, args.age)
    else:
        result = open_set(args.source, args.output, args.identity, args.age)
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # No age stderr, credentials, arbitrary exception strings or file data.
        code = str(error) if isinstance(error, CryptoError) else 'INTERNAL'
        print('backup crypto failed ['+code+']', file=sys.stderr)
        sys.exit(1)
