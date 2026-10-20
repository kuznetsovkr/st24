#!/usr/bin/env python3
"""Authenticate legacy exports with a LOCAL identity, discarding all plaintext.

No extraction, restore, network access, or files written. Identity is passed only
to the local age process. Metadata/results never contain decrypted backup data.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile

from encrypted_backup import (CONTENTS, ENCRYPTED_FILES, FORMAT, CryptoError,
                              digest, regular, verify_checksums)


def verify_export(source, identity, age='age'):
    if source.is_symlink() or not source.is_dir():
        raise CryptoError('SOURCE_DIRECTORY_INVALID')
    if {p.name for p in source.iterdir()} != ENCRYPTED_FILES|{'SHA256SUMS.txt'}:
        raise CryptoError('EXPORT_CONTENTS_INVALID')
    verify_checksums(source, ENCRYPTED_FILES)
    file = regular(source/'MANIFEST.json')
    if file.stat().st_size>4096:
        raise CryptoError('ENCRYPTED_MANIFEST_INVALID')
    manifest = json.loads(file.read_text(encoding='utf-8'))
    if (not isinstance(manifest, dict) or manifest.get('format')!=FORMAT
            or manifest.get('contents')!=sorted(CONTENTS)):
        raise CryptoError('ENCRYPTED_MANIFEST_INVALID')
    legacy = manifest.get('legacySource')
    if (not isinstance(legacy, dict) or legacy.get('backupSet')!=source.name
            or not re.fullmatch(r'\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_UTC)?', source.name)
            or legacy.get('sourceRemote')!='yadisk:st24-backups/'+source.name
            or not isinstance(legacy.get('componentsSha256'), dict)
            or set(legacy['componentsSha256'])!=CONTENTS
            or not isinstance(legacy.get('componentsBytes'), dict)
            or set(legacy['componentsBytes'])!=CONTENTS
            or any(not isinstance(h, str) or not re.fullmatch(r'[0-9a-f]{64}', h)
                   for h in legacy['componentsSha256'].values())
            or any(type(n) is not int or n<=0 for n in legacy['componentsBytes'].values())):
        raise CryptoError('LEGACY_PROVENANCE_INVALID')
    regular(identity)
    process = subprocess.Popen([str(age), '--decrypt', '-i', str(identity), str(source/'backup.tar.age')],
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    hashes = {}
    checksum_bytes = b''
    try:
        with tarfile.open(fileobj=process.stdout, mode='r|') as archive:
            for member in archive:
                if (member.name not in CONTENTS or member.name in hashes or not member.isfile()
                        or member.issparse() or member.size!=legacy['componentsBytes'][member.name]
                        or member.name=='SHA256SUMS.txt' and member.size>4096):
                    raise CryptoError('ARCHIVE_CONTENTS_INVALID')
                value = hashlib.sha256()
                with archive.extractfile(member) as stream:
                    while chunk:=stream.read(1024*1024):
                        value.update(chunk)
                        if member.name=='SHA256SUMS.txt':
                            checksum_bytes += chunk
                hashes[member.name] = value.hexdigest()
        # tar ends before age necessarily authenticates the final ciphertext
        # chunk. Drain the pipe AND check age's exit status, not just tar EOF.
        while process.stdout.read(1024*1024):
            pass
        if process.wait(timeout=60):
            raise CryptoError('AGE_AUTHENTICATION_FAILED')
        if hashes!=legacy['componentsSha256']:
            raise CryptoError('DECRYPTED_SOURCE_MISMATCH')
        lines = checksum_bytes.decode('ascii').splitlines()
        parsed = {}
        for line in lines:
            match = re.fullmatch(r'([0-9a-f]{64}) [ *]([A-Za-z0-9_.-]+)', line)
            if not match or match[2] in parsed:
                raise CryptoError('CHECKSUM_MANIFEST_INVALID')
            parsed[match[2]] = match[1]
        if parsed!={key: hashes[key] for key in CONTENTS-{'SHA256SUMS.txt'}}:
            raise CryptoError('INNER_CHECKSUM_MISMATCH')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        process.stdout.close()
    return {'backupSet': source.name, 'verified': True, 'ageAuthentication': True,
            'sourceBytesMatched': sum(legacy['componentsBytes'].values()),
            'componentsSha256': hashes, 'ciphertextSha256': digest(source/'backup.tar.age'),
            'plaintextWritten': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--identity', type=Path, required=True)
    parser.add_argument('--age', default='age')
    parser.add_argument('--expected-count', type=int, required=True)
    args = parser.parse_args()
    if args.root.is_symlink() or not args.root.is_dir():
        raise CryptoError('SOURCE_DIRECTORY_INVALID')
    sets = sorted(args.root.iterdir())
    if not sets or len(sets)!=args.expected_count:
        raise CryptoError('LEGACY_SET_COUNT_MISMATCH')
    for directory in sets:
        print(json.dumps(verify_export(directory, args.identity, args.age)), flush=True)
    print(json.dumps({'verifiedSets': len(sets), 'plaintextWritten': False}))


if __name__=='__main__':
    try:
        main()
    except (CryptoError, OSError, ValueError, KeyError, TypeError, tarfile.TarError,
            subprocess.TimeoutExpired) as error:
        code = str(error) if isinstance(error, CryptoError) else type(error).__name__
        print('legacy verification: FAILED '+code, file=sys.stderr)
        sys.exit(1)
