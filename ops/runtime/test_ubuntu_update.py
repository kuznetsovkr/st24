import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ubuntu_update', Path(__file__).with_name('ubuntu_update.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UbuntuGuards(unittest.TestCase):
    def rows(self):
        return [{'package': n, 'old': '1.0', 'new': '1.1'} for n in sorted(upgrade.EXPECTED)]

    def plan(self):
        return '\n'.join(f'Inst {r["package"]} [1.0] (1.1 Ubuntu:24.04/noble-updates [amd64])'
                         for r in self.rows())

    def test_reviewed_exact_upgrade(self):
        upgrade.validate_plan(self.plan(), self.rows())

    def test_deferred_versions_are_explicitly_frozen_without_holds(self):
        command = upgrade.apt_command(self.rows())
        for name, version in upgrade.FROZEN.items():
            self.assertIn(name + '=' + version, command)
        self.assertTrue(set(upgrade.FROZEN).isdisjoint(upgrade.EXPECTED))

    def test_firmware_install_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\nInst linux-firmware-extra (new)', self.rows())

    def test_isp_package_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\nInst coremanager [old] (new)', self.rows())

    def test_removal_and_purge_denied(self):
        for operation in ['Remv nginx', 'Purg nginx-common']:
            with self.subTest(operation=operation), self.assertRaises(RuntimeError):
                upgrade.validate_plan(self.plan() + '\n' + operation, self.rows())

    def test_mismatched_versions_denied(self):
        for wrong in [self.plan().replace('(1.1 ', '(1.2 ', 1), self.plan().replace('[1.0]', '[0.9]', 1)]:
            with self.assertRaises(RuntimeError):
                upgrade.validate_plan(wrong, self.rows())

    def test_duplicate_install_denied(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan(self.plan() + '\n' + self.plan().splitlines()[0], self.rows())

    def test_boot_policy_selection_denied(self):
        for name in ['apparmor', 'keyboard-configuration', 'linux-image-generic']:
            rows = self.rows()
            rows[0]['package'] = name
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                upgrade.validate_plan(self.plan(), rows)

    def test_held_installed_packages_retained(self):
        with patch.object(upgrade, 'run', return_value='nginx\tii \tnew\nwrapper\thi \told\nremoved\trc \told\n'):
            self.assertEqual(upgrade.inventory(), {'nginx': 'new', 'wrapper': 'old'})

    def test_native_multiarch_names_match_apt_but_foreign_stays_distinct(self):
        with patch.object(upgrade, 'run', return_value='libaudit1:amd64\tii \t1\nlibaudit1:i386\tii \t2\n'):
            self.assertEqual(upgrade.inventory(), {'libaudit1': '1', 'libaudit1:i386': '2'})

    def test_cleanup_preserves_foreign_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'policy'
            policy.write_bytes(b'foreign')
            with patch.object(upgrade, 'POLICY', policy), \
                    patch.object(upgrade, 'load', return_value={'timers': {}}):
                with self.assertRaises(RuntimeError):
                    upgrade.cleanup()
            self.assertEqual(policy.read_bytes(), b'foreign')

    def test_cleanup_restores_only_previously_active_timers(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'policy'
            policy.write_bytes(upgrade.POLICY_BYTES)
            state = {'timers': {'daily.timer': 'active', 'disabled.timer': 'inactive'}}
            with patch.object(upgrade, 'POLICY', policy), patch.object(upgrade, 'load', return_value=state), \
                    patch.object(upgrade, 'unit', return_value={'ActiveState': 'inactive'}), \
                    patch.object(upgrade, 'run') as run:
                upgrade.cleanup()
                run.assert_called_once_with(['systemctl', 'start', 'daily.timer'], 'resume-daily.timer')
            self.assertFalse(policy.exists())

    def test_boot_configuration_drift_denied(self):
        state = {'services': {}, 'configs': {'/boot/grub/grub.cfg': 'before'}}
        with patch.object(upgrade, 'sha', return_value='after'):
            with self.assertRaises(RuntimeError):
                upgrade.unchanged(state)


if __name__ == '__main__':
    unittest.main()
