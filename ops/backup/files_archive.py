#!/usr/bin/env python3
"""Archive a verified private copy, not directories changed by health canaries.

This is a checked file copy, NOT a filesystem/DB transaction snapshot. Persistent
source changes fail closed. Only excluded entries and directory mtime/ctime,
size and link count (which also change with excluded children) are disregarded.
"""

import argparse
from dataclasses import dataclass
import fnmatch
import hashlib
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import tempfile


class ArchiveError(Exception):
    pass


@dataclass(frozen=True)
class Entry:
    identity: tuple
    portable: tuple
    hardlink: tuple | None


def excluded(name):
    return (name in {'node_modules', '.git', 'tmp'}
            or fnmatch.fnmatchcase(name, '.monitor-state.json*')
            or fnmatch.fnmatchcase(name, '.health-*.tmp'))


def stamp(info):
    common = (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
    if stat.S_ISDIR(info.st_mode):
        return common
    return common + (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def attributes(path):
    return tuple(sorted((name, os.getxattr(path, name, follow_symlinks=False))
                        for name in os.listxattr(path, follow_symlinks=False)))


def inspect(path):
    before = path.lstat()
    kind = stat.S_IFMT(before.st_mode)
    if kind not in {stat.S_IFDIR, stat.S_IFREG, stat.S_IFLNK}:
        raise ArchiveError('UNSUPPORTED_FILE_TYPE')
    attrs = attributes(path)
    payload = None
    if stat.S_ISREG(before.st_mode):
        # Nonblocking prevents a concurrent replacement with a FIFO hanging us.
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        with os.fdopen(fd, 'rb') as stream:
            if stamp(os.fstat(stream.fileno())) != stamp(before):
                raise ArchiveError('SOURCE_CHANGED_DURING_READ')
            payload = hashlib.file_digest(stream, 'sha256').digest()
            if stamp(os.fstat(stream.fileno())) != stamp(before):
                raise ArchiveError('SOURCE_CHANGED_DURING_READ')
    elif stat.S_ISLNK(before.st_mode):
        payload = os.readlink(path)
    after = path.lstat()
    if stamp(before) != stamp(after) or attrs != attributes(path):
        raise ArchiveError('SOURCE_CHANGED_DURING_READ')
    # Directory timestamps cannot distinguish a canary from a real child. The
    # complete included child inventory below is compared instead; ACLs remain.
    portable = (kind, stat.S_IMODE(before.st_mode), before.st_uid, before.st_gid,
                None if kind == stat.S_IFDIR else before.st_mtime_ns, attrs, payload)
    hardlink = (before.st_dev, before.st_ino) if kind == stat.S_IFREG else None
    return Entry(stamp(before), portable, hardlink)


def inventory(root, paths, *, filter_excluded=True):
    entries = {}

    def visit(relative):
        if relative in entries:
            return
        full = root / relative
        entry = inspect(full)
        entries[relative] = entry
        if entry.portable[0] == stat.S_IFDIR:
            # No symlink traversal. Failure to enumerate/read anything is fatal.
            with os.scandir(full) as children:
                names = sorted(child.name for child in children)
            for name in names:
                if not filter_excluded or not excluded(name):
                    visit(relative + '/' + name)
            if entry != inspect(full):
                raise ArchiveError('SOURCE_DIRECTORY_CHANGED')

    for relative in paths:
        parts = PurePosixPath(relative).parts
        if (not parts or relative != '/'.join(parts) or '..' in parts
                or PurePosixPath(relative).is_absolute() or '\0' in relative
                or any(excluded(part) for part in parts)):
            raise ArchiveError('INVALID_INPUT_PATH')
        # Selected roots cannot traverse a symlinked ancestor either.
        parent = root
        for part in parts[:-1]:
            parent /= part
            if not stat.S_ISDIR(parent.lstat().st_mode):
                raise ArchiveError('INPUT_PARENT_NOT_DIRECTORY')
        visit(relative)
    if not entries:
        raise ArchiveError('EMPTY_INPUT')
    return entries


def hardlink_groups(entries):
    groups = {}
    for name, entry in entries.items():
        if entry.hardlink is not None:
            groups.setdefault(entry.hardlink, []).append(name)
    return sorted(tuple(sorted(names)) for names in groups.values() if len(names) > 1)


def create_archive(root, output, paths, *, runner=subprocess.run):
    root = Path(root).resolve(strict=True)
    output = Path(os.path.abspath(output))
    before = inventory(root, paths)
    if output.exists() or output.is_symlink():
        raise ArchiveError('OUTPUT_ALREADY_EXISTS')
    # Never put the private copy inside a selected source tree.
    for name, entry in before.items():
        source = root / name
        if output == source or (entry.portable[0] == stat.S_IFDIR
                                and source in output.parents):
            raise ArchiveError('OUTPUT_INSIDE_SOURCE')
    manifest = b''.join(os.fsencode(name) + b'\0' for name in sorted(before))
    # Prefix only rsync input: its files-from parser treats leading #/; as
    # comments. GNU tar --null is verbatim and keeps historical member names.
    copy_manifest = b''.join(os.fsencode('./' + name) + b'\0' for name in sorted(before))
    with tempfile.TemporaryDirectory(prefix='.files-', dir=output.parent) as directory:
        os.chmod(directory, 0o700)
        snapshot = Path(directory)
        # Explicit manifest, NO recursion: excluded transient names are never
        # stat'ed/copied by rsync, even while they appear and disappear. -HAX
        # preserves hardlinks, ACLs/xattrs; symlinks are copied, not dereferenced.
        runner(['rsync', '-aHAX', '--numeric-ids', '--modify-window=-1', '--no-recursive', '--dirs',
                '--from0', '--files-from=-', '--', str(root) + '/', str(snapshot) + '/'],
               input=copy_manifest, check=True)
        copied = inventory(snapshot, paths, filter_excluded=False)
        if ({name: entry.portable for name, entry in copied.items()}
                != {name: entry.portable for name, entry in before.items()}
                or hardlink_groups(copied) != hardlink_groups(before)):
            raise ArchiveError('PRIVATE_COPY_MISMATCH')
        fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        runner(['tar', '--acls', '--xattrs', '--no-recursion', '--null',
                '--verbatim-files-from', '-czf', str(output), '-C', str(snapshot), '-T', '-'],
               input=manifest, check=True)
        # Catch real additions/removals/replacements, byte changes (even same
        # size/mtime), permission/ACL/link changes before declaring the set valid.
        if inventory(root, paths) != before:
            raise ArchiveError('SOURCE_CHANGED_DURING_ARCHIVE')
    return len(before)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        count = create_archive(args.root, args.output, args.paths)
    except (ArchiveError, OSError, subprocess.CalledProcessError) as error:
        # Do not put secret file contents, link targets or command arguments in
        # public cron output. External command diagnostics go to the private log.
        code = str(error) if isinstance(error, ArchiveError) else type(error).__name__
        print('files_archive: FAILED ' + code, file=sys.stderr)
        return 1
    print(f'files_archive: verified private copy, {count} entries archived')
    return 0


if __name__ == '__main__':
    sys.exit(main())
