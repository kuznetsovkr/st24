import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('nginx_upgrade', Path(__file__).with_name('nginx_upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class NginxGuards(unittest.TestCase):
    def plan(self):
        return '\n'.join([*(f'Remv {name} [old]' for name in sorted(upgrade.REMOVED)),
                          f'Inst nginx [old] ({upgrade.NEW} nginx:stable [amd64])'])

    def test_approved_plan(self):
        upgrade.validate_plan(self.plan())

    def test_inventory_includes_held_installed_packages(self):
        with patch.object(upgrade, 'run', return_value='nginx\tii \tnew\nispmanager-pkg-nginx\thi \tmeta\nremoved\trc \told\n'):
            self.assertEqual(upgrade.inventory(), {'nginx': 'new', 'ispmanager-pkg-nginx': 'meta'})

    def test_other_removal_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\nRemv ispmanager-pkg-nginx [old]')

    def test_other_install_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\nInst openssl (other)')

    def test_missing_module_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan().replace('Remv libnginx-mod-mail [old]', ''))

    def test_purge_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\nPurg nginx-common')

    def test_unreviewed_version_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan().replace(upgrade.NEW, '9.9.9'))

    def test_foreign_policy_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy'
            path.write_bytes(b'foreign policy')
            with patch.object(upgrade, 'POLICY', path):
                for function in (upgrade.install_policy, upgrade.remove_policy):
                    with self.assertRaises(RuntimeError):
                        function()
            self.assertEqual(path.read_bytes(), b'foreign policy')

    @unittest.skipIf(not hasattr(__import__('os'), 'O_NOFOLLOW'), 'Linux-only secure open')
    def test_own_policy_roundtrip(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'policy'
            with patch.object(upgrade, 'POLICY', path):
                upgrade.install_policy()
                upgrade.install_policy()
                self.assertEqual(path.read_bytes(), upgrade.POLICY_BYTES)
                self.assertEqual(path.stat().st_mode & 0o777, 0o755)
                upgrade.remove_policy()
                self.assertFalse(path.exists())

    def test_nginx_changes_do_not_block_emergency_restore(self):
        import hashlib
        state = {'protected': {}, 'configs': {'/etc/nginx/nginx.conf': 'old'},
                 'cronHash': hashlib.sha256(b'cron').hexdigest()}
        with patch.object(upgrade, 'sha', return_value='changed'), patch.object(upgrade, 'run', return_value='cron'):
            with self.assertRaises(RuntimeError):
                upgrade.unchanged(state)
            upgrade.unchanged(state, include_nginx=False)

    def test_secret_changes_block_emergency_restore(self):
        state = {'protected': {}, 'configs': {'/etc/karcher/api.env': 'old'}}
        with patch.object(upgrade, 'sha', return_value='changed'):
            with self.assertRaises(RuntimeError):
                upgrade.unchanged(state, include_nginx=False)

    def test_accepted_state_never_auto_rolls_back(self):
        with patch.object(upgrade, 'load', return_value={'phase': 'accepted'}), \
                patch.object(upgrade, 'run') as run:
            upgrade.rollback()
            run.assert_not_called()

    def test_stop_requires_pid_file_to_disappear(self):
        with patch.object(upgrade, 'run'), \
                patch.object(upgrade, 'unit', return_value={'MainPID': '42'}):
            with self.assertRaises(RuntimeError):
                upgrade.stop_nginx()
        with patch.object(upgrade, 'run'), \
                patch.object(upgrade, 'unit', return_value={'MainPID': '0'}), \
                patch.object(upgrade.Path, 'exists', return_value=True):
            with self.assertRaises(RuntimeError):
                upgrade.stop_nginx()


if __name__ == '__main__':
    unittest.main()
