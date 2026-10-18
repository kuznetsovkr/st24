from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
import unittest


class BackupScriptTests(unittest.TestCase):
    def managed_api_fixture(self, root):
        paths = {
            'etc/karcher/api.env': 'DATABASE_URL=postgresql://synthetic@localhost/shop\n',
            'etc/karcher/client.env': 'VITE_API_URL=https://shop.example.com\n',
            'etc/tmpfiles.d/karcher-api.conf': 'd /synthetic/uploads 0750 karcher-api karcher-api -\n',
            'etc/logrotate.d/karcher-api': '/synthetic/api.log {\n missingok\n}\n',
            'etc/systemd/system/karcher-api.service': '[Service]\nEnvironmentFile=/etc/karcher/api.env\n',
        }
        for name, content in paths.items():
            path = root/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        for name in ['etc/karcher/api.env', 'etc/karcher/client.env']:
            (root/name).chmod(0o640)
        boot = root/'etc/systemd/system/multi-user.target.wants/karcher-api.service'
        boot.parent.mkdir()
        boot.symlink_to('/etc/systemd/system/karcher-api.service')
        return set(paths) - {'etc/systemd/system/karcher-api.service'} | {str(boot.relative_to(root))}

    def collect_api(self, root, archive=None):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        function = re.search(r'^collect_api_paths\(\) \{\n.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(function)
        script = 'set -Eeuo pipefail\numask 077\nAPP_ROOT=/var/www/st24\n' + function.group(0)
        script += '\ncollect_api_paths "$1" >&2\n'
        if archive is not None:
            script += 'tar --acls --xattrs -czf "$2" -C "$1" "${API_BACKUP_PATHS[@]}"\n'
        script += 'printf "%s\\0" "$ENV_FILE" "${API_BACKUP_PATHS[@]}"\n'
        result = subprocess.run(
            ['bash', '-c', script, 'api-backup-test', str(root), str(archive or '')],
            capture_output=True, timeout=10,
        )
        values = list(filter(None, result.stdout.decode().split('\0')))
        return result, values

    def test_legacy_api_backup_uses_checkout_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            result, values = self.collect_api(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(values, [str(root/'var/www/st24/server/.env')])

    def test_pre_rename_or_mixed_layout_is_rejected_not_silently_backed_up(self):
        for mixed in [False, True]:
            with self.subTest(mixed=mixed), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                if mixed:
                    self.managed_api_fixture(root)
                old = root/'etc/her'
                old.mkdir(parents=True)
                result, _ = self.collect_api(root)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b'LEGACY_API_LAYOUT_REQUIRES_MIGRATION', result.stderr)

    def test_managed_api_archive_preserves_configs_modes_and_boot_state(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as output:
            root = Path(directory)
            expected = self.managed_api_fixture(root)
            archive = Path(output)/'managed-api.tar.gz'
            result, values = self.collect_api(root, archive)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(values[0], str(root/'etc/karcher/api.env'))
            self.assertEqual(set(values[1:]), expected)
            with tarfile.open(archive) as tar:
                self.assertEqual(set(tar.getnames()), expected)
                self.assertEqual(tar.getmember('etc/karcher/api.env').mode, 0o640)
                self.assertTrue(tar.getmember(
                    'etc/systemd/system/multi-user.target.wants/karcher-api.service').issym())

    def test_partial_managed_api_install_cannot_fall_back_to_stale_environment(self):
        for missing in ['etc/karcher/api.env', 'etc/karcher/client.env',
                        'etc/tmpfiles.d/karcher-api.conf', 'etc/logrotate.d/karcher-api']:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.managed_api_fixture(root)
                (root/missing).unlink()
                result, _ = self.collect_api(root)
                self.assertNotEqual(result.returncode, 0)

    def test_managed_api_unit_detects_loss_of_configuration_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            unit = root/'etc/systemd/system/karcher-api.service'
            unit.parent.mkdir(parents=True)
            unit.write_text('[Service]\nEnvironmentFile=/etc/karcher/api.env\n')
            result, _ = self.collect_api(root)
            self.assertNotEqual(result.returncode, 0)

    def test_managed_api_configuration_symlinks_are_rejected(self):
        for relative in ['etc/karcher', 'etc/karcher/api.env', 'etc/karcher/client.env',
                         'etc/tmpfiles.d/karcher-api.conf', 'etc/logrotate.d/karcher-api']:
            with self.subTest(path=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.managed_api_fixture(root)
                path = root/relative
                moved = path.with_name(path.name+'.original')
                path.rename(moved)
                path.symlink_to(moved, target_is_directory=moved.is_dir())
                result, _ = self.collect_api(root)
                self.assertNotEqual(result.returncode, 0)

    def test_managed_api_boot_link_requires_the_expected_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.managed_api_fixture(root)
            link = root/'etc/systemd/system/multi-user.target.wants/karcher-api.service'
            link.unlink()
            link.symlink_to('/unexpected/unit.service')
            result, _ = self.collect_api(root)
            self.assertNotEqual(result.returncode, 0)

    def test_production_archive_includes_managed_api_paths_and_acl_metadata(self):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        self.assertIn('collect_api_paths /', source)
        self.assertIn('"${API_BACKUP_PATHS[@]}"', source)
        self.assertIn('--acls --xattrs', source)

    def security_fixture(self, root):
        files = {
            'etc/ssh/sshd_config': 'Include /etc/ssh/sshd_config.d/*.conf\n',
            'etc/ssh/sshd_config.d/00-karcher-access.conf': 'AuthenticationMethods publickey\n',
            'etc/ssh/sshd_config.d/40-hosting.conf': 'PubkeyAuthentication yes\n',
            'root/.ssh/authorized_keys': 'ssh-ed25519 synthetic-public-key test-only\n',
            'etc/karcher-security/inbound.nft': 'table inet karcher_ingress {}\n',
            'usr/local/lib/karcher-security/load-firewall.sh': '#!/bin/sh\nexit 0\n',
            'etc/systemd/system/karcher-firewall.service': '[Service]\nType=oneshot\n',
            'etc/karcher-backup/security-required': '',
            # These are NOT selected, even when they are beside selected files.
            'etc/ssh/ssh_host_ed25519_key': 'SYNTHETIC_HOST_PRIVATE_KEY_NOT_TO_ARCHIVE',
            'etc/ssh/sshd_config.d/old-private.key': 'SYNTHETIC_UNRELATED_PRIVATE_FILE',
            'root/.ssh/id_ed25519': 'SYNTHETIC_OPERATOR_PRIVATE_KEY_NOT_TO_ARCHIVE',
            'root/.config/karcher-backup/identity.txt': 'SYNTHETIC_AGE_PRIVATE_KEY_NOT_TO_ARCHIVE',
        }
        for name, data in files.items():
            path = root/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
        (root/'root/.ssh/authorized_keys').chmod(0o600)
        links = {
            'etc/systemd/system/multi-user.target.wants/karcher-firewall.service':
                '/etc/systemd/system/karcher-firewall.service',
            'etc/systemd/system/nftables.service': '/dev/null',
        }
        for name, target in links.items():
            path = root/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.symlink_to(target)
        return set(files) - {
            'etc/karcher-backup/security-required',
            'etc/ssh/ssh_host_ed25519_key',
            'etc/ssh/sshd_config.d/old-private.key',
            'root/.ssh/id_ed25519',
            'root/.config/karcher-backup/identity.txt',
        } | set(links)

    def collect_security(self, root, archive=None):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        function = re.search(r'^collect_security_paths\(\) \{\n.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(function)
        script = 'set -Eeuo pipefail\numask 077\n' + function.group(0)
        script += '\ncollect_security_paths "$1" >&2\n'
        if archive is not None:
            script += 'tar -czf "$2" -C "$1" "${SECURITY_BACKUP_PATHS[@]}"\n'
        script += 'printf "%s\\0" "${SECURITY_BACKUP_PATHS[@]}"\n'
        result = subprocess.run(
            ['bash', '-c', script, 'security-backup-test', str(root), str(archive or '')],
            capture_output=True, timeout=10,
        )
        paths = set(filter(None, result.stdout.decode().split('\0')))
        return result, paths

    def test_security_is_optional_on_a_host_where_it_was_never_installed(self):
        with tempfile.TemporaryDirectory() as directory:
            result, paths = self.collect_security(Path(directory))
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(paths, set())

    def test_complete_security_inputs_include_boot_state_but_not_private_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.security_fixture(root)
            result, paths = self.collect_security(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(paths, expected)

    def test_required_marker_rejects_loss_of_all_security_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            marker = root/'etc/karcher-backup/security-required'
            marker.parent.mkdir(parents=True)
            marker.touch()
            result, _ = self.collect_security(root)
            self.assertNotEqual(result.returncode, 0)

    def test_partial_security_install_cannot_silently_skip_missing_components(self):
        for missing in [
            'etc/ssh/sshd_config',
            'etc/ssh/sshd_config.d/00-karcher-access.conf',
            'root/.ssh/authorized_keys',
            'etc/karcher-security/inbound.nft',
            'usr/local/lib/karcher-security/load-firewall.sh',
            'etc/systemd/system/karcher-firewall.service',
            'etc/systemd/system/multi-user.target.wants/karcher-firewall.service',
        ]:
            with self.subTest(missing=missing), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.security_fixture(root)
                (root/missing).unlink()
                result, _ = self.collect_security(root)
                self.assertNotEqual(result.returncode, 0)

    def test_security_file_symlinks_are_not_followed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.security_fixture(root)
            path = root/'etc/karcher-security/inbound.nft'
            path.unlink()
            path.symlink_to(root/'etc/ssh/ssh_host_ed25519_key')
            result, _ = self.collect_security(root)
            self.assertNotEqual(result.returncode, 0)

    def test_security_directory_symlinks_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.security_fixture(root)
            path = root/'etc/karcher-security'
            path.rename(root/'moved-security')
            path.symlink_to(root/'moved-security', target_is_directory=True)
            result, _ = self.collect_security(root)
            self.assertNotEqual(result.returncode, 0)

    def test_symlinked_ssh_dropins_and_required_markers_are_rejected(self):
        for relative in [
            'etc/ssh/sshd_config.d/40-hosting.conf',
            'etc/karcher-backup/security-required',
        ]:
            with self.subTest(path=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                self.security_fixture(root)
                path = root/relative
                path.unlink()
                path.symlink_to(root/'etc/ssh/ssh_host_ed25519_key')
                result, _ = self.collect_security(root)
                self.assertNotEqual(result.returncode, 0)

    def test_firewall_mask_requires_the_exact_dev_null_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.security_fixture(root)
            path = root/'etc/systemd/system/nftables.service'
            path.unlink()
            path.symlink_to('/etc/systemd/system/karcher-firewall.service')
            result, _ = self.collect_security(root)
            self.assertNotEqual(result.returncode, 0)

    def test_firewall_conf_dropins_are_included_but_unrelated_files_are_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = self.security_fixture(root)
            folder = root/'etc/systemd/system/karcher-firewall.service.d'
            folder.mkdir()
            (folder/'10-local.conf').write_text('[Service]\nTimeoutStartSec=40s\n')
            (folder/'unrelated.private').write_text('SYNTHETIC_UNRELATED_FILE')
            result, paths = self.collect_security(root)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(paths, expected | {'etc/systemd/system/karcher-firewall.service.d/10-local.conf'})

    def test_real_security_archive_preserves_public_key_mode_and_symlink_metadata(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as output:
            root = Path(directory)
            expected = self.security_fixture(root)
            archive = Path(output)/'security.tar.gz'
            result, _ = self.collect_security(root, archive)
            self.assertEqual(result.returncode, 0, result.stderr)
            with tarfile.open(archive) as tar:
                self.assertEqual(set(tar.getnames()), expected)
                self.assertEqual(tar.getmember('root/.ssh/authorized_keys').mode, 0o600)
                mask = tar.getmember('etc/systemd/system/nftables.service')
                self.assertTrue(mask.issym())
                self.assertEqual(mask.linkname, '/dev/null')
                enabled = tar.getmember('etc/systemd/system/multi-user.target.wants/karcher-firewall.service')
                self.assertTrue(enabled.issym())
                self.assertEqual(enabled.linkname, '/etc/systemd/system/karcher-firewall.service')

    def test_failure_and_running_states_preserve_last_verified_checkpoint(self):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        function = re.search(r'^write_status\(\) \{\n.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(function)
        with tempfile.TemporaryDirectory() as directory:
            script = '''set -Eeuo pipefail
umask 077
BACKUP_ROOT="$1"
STARTED_AT=2026-10-17T00:00:00Z
DST=/synthetic/2026-10-17_00-00-00_UTC
STAGE=complete
'''
            script += function.group(0)
            script += '''
write_status verified
cp "$BACKUP_ROOT/.last-success.json" "$BACKUP_ROOT/expected.json"
STAGE=offsite_copy
write_status failed
cmp "$BACKUP_ROOT/expected.json" "$BACKUP_ROOT/.last-success.json"
write_status running
cmp "$BACKUP_ROOT/expected.json" "$BACKUP_ROOT/.last-success.json"
'''
            subprocess.run(['bash', '-c', script, 'backup-test', directory],
                           capture_output=True, text=True, timeout=10, check=True)
            checkpoint = Path(directory)/'.last-success.json'
            import json
            self.assertEqual(json.loads(checkpoint.read_text())['status'], 'verified')
            self.assertEqual(json.loads((Path(directory)/'.last-run.json').read_text())['status'], 'running')
            self.assertEqual(checkpoint.stat().st_mode & 0o777, 0o600)

    def run_verification(self, failures):
        # Exercise the exact shell function from production, without sourcing
        # initialization or touching production paths. Only external calls are mocked.
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        function = re.search(r'^verify_offsite\(\) \{\n.*?^\}', source, re.M | re.S)
        self.assertIsNotNone(function)
        with tempfile.TemporaryDirectory() as directory:
            script = '''set -Eeuo pipefail
umask 077
LOG_ROOT="$1"
SET_NAME=synthetic-set
DST=/unused/local
OFFSITE_SOURCE=/unused/encrypted
REMOTE=unused:remote
COMMAND_TIMEOUT_SECONDS=600
FAILURES="$2"
calls=0
waits=0
timeout() {
  calls=$((calls + 1))
  [[ " $* " == *" --download "* && " $* " == *" --one-way "* ]] || return 99
  [[ " $* " == *" rclone check $OFFSITE_SOURCE "* ]] || return 99
  [[ "$calls" -gt "$FAILURES" ]]
}
'''
            script += '\nsleep() { waits=$((waits + 1)); }\n' + function.group(0)
            script += '''
if verify_offsite; then status=0; else status=$?; fi
printf '%s %s %s\\n' "$status" "$calls" "$waits"
'''
            result = subprocess.run(['bash', '-c', script, 'backup-test', directory, str(failures)],
                                    capture_output=True, text=True, timeout=10, check=True)
            log = Path(directory)/'synthetic-set.check.log'
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            return result.stdout.strip(), log.read_text()

    def test_transient_download_failures_are_retried_until_a_complete_success(self):
        output, log = self.run_verification(2)
        self.assertEqual(output, '0 3 2')
        self.assertEqual(log.count('download verification attempt='), 3)

    def test_persistent_failure_is_not_misreported_as_a_verified_backup(self):
        output, log = self.run_verification(99)
        self.assertEqual(output, '1 3 2')
        self.assertEqual(log.count('download verification attempt='), 3)

    def test_immediate_success_does_not_sleep_or_repeat_network_work(self):
        output, log = self.run_verification(0)
        self.assertEqual(output, '0 1 0')
        self.assertEqual(log.count('download verification attempt='), 1)

    def test_offsite_commands_only_use_encrypted_exports(self):
        source = Path(__file__).with_name('karcher-backup.sh').read_text()
        inputs = re.findall(r'rclone (?:copy|check) "([^"]+)"', source)
        self.assertEqual(inputs, ['$OFFSITE_SOURCE', '$OFFSITE_SOURCE'])
        self.assertIn('readonly REMOTE=yadisk:karcher-backups-encrypted/v1', source)
        self.assertIn('STAGE=encryption_configuration', source)
        self.assertNotIn('|| true', source[source.index('STAGE=encryption\n'):])


if __name__ == '__main__':
    unittest.main()
