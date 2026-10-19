import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('boot_maintenance', Path(__file__).with_name('boot_maintenance.py'))
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class BootGuards(unittest.TestCase):
    def rows(self):
        return [{'name': n, 'old': '1' if n in boot.UPGRADES else None, 'new': '2'}
                for n in sorted(boot.UPGRADES | boot.NEW)]

    def plan(self):
        return '\n'.join('Inst ' + r['name'] + (' [1]' if r['old'] else '') + ' (2 Ubuntu:24.04 [all])'
                         for r in self.rows())

    def test_exact_reviewed_firmware_transition(self):
        boot.validate_plan(self.plan(), self.rows())

    def test_removal_or_purge_forbidden(self):
        for operation in ['Remv coremanager', 'Purg linux-firmware']:
            with self.subTest(operation=operation), self.assertRaises(RuntimeError):
                boot.validate_plan(self.plan() + '\n' + operation, self.rows())

    def test_unreviewed_extra_install_forbidden(self):
        with self.assertRaises(RuntimeError):
            boot.validate_plan(self.plan() + '\nInst nginx (other)', self.rows())

    def test_installed_state_must_match(self):
        with self.assertRaises(RuntimeError):
            boot.validate_plan(self.plan().replace(' [1]', '', 1), self.rows())

    def test_missing_split_package_forbidden(self):
        with self.assertRaises(RuntimeError):
            boot.validate_plan('\n'.join(self.plan().splitlines()[:-1]), self.rows())

    def test_version_drift_forbidden(self):
        with self.assertRaises(RuntimeError):
            boot.validate_plan(self.plan().replace('(2 ', '(3 ', 1), self.rows())

    def test_manifest_cannot_expand_to_kernel_or_panel(self):
        for name in ['linux-image-generic', 'coremanager']:
            rows = self.rows()
            rows[0]['name'] = name
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                boot.validate_plan(self.plan(), rows)

    def test_offline_command_uses_versions_not_absolute_deb_paths(self):
        args = boot.plan_command(self.rows(), simulate=False)
        self.assertIn('--no-download', args)
        self.assertIn('--no-remove', args)
        self.assertNotIn('--only-upgrade', args)
        self.assertFalse(any(a.endswith('.deb') for a in args))

    def test_read_only_plan_has_no_install_confirmation(self):
        args = boot.plan_command(self.rows())
        self.assertIn('-s', args)
        self.assertNotIn('-y', args)

    def test_disabled_service_is_legitimate_enabled_query_result(self):
        class Result:
            stdout = 'disabled\n'
            returncode = 1
        with patch.object(boot.subprocess, 'run', return_value=Result()):
            self.assertEqual(boot.enabled('apparmor'), 'disabled')

    def test_cleanup_preserves_unrelated_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            policy = Path(directory) / 'policy'
            policy.write_bytes(b'foreign')
            with patch.object(boot, 'POLICY', policy), patch.object(boot, 'load', return_value={'timers': {}}):
                with self.assertRaises(RuntimeError):
                    boot.cleanup()
            self.assertEqual(policy.read_bytes(), b'foreign')

    def test_reboot_requires_validated_phase(self):
        with patch.object(boot, 'load', return_value={'phase': 'packages_applied'}), patch.object(boot, 'run') as run:
            with self.assertRaises(RuntimeError):
                boot.request_reboot()
            run.assert_not_called()

    def test_reboot_refuses_already_changed_boot(self):
        state = {'phase': 'boot_ready', 'bootBefore': 'old'}
        with patch.object(boot, 'load', return_value=state), patch.object(boot, 'boot_id', return_value='new'), \
                patch.object(boot, 'run') as run:
            with self.assertRaises(RuntimeError):
                boot.request_reboot()
            run.assert_not_called()

    def test_recovery_rejects_incomplete_or_changed_inventory(self):
        state = {'phase': 'applying', 'bootBefore': 'old', 'inventory': {}, 'rows': []}
        with patch.object(boot, 'load', return_value=state), patch.object(boot, 'boot_id', return_value='old'), \
                patch.object(boot, 'inventory', return_value={'unexpected': '1'}), \
                patch.object(boot, 'restore_triggered_initrds') as restore:
            with self.assertRaises(RuntimeError):
                boot.recover_packages()
            restore.assert_not_called()

    def test_recovery_never_reapplies_package_install(self):
        state = {'phase': 'applying', 'bootBefore': 'old', 'inventory': {}, 'rows': []}
        with patch.object(boot, 'load', return_value=state), patch.object(boot, 'boot_id', return_value='old'), \
                patch.object(boot, 'inventory', return_value={}), patch.object(boot, 'run', return_value='') as run, \
                patch.object(boot, 'restore_triggered_initrds'), patch.object(boot, 'unchanged'), \
                patch.object(boot, 'cleanup'), patch.object(boot, 'save'):
            boot.recover_packages()
            self.assertFalse(any('install' in args[0] for args, _ in run.call_args_list))


if __name__ == '__main__':
    unittest.main()
