"""Pure/mocked checks: never read or change a live crontab or package database."""

import importlib.util
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('panel_autostart', Path(__file__).with_name('panel_autostart.py'))
panel = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(panel)


class PanelCronTests(unittest.TestCase):
    def test_pauses_only_active_panel_jobs(self):
        data = (f'# unchanged\n{panel.BACKUP_JOB}\n'
                '# old /usr/local/mgr5/sbin/mgrctl\n'
                '* * * * * /usr/local/mgr5/sbin/cron-ispmgr task\n').encode()
        after, count = panel.pause_panel_jobs(data)
        self.assertEqual(count, 1)
        self.assertIn(panel.BACKUP_JOB.encode() + b'\n', after)
        self.assertIn(b'# old /usr/local/mgr5/sbin/mgrctl\n', after)
        self.assertIn(panel.MARKER.encode() + b'* * * * * ', after)

    def test_preserves_crlf_and_trailing_comments(self):
        data = (panel.BACKUP_JOB + '\r\n@reboot /usr/local/mgr5/bin/core ispmgr # keep\r\n').encode()
        after, count = panel.pause_panel_jobs(data)
        self.assertEqual(count, 1)
        self.assertTrue(after.endswith(b'# keep\r\n'))

    def test_refuses_unknown_non_panel_jobs(self):
        with self.assertRaises(RuntimeError):
            panel.pause_panel_jobs((panel.BACKUP_JOB + '\n* * * * * /bin/unknown\n'
                                   '* * * * * /usr/local/mgr5/sbin/task\n').encode())

    def test_requires_exact_backup_schedule(self):
        with self.assertRaises(RuntimeError):
            panel.pause_panel_jobs(b'31 3 * * * /usr/local/bin/st24-backup.sh\n'
                                   b'* * * * * /usr/local/mgr5/sbin/task\n')

    def test_refuses_missing_or_duplicate_backup(self):
        for jobs in ['', panel.BACKUP_JOB + '\n' + panel.BACKUP_JOB + '\n']:
            with self.subTest(jobs=jobs), self.assertRaises(RuntimeError):
                panel.pause_panel_jobs((jobs + '* * * * * /usr/local/mgr5/sbin/task\n').encode())

    def test_does_not_match_panel_path_in_comment(self):
        with self.assertRaises(RuntimeError):
            panel.pause_panel_jobs((panel.BACKUP_JOB + '\n# /usr/local/mgr5/task\n').encode())

    def test_comment_only_cron_is_rejected(self):
        with self.assertRaises(RuntimeError):
            panel.pause_panel_jobs(b'# no active jobs\n')

    def test_all_panel_jobs_paused(self):
        data = (panel.BACKUP_JOB + '\n' + ''.join(
            f'{i} * * * * /usr/local/mgr5/sbin/task-{i}\n' for i in range(12))).encode()
        after, count = panel.pause_panel_jobs(data)
        self.assertEqual(count, 12)
        active = [s for s in after.decode().splitlines() if s and not s.startswith('#')]
        self.assertEqual(active, [panel.BACKUP_JOB])


class PanelGuardTests(unittest.TestCase):
    def test_command_failure_does_not_disclose_output(self):
        result = subprocess.CompletedProcess(['tool'], 2, b'secret stdout', b'secret stderr')
        with patch.object(panel.subprocess, 'run', return_value=result):
            with self.assertRaisesRegex(RuntimeError, r'^Command failed: tool \(exit 2\)$'):
                panel.run(['tool', 'private argument'])

    def test_override_not_found_is_not_an_error(self):
        result = subprocess.CompletedProcess([], 1, b'', b'')
        with patch.object(panel.subprocess, 'run', return_value=result):
            self.assertEqual(panel.override(), '')

    def test_accepted_snapshot_cannot_be_rolled_back(self):
        with patch.object(panel, 'state_of', return_value={'phase': 'accepted'}), \
             patch.object(panel, 'checked_daily') as checked:
            panel.rollback(Path('/unused'))
            checked.assert_not_called()

    def test_rollback_does_not_overwrite_independent_hook_change(self):
        state = {'phase': 'applying', 'dailyHash': panel.digest(b'original')}
        with tempfile.TemporaryDirectory() as directory:
            daily = Path(directory) / 'daily'
            daily.write_bytes(b'changed')
            with patch.object(panel, 'state_of', return_value=state), \
                 patch.object(panel, 'checked_daily'), patch.object(panel, 'DAILY', daily), \
                 patch.object(panel, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'independently changed daily hook'):
                    panel.rollback(Path(directory))
                command.assert_not_called()

    def test_symlink_hook_is_rejected(self):
        fake = type('Stat', (), {'st_mode': 0o120777, 'st_uid': 0, 'st_gid': 0})()
        with patch.object(Path, 'lstat', return_value=fake):
            with self.assertRaisesRegex(RuntimeError, 'type/owner'):
                panel.checked_daily()

    def test_non_root_hook_is_rejected(self):
        fake = type('Stat', (), {'st_mode': 0o100755, 'st_uid': 1000, 'st_gid': 0})()
        with patch.object(Path, 'lstat', return_value=fake):
            with self.assertRaisesRegex(RuntimeError, 'type/owner'):
                panel.checked_daily()

    def test_rollback_removes_override_and_explicitly_restores_mode(self):
        before = b'original cron\n'
        state = {'phase': 'applying', 'dailyHash': panel.digest(b'original'),
                 'dailyMode': 0o755, 'cronBeforeHash': panel.digest(before),
                 'cronAfterHash': panel.digest(b'paused cron\n'), 'cores': []}
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            daily = base / 'daily'
            daily.write_bytes(b'original')
            with patch.object(panel, 'state_of', return_value=state), \
                 patch.object(panel, 'checked_daily'), patch.object(panel, 'DAILY', daily), \
                 patch.object(panel, 'override', return_value=panel.OVERRIDE), \
                 patch.object(panel, 'cron', return_value=before), \
                 patch.object(panel, 'cores', return_value=[]), \
                 patch.object(panel, 'run') as command, \
                 patch.object(Path, 'chmod') as chmod:
                panel.rollback(base)
                self.assertEqual(command.call_args_list[0].args[0],
                                 ['dpkg-statoverride', '--remove', str(daily)])
                chmod.assert_any_call(0o755)
                self.assertEqual(state['phase'], 'rolled_back')

    def test_rollback_preserves_unrelated_override(self):
        state = {'phase': 'applying', 'dailyHash': panel.digest(b'original')}
        with tempfile.TemporaryDirectory() as directory:
            daily = Path(directory) / 'daily'
            daily.write_bytes(b'original')
            with patch.object(panel, 'state_of', return_value=state), \
                 patch.object(panel, 'checked_daily'), patch.object(panel, 'DAILY', daily), \
                 patch.object(panel, 'override', return_value='unrelated override'), \
                 patch.object(panel, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'unrelated statoverride'):
                    panel.rollback(Path(directory))
                command.assert_not_called()

    def test_manual_revert_still_refuses_independently_changed_hook(self):
        state = {'phase': 'accepted', 'dailyHash': panel.digest(b'original')}
        with tempfile.TemporaryDirectory() as directory:
            daily = Path(directory) / 'daily'
            daily.write_bytes(b'changed')
            with patch.object(panel, 'state_of', return_value=state), \
                 patch.object(panel, 'checked_daily'), patch.object(panel, 'DAILY', daily), \
                 patch.object(panel, 'run') as command:
                with self.assertRaisesRegex(RuntimeError, 'independently changed daily hook'):
                    panel.rollback(Path(directory), manual=True)
                command.assert_not_called()


@unittest.skipUnless(os.name == 'posix' and hasattr(os, 'geteuid') and os.geteuid() == 0
                     and all(shutil.which(x) for x in ('dpkg', 'dpkg-deb',
                                                      'dpkg-statoverride', 'run-parts')),
                     'isolated package test requires Linux root and dpkg/run-parts')
class IsolatedPackageTests(unittest.TestCase):
    def test_package_upgrade_preserves_nonexecutability_and_other_daily_jobs(self):
        # All package and override commands target a new temporary root only.
        # The dummy package has no dependencies or maintainer scripts.
        with tempfile.TemporaryDirectory(prefix='karcher-panel-test-') as directory:
            base = Path(directory)
            root, package = base / 'root', base / 'package'
            (root / 'var/lib/dpkg').mkdir(parents=True)
            (root / 'var/lib/dpkg/status').touch()
            (root / 'etc').mkdir()
            (root / 'etc/passwd').write_text('root:x:0:0:root:/root:/bin/sh\n')
            (root / 'etc/group').write_text('root:x:0:\n')
            (package / 'DEBIAN').mkdir(parents=True)
            daily = package / 'etc/cron.daily/phpsess_cron'
            daily.parent.mkdir(parents=True)
            (package / 'DEBIAN/conffiles').write_text('/etc/cron.daily/phpsess_cron\n')
            installed = root / 'etc/cron.daily/phpsess_cron'

            def install(version):
                (package / 'DEBIAN/control').write_text(
                    f'Package: karcher-panel-test\nVersion: {version}\n'
                    'Architecture: all\nMaintainer: Karcher test <test@example.invalid>\n'
                    'Description: isolated harmless cron fixture\n')
                daily.write_text(f'#!/bin/sh\n# version {version}\n: > "$0.ran"\n')
                daily.chmod(0o755)
                deb = base / f'fixture-{version}.deb'
                panel.run(['dpkg-deb', '--build', str(package), str(deb)])
                panel.run(['dpkg', f'--root={root}', '--force-confold', '--install', str(deb)])

            install('1.0')
            self.assertTrue(installed.stat().st_mode & 0o111)
            panel.run(['dpkg-statoverride', f'--root={root}', '--update', '--add',
                       'root', 'root', '0644', '/etc/cron.daily/phpsess_cron'])
            install('2.0')
            self.assertIn('version 2.0', installed.read_text())
            self.assertEqual(stat.S_IMODE(installed.stat().st_mode), 0o644)
            other = installed.with_name('backup_fixture')
            other.write_text('#!/bin/sh\n: > "$0.ran"\n')
            other.chmod(0o755)
            panel.run(['run-parts', str(installed.parent)])
            self.assertFalse(installed.with_suffix('.ran').exists())
            self.assertTrue(other.with_suffix('.ran').exists())


if __name__ == '__main__':
    unittest.main()
