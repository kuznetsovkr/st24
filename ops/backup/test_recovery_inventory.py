import copy
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from recovery_inventory import (ArchiveError, COMMANDS, PACKAGE_QUERY, REQUIRED,
                                REQUIRED_DIRECTORIES, REQUIRED_LINKS, RecoveryError,
                                collect, packages, publish, query, select_paths, verify)


@unittest.skipUnless(sys.platform == 'linux', 'Linux host recovery configuration')
class RecoveryInventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in REQUIRED:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if name in REQUIRED_DIRECTORIES:
                path.mkdir(exist_ok=True)
                (path / 'test.conf').write_text('synthetic configuration\n')
            elif name in REQUIRED_LINKS:
                path.symlink_to(REQUIRED_LINKS[name])
            else:
                path.write_text('synthetic configuration\n')
        for name in ['etc/apt/auth.conf', 'root/.ssh/id_ed25519',
                     'root/.config/rclone/rclone.conf', 'root/.config/karcher-backup/identity.txt']:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('SYNTHETIC_NOT_FOR_BACKUP')
        self.package_text = ('nodejs\tii \t24.22.0-1\tamd64\n'
                             'libc6:amd64\tii \t2.39\tamd64\n'
                             'ispmanager-pkg-nginx\thi \t6.0\tall\n'
                             'removed\trc \t1.0\tall\n')
        self.calls = []
        self.backup_set = '2026-10-19_12-00-00_UTC'

    def read(self, command):
        self.calls.append(command)
        if command == PACKAGE_QUERY:
            return self.package_text
        if command == COMMANDS['appCommit']:
            return '4' * 40 + '\n'
        return 'synthetic read-only command output\n'

    def collect(self):
        return collect(self.root, self.backup_set, read=self.read,
                       accounts=lambda: {'service': {'uid': 999, 'gid': 996}})

    def test_full_inventory_records_versions_holds_and_config_hashes_without_secrets(self):
        document, selected = self.collect()
        names = {row['name'] for row in document['packages']}
        self.assertEqual(names, {'nodejs', 'libc6:amd64', 'ispmanager-pkg-nginx'})
        self.assertEqual(document['backupSet'], self.backup_set)
        self.assertEqual(document['format'], 'karcher-host-recovery-v1')
        self.assertTrue(set(REQUIRED) <= set(selected))
        self.assertNotIn('SYNTHETIC_NOT_FOR_BACKUP', json.dumps(document))
        self.assertFalse(any('auth.conf' in p or '/root/' in '/'+p for p in selected))
        row = next(row for row in document['configEntries'] if row['path']=='etc/redis/test.conf')
        self.assertEqual(len(row['sha256']), 64)
        self.assertIn('etc/netplan', document['absentOptionalPaths'])
        self.assertEqual(self.calls.count(PACKAGE_QUERY), 2)
        self.assertTrue(all(command in [PACKAGE_QUERY, *COMMANDS.values()] for command in self.calls))

    def test_missing_required_inputs_and_symlinked_config_roots_fail_closed(self):
        for name in ['usr/share/keyrings/nodesource.gpg', 'etc/apt/sources.list']:
            path = self.root / name
            data = path.read_bytes()
            path.unlink()
            with self.subTest(missing=name), self.assertRaises(OSError):
                self.collect()
            path.symlink_to('/outside/not-followed')
            with self.subTest(symlink=name), self.assertRaises(RecoveryError):
                self.collect()
            path.unlink()
            path.write_bytes(data)

    def test_required_directory_and_boot_link_types_cannot_be_weakened(self):
        path = self.root/'etc/redis'
        path.rename(self.root/'redis-original')
        path.symlink_to(self.root/'redis-original')
        with self.assertRaises(RecoveryError):
            self.collect()
        path.unlink()
        (self.root/'redis-original').rename(path)
        path = self.root / next(iter(REQUIRED_LINKS))
        path.unlink()
        path.symlink_to('/unexpected/timer')
        with self.assertRaises(RecoveryError):
            self.collect()

    def test_optional_os_references_and_only_exact_service_masks_are_selected(self):
        mask = self.root/'etc/systemd/system/retired.service'
        mask.symlink_to('/dev/null')
        unrelated = mask.with_name('unrelated.service')
        unrelated.write_text('NOT_SELECTED')
        (self.root/'etc/fstab').write_text('reference-only-uuid')
        document, selected = self.collect()
        self.assertIn('etc/fstab', selected)
        self.assertIn('etc/fstab', document['referenceOnlyRoots'])
        self.assertIn(mask.relative_to(self.root).as_posix(), selected)
        self.assertNotIn(unrelated.relative_to(self.root).as_posix(), selected)

    def test_packages_changed_or_half_installed_never_publish_a_valid_inventory(self):
        initial = self.read
        count = [0]
        def changed(command):
            value = initial(command)
            if command == PACKAGE_QUERY:
                count[0] += 1
                return value.replace('24.22.0', '24.23.0') if count[0]>1 else value
            return value
        with self.assertRaisesRegex(RecoveryError, 'PACKAGES_CHANGED'):
            collect(self.root, self.backup_set, read=changed, accounts=lambda: {})
        for state in ['iU ', 'iF ', 'iiR']:
            with self.subTest(state=state), self.assertRaises(RecoveryError):
                packages(f'nodejs\t{state}\t1\tamd64\n')

    def test_empty_duplicate_and_malformed_package_lists_are_rejected(self):
        for text in ['', 'bad row', self.package_text+self.package_text, '../path\tii \t1\tall\n']:
            with self.subTest(text=text[:12]), self.assertRaises(RecoveryError):
                packages(text)

    def test_post_archive_verification_detects_configs_packages_state_and_identity_changes(self):
        document, _ = self.collect()
        current, _ = self.collect()
        current['createdAt'] = 'later collection time'
        verify(document, current)
        for field in ['packages', 'configEntries', 'heldPackages', 'unitFiles', 'accounts', 'backupSet']:
            changed = copy.deepcopy(current)
            changed[field] = 'changed'
            with self.subTest(field=field), self.assertRaisesRegex(RecoveryError, 'RECOVERY_INPUTS_CHANGED'):
                verify(document, changed)
        (self.root/'etc/redis/test.conf').write_text('real changed config')
        changed, _ = self.collect()
        with self.assertRaises(RecoveryError):
            verify(document, changed)

    def test_inventory_command_failure_does_not_echo_arguments_or_stderr(self):
        with patch('recovery_inventory.subprocess.run') as run:
            run.return_value = subprocess.CompletedProcess(['cmd'],1,b'',b'SYNTHETIC_SECRET')
            with self.assertRaisesRegex(RecoveryError, '^INVENTORY_COMMAND_FAILED$'):
                query(('cmd','SYNTHETIC_SECRET'))
            self.assertEqual(run.call_args.kwargs['capture_output'], True)

    def test_transient_systemd_run_units_are_not_treated_as_boot_configuration(self):
        initial = self.read
        def read(command):
            if command == COMMANDS['unitFiles']:
                return 'temporary-backup.service transient -\nnginx.service enabled enabled\n'
            return initial(command)
        document,_ = collect(self.root,self.backup_set,read=read,accounts=lambda: {})
        self.assertEqual(document['unitFiles'],'nginx.service enabled enabled')

    def test_shell_producer_failure_is_not_hidden_by_mapfile(self):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        stage = re.search(r'^STAGE=system_recovery\n(.*?)^STAGE=database_dump', source, re.M | re.S)
        self.assertIsNotNone(stage)
        script = '''set -Eeuo pipefail
TOOLS_DIR=/unused
SET_NAME=synthetic
COMMAND_TIMEOUT_SECONDS=600
STAGING="$1"
LOG_ROOT="$1"
timeout() { printf 'partial-output\\0'; return 71; }
trap 'code=$?; printf "failed_stage=%s\\n" "$STAGE"; exit "$code"' ERR
STAGE=system_recovery
'''+stage[1]+'''printf 'UNSAFE_CONTINUATION\\n'
'''
        result = subprocess.run(['bash','-c',script,'test',str(self.root)],capture_output=True,text=True)
        self.assertEqual(result.returncode,71)
        self.assertIn('failed_stage=system_recovery',result.stdout)
        self.assertNotIn('UNSAFE_CONTINUATION',result.stdout)

    def test_private_atomic_publication_and_replacement(self):
        # /tmp is intentionally rejected by production's trusted-parent policy.
        with tempfile.TemporaryDirectory(prefix='.karcher-recovery-test-',dir=Path.home()) as home:
            output = Path(home)/'catalog'
            document, _ = self.collect()
            publish(output, document)
            path = output/'recovery.json'
            self.assertEqual(output.stat().st_mode & 0o777, 0o700)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(path.read_text()), document)
            document['backupSet'] = 'next-set'
            publish(output, document)
            self.assertEqual(json.loads(path.read_text())['backupSet'], 'next-set')
            self.assertEqual([p.name for p in output.iterdir()], ['recovery.json'])
            path.unlink()
            path.symlink_to(Path(home)/'not-for-writing')
            with self.assertRaises(RecoveryError):
                publish(output, document)
            self.assertFalse((Path(home)/'not-for-writing').exists())

    def test_failure_leaves_last_inventory_untouched(self):
        with tempfile.TemporaryDirectory(prefix='.karcher-recovery-test-',dir=Path.home()) as home:
            output = Path(home)/'catalog'
            document, _ = self.collect()
            publish(output, document)
            before = (output/'recovery.json').read_bytes()
            with patch('recovery_inventory.os.replace',side_effect=OSError('synthetic write failure')):
                with self.assertRaises(OSError):
                    publish(output, {'incomplete':'new'})
            self.assertEqual((output/'recovery.json').read_bytes(), before)
            self.assertEqual([p.name for p in output.iterdir()], ['recovery.json'])


if __name__ == '__main__':
    unittest.main()
