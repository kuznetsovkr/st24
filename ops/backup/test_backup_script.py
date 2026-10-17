from pathlib import Path
import re
import subprocess
import tempfile
import unittest


class BackupScriptTests(unittest.TestCase):
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
