import importlib.util
import os
from pathlib import Path
import re
import shutil
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('node_upgrade', Path(__file__).with_name('node_upgrade.py'))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class PackagePlanTests(unittest.TestCase):
    def test_accepts_only_reviewed_single_upgrade(self):
        upgrade.validate_plan('1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.\n'
                              'Inst nodejs [20.20.0] (24.22.0 nodistro [amd64])\nConf nodejs\n')

    def test_rejects_removal_or_other_package(self):
        for extra in ['Remv nginx', 'Purg coremanager', 'Inst openssh-server (new)',
                      'Inst nodejs (another copy)']:
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                upgrade.validate_plan('1 upgraded, 0 newly installed, 0 to remove\n'
                                      'Inst nodejs (24.22.0)\n' + extra + '\n')

    def test_rejects_install_without_existing_runtime(self):
        with self.assertRaises(RuntimeError):
            upgrade.validate_plan('0 upgraded, 1 newly installed, 0 to remove\nInst nodejs (24.22.0)\n')

    def test_rejects_empty_or_failed_simulation(self):
        for text in ['', 'E: Unmet dependencies', 'Nothing to do']:
            with self.subTest(text=text), self.assertRaises(RuntimeError):
                upgrade.validate_plan(text)

    def test_install_and_rollback_use_exact_local_artifact_without_network_resolver(self):
        for version in (upgrade.OLD, upgrade.NEW):
            args = upgrade.package_command(version)
            self.assertEqual(args[:3], ['dpkg', '--force-confold', '--install'])
            self.assertEqual(len(args), 4)
            self.assertTrue(args[-1].endswith('nodejs_' + version + '_amd64.deb'))

    def test_unreviewed_package_cannot_be_selected(self):
        for value in ('26.0.0', '../../nginx', '', upgrade.NEW + ' extra'):
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                upgrade.package_command(value)


class RollbackGuardTests(unittest.TestCase):
    def test_accepted_switch_does_not_automatically_roll_back(self):
        with patch.object(upgrade, 'load', return_value={'phase': 'accepted'}), \
             patch.object(upgrade, 'check_artifacts') as check, \
             patch.object(upgrade, 'run') as command:
            upgrade.rollback()
            check.assert_not_called()
            command.assert_not_called()


    def test_unreviewed_installed_version_is_not_changed(self):
        with patch.object(upgrade, 'load', return_value={'phase': 'applied'}), \
             patch.object(upgrade, 'check_artifacts'), \
             patch.object(upgrade, 'version', return_value='26.0.0'), \
             patch.object(upgrade, 'unchanged') as unchanged, \
             patch.object(upgrade, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'Unreviewed installed Node'):
                upgrade.rollback()
            unchanged.assert_not_called()
            command.assert_not_called()

    def test_manual_rollback_still_guards_independent_config_changes(self):
        with patch.object(upgrade, 'load', return_value={'phase': 'accepted'}), \
             patch.object(upgrade, 'check_artifacts'), \
             patch.object(upgrade, 'version', return_value=upgrade.NEW), \
             patch.object(upgrade, 'unchanged', side_effect=RuntimeError('Protected config changed')), \
             patch.object(upgrade, 'run') as command:
            with self.assertRaisesRegex(RuntimeError, 'Protected config changed'):
                upgrade.rollback(manual=True)
            command.assert_not_called()


class DeployVersionPolicyTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which('node'), 'Node.js is required for the real deploy guard')
    def test_real_deploy_guard_rejects_eol_current_and_prerelease_versions(self):
        script = Path(os.environ.get('KARCHER_DEPLOY_SCRIPT',
                                     str(Path(__file__).resolve().parents[2] / 'deploy.sh')))
        code = re.search(r'"\$executable" -e \'(.*?)\' \|\| fail "unsupported Node.js runtime',
                         script.read_text(encoding='utf-8'), re.S)
        self.assertIsNotNone(code)
        for version, expected in [('22.13.0', 0), ('24.0.0', 0), ('24.22.0', 0),
                                  ('20.20.0', 1), ('22.12.0', 1), ('23.9.0', 1),
                                  ('25.1.0', 1), ('26.12.0', 1), ('24.23.0-rc.1', 1)]:
            with self.subTest(version=version):
                prefix = "Object.defineProperty(process.versions,'node',{value:'" + version + "'});"
                result = subprocess.run(['node', '-e', prefix + code.group(1)],
                                        capture_output=True, timeout=10)
                self.assertEqual(result.returncode, expected)


if __name__ == '__main__':
    unittest.main()
