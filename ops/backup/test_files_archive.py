import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest

from files_archive import ArchiveError, create_archive, inventory


@unittest.skipUnless(sys.platform == 'linux', 'Linux rsync/ACL backup integration')
class FilesArchiveTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory(prefix='karcher-files-test-')
        self.addCleanup(self.workspace.cleanup)
        self.base = Path(self.workspace.name)
        self.root = self.base / 'source'
        self.root.mkdir()
        self.uploads = self.root / 'app/uploads'
        self.uploads.mkdir(parents=True)
        self.uploads.chmod(0o755)
        self.file = self.uploads / 'image.dat'
        self.file.write_bytes(b'image bytes')
        self.file.chmod(0o644)
        self.output = self.base / 'files.tar.gz'
        self.assertIsNotNone(shutil.which('rsync'), 'rsync is a required backup dependency')

    def archive(self, runner=subprocess.run, paths=None):
        return create_archive(self.root, self.output, paths or ['app'], runner=runner)

    def injected(self, *, after_copy=None, after_tar=None):
        def runner(command, **kwargs):
            result = subprocess.run(command, **kwargs)
            if command[0] == 'rsync' and after_copy:
                after_copy(command)
            if command[0] == 'tar' and after_tar:
                after_tar(command)
            return result
        return runner

    def test_exact_archive_modes_links_hardlinks_and_unusual_names(self):
        self.file.chmod(0o640)
        (self.uploads / 'alias.dat').hardlink_to(self.file)
        (self.uploads / 'external').symlink_to('/unrelated/private-key')
        for name in ['-option', '#comment', 'semi;colon', 'space name', 'line\nbreak', 'кириллица']:
            (self.uploads / name).write_bytes(os.fsencode(name))
        self.archive()
        with tarfile.open(self.output) as archive:
            names = set(archive.getnames())
            self.assertEqual(names, set(inventory(self.root, ['app'])))
            members = {member.name.removeprefix('./'): member for member in archive}
            self.assertEqual(members['app/uploads/image.dat'].mode, 0o640)
            self.assertTrue(members['app/uploads/external'].issym())
            self.assertEqual(members['app/uploads/external'].linkname, '/unrelated/private-key')
            self.assertTrue(any(member.islnk() for member in members.values()))
            self.assertEqual(archive.extractfile(members['app/uploads/image.dat']).read(), b'image bytes')
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(self.base.glob('.files-*')), [])

    def test_existing_exclusions_are_not_copied_or_archived(self):
        for name in ['node_modules', '.git', 'tmp']:
            directory = self.root / 'app' / name
            directory.mkdir()
            (directory / 'not-for-backup').write_text('excluded')
        for name in ['.health-test.tmp', '.monitor-state.json', '.monitor-state.json.new']:
            (self.uploads / name).write_text('excluded')
        self.archive()
        with tarfile.open(self.output) as archive:
            self.assertEqual({name.removeprefix('./') for name in archive.getnames()},
                             {'app', 'app/uploads', 'app/uploads/image.dat'})

    def test_top_level_names_are_literal_even_if_they_look_like_options_or_comments(self):
        paths = ['#comment', ';comment', '-C', 'line\nbreak']
        for name in paths:
            (self.root / name).write_text(name)
        self.archive(paths=paths)
        with tarfile.open(self.output) as archive:
            self.assertEqual(set(archive.getnames()), set(paths))
            for member in archive:
                self.assertEqual(archive.extractfile(member).read(), member.name.encode())

    @unittest.skipUnless(hasattr(os, 'geteuid') and os.geteuid() == 0, 'requires root for arbitrary UID/GID')
    def test_numeric_ownership_and_directory_acl_survive_copy_and_archive(self):
        os.chown(self.uploads, 12345, 23456)
        os.chown(self.file, 12345, 23456)
        self.archive()
        with tarfile.open(self.output) as archive:
            for name in ['app/uploads', 'app/uploads/image.dat']:
                member = archive.getmember(name)
                self.assertEqual((member.uid, member.gid), (12345, 23456))

    def test_continuous_health_churn_does_not_break_real_archive(self):
        # Both during rsync and tar, with thousands of create/unlink operations.
        self.file.write_bytes(b'x' * (8 * 1024 * 1024))
        stop = threading.Event()
        started = threading.Event()
        count = [0]

        def churn():
            path = self.uploads / '.health-concurrent.tmp'
            try:
                while not stop.is_set():
                    path.write_bytes(b'health')
                    path.unlink()
                    count[0] += 1
                    started.set()
            finally:
                path.unlink(missing_ok=True)

        thread = threading.Thread(target=churn)
        thread.start()
        try:
            self.assertTrue(started.wait(5))
            for index in range(3):
                self.output = self.base / f'files-{index}.tar.gz'
                self.archive()
                with tarfile.open(self.output) as archive:
                    self.assertFalse(any('.health-' in name for name in archive.getnames()))
        finally:
            stop.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertGreater(count[0], 10)

    def test_real_addition_removal_replacement_and_metadata_changes_fail(self):
        changes = {
            'new file': lambda: (self.uploads / 'new.dat').write_bytes(b'new'),
            'new directory': lambda: (self.uploads / 'new-folder').mkdir(),
            'removed file': lambda: self.file.unlink(),
            'file mode': lambda: self.file.chmod(0o600),
            'directory mode': lambda: self.uploads.chmod(0o700),
            'symlink replacement': lambda: (self.file.unlink(), self.file.symlink_to('/outside')),
            'same-size data and restored mtime': self.change_bytes_restore_mtime,
        }
        for name, change in changes.items():
            with self.subTest(change=name):
                # A fresh instance per mutation avoids interactions between cases.
                self.setUp()
                with self.assertRaises(ArchiveError):
                    self.archive(self.injected(after_tar=lambda _cmd: change()))

    def change_bytes_restore_mtime(self):
        before = self.file.stat()
        self.file.write_bytes(b'other bytes')  # same length as image bytes
        os.utime(self.file, ns=(before.st_atime_ns, before.st_mtime_ns))

    def test_copy_corruption_is_detected_even_with_restored_size_and_mtime(self):
        def corrupt(command):
            copied = Path(command[-1]) / 'app/uploads/image.dat'
            before = copied.stat()
            copied.write_bytes(b'other bytes')
            os.utime(copied, ns=(before.st_atime_ns, before.st_mtime_ns))
        with self.assertRaisesRegex(ArchiveError, 'PRIVATE_COPY_MISMATCH'):
            self.archive(self.injected(after_copy=corrupt))
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.base.glob('.files-*')), [])

    def test_unlisted_copy_entries_cannot_be_silently_archived(self):
        def add(command):
            (Path(command[-1]) / 'app/uploads/.health-not-from-source.tmp').write_text('extra')
        with self.assertRaisesRegex(ArchiveError, 'PRIVATE_COPY_MISMATCH'):
            self.archive(self.injected(after_copy=add))

    def test_rsync_failure_including_vanished_files_and_tar_failure_are_fatal(self):
        for failing, code in [('rsync', 24), ('rsync', 23), ('tar', 1), ('tar', 2)]:
            with self.subTest(command=failing, code=code):
                self.output.unlink(missing_ok=True)
                def runner(command, **kwargs):
                    if command[0] == failing:
                        raise subprocess.CalledProcessError(code, command)
                    return subprocess.run(command, **kwargs)
                with self.assertRaises(subprocess.CalledProcessError):
                    self.archive(runner)
                self.assertEqual(list(self.base.glob('.files-*')), [])

    def test_missing_inputs_and_invalid_paths_fail_closed(self):
        for path in ['missing', '../outside', '/absolute', 'app/../app', 'app//uploads', '.']:
            with self.subTest(path=path), self.assertRaises((ArchiveError, OSError)):
                self.archive(paths=[path])

    def test_symlinked_ancestor_is_not_followed(self):
        (self.root / 'linked').symlink_to(self.root / 'app', target_is_directory=True)
        with self.assertRaisesRegex(ArchiveError, 'INPUT_PARENT_NOT_DIRECTORY'):
            self.archive(paths=['linked/uploads'])

    def test_existing_outputs_and_output_inside_source_are_rejected(self):
        self.output.write_text('keep')
        with self.assertRaisesRegex(ArchiveError, 'OUTPUT_ALREADY_EXISTS'):
            self.archive()
        self.assertEqual(self.output.read_text(), 'keep')
        self.output = self.uploads / 'recursive.tar.gz'
        with self.assertRaisesRegex(ArchiveError, 'OUTPUT_INSIDE_SOURCE'):
            self.archive()

    def test_fifo_does_not_hang_or_become_a_silent_omission(self):
        os.mkfifo(self.uploads / 'fifo')
        with self.assertRaisesRegex(ArchiveError, 'UNSUPPORTED_FILE_TYPE'):
            self.archive()

    def test_xattrs_and_acl_roundtrip_and_changes(self):
        os.setxattr(self.file, 'user.backup-test', b'original xattr')
        if not shutil.which('setfacl'):
            self.fail('setfacl is required for the Linux ACL integration test')
        subprocess.run(['setfacl', '-m', 'u:65534:r--', str(self.uploads)], check=True)
        subprocess.run(['setfacl', '-m', 'u:65534:r--', str(self.file)], check=True)
        expected_acl = os.getxattr(self.uploads, 'system.posix_acl_access')
        expected_file_acl = os.getxattr(self.file, 'system.posix_acl_access')
        self.archive()
        restored = self.base / 'restored'
        restored.mkdir()
        subprocess.run(['tar', '--acls', '--xattrs', '-xzf', str(self.output), '-C', str(restored)],
                       check=True)
        self.assertEqual(os.getxattr(restored / 'app/uploads', 'system.posix_acl_access'), expected_acl)
        self.assertEqual(os.getxattr(restored / 'app/uploads/image.dat', 'system.posix_acl_access'),
                         expected_file_acl)
        self.assertEqual(os.getxattr(restored / 'app/uploads/image.dat', 'user.backup-test'),
                         b'original xattr')
        self.output.unlink()
        with self.assertRaises(ArchiveError):
            self.archive(self.injected(after_tar=lambda _cmd:
                         os.setxattr(self.uploads, 'user.changed', b'not a canary')))

    def test_cli_errors_do_not_print_file_contents_or_targets(self):
        self.file.unlink()
        self.file.symlink_to('/SYNTHETIC_PRIVATE_TARGET')
        result = subprocess.run([sys.executable, str(Path(__file__).with_name('files_archive.py')),
                                 '--root', str(self.root), '--output', str(self.output), 'missing'],
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn('SYNTHETIC_PRIVATE_TARGET', result.stderr)
        self.assertNotIn(str(self.root), result.stderr)
        self.assertIn('FileNotFoundError', result.stderr)


if __name__ == '__main__':
    unittest.main()
