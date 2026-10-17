from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from urllib import request
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import backup_health as health


NOW = datetime(2026, 10, 17, 12, tzinfo=timezone.utc)
SET = '2026-10-17_10-00-00_UTC'
URL = 'https://cronitor.link/p/synthetic_telemetry_key/karcher-backup'
URL2 = 'https://cronitor.link/p/synthetic_telemetry_key/karcher-storage'


def stamp(**updates):
    value = {'checkedAt': '2026-10-17T10:01:00Z', 'startedAt': '2026-10-17T10:00:00Z',
             'status': 'verified', 'stage': 'complete', 'encryption': 'age-x25519-v1',
             'backupSet': SET}
    return {**value, **updates}


def config(**updates):
    return {'version': 2, 'provider': 'cronitor', 'checks': {'backup': URL, 'storage': URL2}, **updates}


def report(backup='ok', storage='ok'):
    return {'checkedAt': '2026-10-17T12:00:00Z',
            'status': 'ok' if backup == storage == 'ok' else 'failed', 'checks': {
        'backup': {'status': backup, 'code': 'BACKUP_VERIFIED' if backup == 'ok' else 'BACKUP_STALE'},
        'storage': {'status': storage, 'code': 'DISK_SPACE_OK' if storage == 'ok' else 'DISK_SPACE_LOW'}}}


class BackupHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)/'plain'
        self.encrypted = Path(self.temp.name)/'encrypted'
        for parent, names in (
            (self.root, ('st24_db.dump', 'st24_files.tar.gz', 'SHA256SUMS.txt')),
            (self.encrypted, ('backup.tar.age', 'MANIFEST.json', 'SHA256SUMS.txt')),
        ):
            parent.mkdir(mode=0o700)
            (parent/SET).mkdir(mode=0o700)
            for name in names:
                file = parent/SET/name
                file.write_bytes(b'synthetic-not-a-real-backup')
                file.chmod(0o600)
        self.write('.last-success.json', stamp())
        self.write('.last-run.json', stamp())

    def write(self, name, value):
        path = self.root/name
        path.write_text(json.dumps(value), encoding='utf-8')
        path.chmod(0o600)

    def check(self, now=NOW):
        return health.backup_check(self.root, self.encrypted, now, health.Limits())

    def test_recent_verified_backup_passes(self):
        self.assertEqual(self.check()['code'], 'BACKUP_VERIFIED')
        self.assertAlmostEqual(self.check()['ageHours'], 1.98)

    def test_missing_success_is_not_inferred_from_directory_names_or_last_run(self):
        (self.root/'.last-success.json').unlink()
        self.assertEqual(self.check()['code'], 'LAST_SUCCESS_MISSING')

    def test_verified_state_eventually_becomes_stale_even_if_cron_never_runs(self):
        self.assertEqual(self.check(NOW + timedelta(hours=27))['code'], 'BACKUP_STALE')

    def test_last_failed_job_does_not_hide_behind_previous_success(self):
        self.write('.last-run.json', stamp(status='failed', stage='offsite_copy',
                                          checkedAt='2026-10-17T11:00:00Z'))
        self.assertEqual(self.check()['code'], 'BACKUP_RUN_FAILED')

    def test_a_running_job_is_not_failed_while_fresh_copy_exists(self):
        for status in ('running', 'local_verified'):
            with self.subTest(status=status):
                self.write('.last-run.json', stamp(status=status, stage='encryption',
                                                  checkedAt='2026-10-17T11:01:00Z',
                                                  startedAt='2026-10-17T11:00:00Z'))
                self.assertEqual(self.check()['status'], 'ok')

    def test_a_stuck_job_is_failed_even_with_previous_fresh_success(self):
        self.write('.last-run.json', stamp(status='running', stage='offsite_copy',
                                          checkedAt='2026-10-17T11:00:00Z'))
        self.assertEqual(self.check(NOW + timedelta(minutes=1))['code'], 'BACKUP_RUN_STUCK')

    def test_success_publish_transition_does_not_resurrect_previous_failure(self):
        self.write('.last-run.json', stamp(status='failed', stage='configuration',
                                          checkedAt='2026-10-17T10:00:00Z'))
        self.assertEqual(self.check()['status'], 'ok')

    def test_future_success_timestamp_fails_closed(self):
        self.write('.last-success.json', stamp(checkedAt='2026-10-18T10:00:00Z'))
        self.assertEqual(self.check()['code'], 'CLOCK_IN_FUTURE')

    def test_unverified_checkpoint_is_rejected(self):
        self.write('.last-success.json', stamp(status='local_verified'))
        self.assertEqual(self.check()['code'], 'SUCCESS_NOT_VERIFIED')

    def test_missing_or_empty_components_are_not_healthy(self):
        file = self.encrypted/SET/'backup.tar.age'
        file.write_bytes(b'')
        self.assertEqual(self.check()['code'], 'BACKUP_COMPONENT_EMPTY')
        file.unlink()
        self.assertEqual(self.check()['code'], 'BACKUP_FILES_UNAVAILABLE')

    def test_malformed_json_is_not_healthy(self):
        (self.root/'.last-run.json').write_text('{invalid', encoding='ascii')
        self.assertEqual(self.check()['code'], 'JSON_INVALID')

    def test_unexpected_json_field_types_fail_closed(self):
        for name, value in (('stage', []), ('status', {}), ('backupSet', None),
                            ('checkedAt', 42), ('backupSet', '../../secret'),
                            ('stage', 'offsite_copy')):
            with self.subTest(name=name, value=value):
                self.write('.last-success.json', stamp(**{name: value}))
                self.assertEqual(self.check()['status'], 'failed')

    def test_invalid_calendar_date_is_rejected(self):
        self.write('.last-run.json', stamp(backupSet='2026-99-17_10-00-00_UTC'))
        self.assertEqual(self.check()['code'], 'STAMP_INVALID')

    def test_running_stamp_requires_valid_start_time(self):
        for started in (None, 'bad', '2026-10-17T11:59:00Z'):
            with self.subTest(started=started):
                self.write('.last-run.json', stamp(status='running', stage='configuration',
                                                  startedAt=started))
                self.assertEqual(self.check()['status'], 'failed')

    @unittest.skipUnless(os.name == 'posix', 'POSIX mode/symlink protection')
    def test_readable_by_other_users_is_rejected(self):
        (self.root/'.last-success.json').chmod(0o644)
        self.assertEqual(self.check()['code'], 'UNSAFE_PERMISSIONS')

    @unittest.skipUnless(os.name == 'posix', 'POSIX mode/symlink protection')
    def test_symlink_stamp_is_rejected(self):
        path = self.root/'.last-success.json'
        path.unlink()
        path.symlink_to(self.root/'.last-run.json')
        self.assertEqual(self.check()['code'], 'UNSAFE_FILE_TYPE')

    def test_oversized_stamp_is_rejected(self):
        (self.root/'.last-success.json').write_bytes(b' ' * 16385)
        self.assertEqual(self.check()['code'], 'JSON_TOO_LARGE')


class StorageTests(unittest.TestCase):
    def check(self, **updates):
        values = {'f_blocks': 100 * 1024**2, 'f_frsize': 1024, 'f_bavail': 40 * 1024**2,
                  'f_files': 10000, 'f_favail': 9000, **updates}
        return health.storage_check(['synthetic'], health.Limits(),
                                    lambda _: SimpleNamespace(**values))

    def test_enough_space(self):
        result = self.check()
        self.assertEqual(result['code'], 'DISK_SPACE_OK')
        self.assertEqual(result['filesystems'][0]['freeGiB'], 40)

    def test_absolute_and_percentage_thresholds_are_independent(self):
        self.assertEqual(self.check(f_bavail=4 * 1024**2, f_blocks=8 * 1024**2)['code'], 'DISK_SPACE_LOW')
        self.assertEqual(self.check(f_bavail=10 * 1024**2)['code'], 'DISK_SPACE_LOW')

    def test_low_inode_capacity(self):
        self.assertEqual(self.check(f_favail=99)['code'], 'DISK_INODES_LOW')

    def test_filesystem_without_inode_accounting(self):
        self.assertEqual(self.check(f_files=0, f_favail=0)['status'], 'ok')

    def test_invalid_stats_fail_closed(self):
        self.assertEqual(self.check(f_blocks=0)['code'], 'DISK_STATS_INVALID')

    def test_each_storage_filesystem_is_checked(self):
        calls = []
        def stats(path):
            calls.append(path)
            return SimpleNamespace(f_blocks=100000000, f_frsize=4096,
                                   f_bavail=90000000 if path == 'plain' else 0,
                                   f_files=100, f_favail=100)
        result = health.storage_check(['plain', 'encrypted'], health.Limits(), stats)
        self.assertEqual(calls, ['plain', 'encrypted'])
        self.assertEqual(result['code'], 'DISK_SPACE_LOW')


class AlertTests(unittest.TestCase):
    def setUp(self):
        sleep = patch.object(health.time, 'sleep')
        self.sleep = sleep.start()
        self.addCleanup(sleep.stop)

    def test_read_only_cli_never_pings_and_send_requires_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            missing = Path(directory)/'absent.json'
            with patch.object(health, 'CONFIG', missing), patch.object(health, 'ping') as ping, \
                    patch.object(health, 'collect', return_value={'status': 'ok'}), \
                    patch('sys.stdout', new_callable=io.StringIO):
                with patch.object(health.sys, 'argv', ['backup_health.py', 'check']):
                    self.assertEqual(health.main(), 0)
                with patch.object(health.sys, 'argv', ['backup_health.py', 'send']):
                    self.assertEqual(health.main(), 1)
                ping.assert_not_called()

    def test_successful_http_acceptance_does_not_require_healthchecks_body(self):
        for status, body in ((200, b'accepted'), (204, b'')):
            response = io.BytesIO(body)
            response.status = status
            health.ping(URL, 'tick', {'status': 'ok'}, SimpleNamespace(open=lambda *a, **k: response))

    def test_defaults_and_valid_custom_limits(self):
        self.assertEqual(health.validate_config(config())[1], health.Limits())
        self.assertEqual(health.validate_config(config(limits={'max_age_hours': 28}))[1].max_age_hours, 28)

    def test_only_exact_https_cronitor_telemetry_urls_are_accepted(self):
        for bad in (URL + '/fail', URL + '?state=fail', URL + '#fragment', URL + '/',
                    URL.replace('https:', 'http:'), URL.replace('cronitor.link', 'evil.invalid'),
                    URL.replace('cronitor.link', 'cronitor.link@evil.invalid'),
                    URL.replace('cronitor.link', 'cronitor.link:443'),
                    URL.replace('karcher-backup', '..'),
                    URL.replace('karcher-backup', '%2E%2E'),
                    URL.replace('karcher-backup', 'a%2fb'),
                    'https://hc-ping.com/00000000-0000-4000-8000-000000000001', None):
            with self.subTest(bad=bad), self.assertRaises(health.HealthError):
                health.validate_config(config(checks={'backup': bad, 'storage': URL2}))

    def test_european_endpoint_is_supported(self):
        urls, _ = health.validate_config(config(checks={
            'backup': URL.replace('cronitor.link', 'eu.cronitor.link'), 'storage': URL2}))
        self.assertIn('eu.cronitor.link', urls['backup'])

    def test_legacy_provider_cannot_be_misinterpreted_as_cronitor(self):
        for updates in ({'version': 1}, {'provider': 'healthchecks'}, {'provider': None}):
            with self.subTest(updates=updates), self.assertRaises(health.HealthError):
                health.validate_config(config(**updates))

    def test_the_two_checks_cannot_share_a_ping_url(self):
        with self.assertRaisesRegex(health.HealthError, 'CHECK_URLS_MUST_DIFFER'):
            health.validate_config(config(checks={'backup': URL, 'storage': URL}))

    def test_different_tokens_or_hosts_for_same_monitor_are_rejected(self):
        for url in (URL.replace('synthetic_telemetry_key', 'another_key'),
                    URL.replace('cronitor.link', 'eu.cronitor.link')):
            with self.subTest(url=url), self.assertRaisesRegex(health.HealthError, 'CHECK_MONITORS_MUST_DIFFER'):
                health.validate_config(config(checks={'backup': URL, 'storage': url}))

    def test_invalid_thresholds_are_rejected(self):
        for limits in ({'max_age_hours': float('nan')}, {'min_free_gib': True},
                       {'unknown': 1}, {'max_run_hours': 100}, {'min_free_percent': 100},
                       {'max_age_hours': -1}, {'max_age_hours': 169}):
            with self.subTest(limits=limits), self.assertRaises(health.HealthError):
                health.validate_config(config(limits=limits))

    def test_non_success_status_is_not_accepted(self):
        for status in (301, 400, 401, 403, 429, 500):
            response = io.BytesIO(b'raw-response-must-not-be-printed')
            response.status = status
            opener = SimpleNamespace(open=lambda *args, **kwargs: response)
            with self.subTest(status=status), self.assertRaisesRegex(health.HealthError, '^PING_HTTP_REJECTED$'):
                health.ping(URL, 'tick', {}, opener)

    def test_request_is_bounded_post_and_no_raw_errors_are_leaked(self):
        calls = []
        def failure(req, timeout):
            calls.append((req, timeout))
            raise OSError('secret URL: ' + URL)
        with self.assertRaisesRegex(health.HealthError, '^PING_DELIVERY_FAILED$'):
            health.ping(URL, 'fail', {'code': 'BACKUP_STALE'}, SimpleNamespace(open=failure))
        self.assertEqual(len(calls), 2)
        for req, timeout in calls:
            self.assertEqual(timeout, 10)
            self.assertEqual(req.method, 'POST')
            parts = urlsplit(req.full_url)
            self.assertEqual(parts.scheme + '://' + parts.netloc + parts.path, URL)
            params = parse_qs(parts.query)
            self.assertEqual(params['state'], ['fail'])
            self.assertEqual(params['env'], ['production'])
            self.assertEqual(json.loads(params['message'][0]), {'code': 'BACKUP_STALE'})
            self.assertEqual(req.data, b'')
        self.sleep.assert_called_once_with(1)

    def test_invalid_events_and_oversized_messages_are_rejected_without_http(self):
        for event in ('/fail', '/log', 'run', 'ok'):
            with self.subTest(event=event), self.assertRaises(health.HealthError):
                health.ping(URL, event, {})
        with self.assertRaisesRegex(health.HealthError, 'PING_MESSAGE_TOO_LARGE'):
            health.ping(URL, 'tick', {'code': 'x' * 2001})

    def test_auth_errors_do_not_retry_or_expose_secret_urls(self):
        for status in (401, 403):
            def denied(req, timeout):
                raise HTTPError(req.full_url, status, 'secret raw message', {}, None)
            with self.subTest(status=status), self.assertRaisesRegex(health.HealthError, '^PING_AUTH_REJECTED$'):
                health.ping(URL, 'tick', {}, SimpleNamespace(open=denied))
        self.sleep.assert_not_called()

    def test_rate_limit_and_server_errors_have_bounded_safe_retries(self):
        for status, code in ((429, 'PING_RATE_LIMITED'), (503, 'PING_SERVICE_UNAVAILABLE')):
            calls = []
            def unavailable(req, timeout):
                calls.append(req)
                raise HTTPError(req.full_url, status, 'secret raw message', {}, None)
            with self.subTest(status=status), self.assertRaisesRegex(health.HealthError, '^' + code + '$'):
                health.ping(URL, 'tick', {}, SimpleNamespace(open=unavailable))
            self.assertEqual(len(calls), 2)

    def test_redirect_http_error_is_not_followed_or_retried(self):
        calls = []
        def redirect(req, timeout):
            calls.append(req)
            raise HTTPError(req.full_url, 302, 'secret raw message', {'Location': URL2}, None)
        with self.assertRaisesRegex(health.HealthError, '^PING_HTTP_REJECTED$'):
            health.ping(URL, 'tick', {}, SimpleNamespace(open=redirect))
        self.assertEqual(len(calls), 1)

    def test_transient_network_error_can_succeed_on_second_attempt(self):
        calls = []
        def unstable(req, timeout):
            calls.append(req)
            if len(calls) == 1:
                raise OSError('synthetic network failure')
            response = io.BytesIO(b'accepted')
            response.status = 200
            return response
        health.ping(URL, 'tick', {}, SimpleNamespace(open=unstable))
        self.assertEqual(len(calls), 2)

    def test_proxy_environment_and_redirects_are_disabled(self):
        with patch.object(request, 'build_opener', wraps=request.build_opener) as build:
            with patch.object(request.OpenerDirector, 'open', side_effect=OSError('safe mock')):
                with self.assertRaises(health.HealthError):
                    health.ping(URL, 'tick', {})
            proxy, redirect = build.call_args.args
            self.assertEqual(proxy.proxies, {})
            self.assertIsNone(redirect.redirect_request(None, None, 302, '', {}, URL2))

    def test_one_check_delivery_failure_does_not_prevent_other_check(self):
        current = report(backup='failed')
        with patch.object(health, 'ping', side_effect=[health.HealthError('PING_DELIVERY_FAILED'), None]) as ping:
            self.assertFalse(health.deliver({'backup': URL, 'storage': URL2}, current))
            self.assertEqual([call.args[1] for call in ping.call_args_list], ['fail', 'tick'])
            self.assertEqual(current['delivery']['storage'], 'accepted')

    def test_config_probe_failure_keeps_old_config_and_suppresses_secrets(self):
        if os.name != 'posix' or os.geteuid() != 0:
            self.skipTest('interactive configurator requires root')
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            parent.chmod(0o700)
            target = parent/'alerts.json'
            original = b'{"synthetic":"existing-config"}'
            target.write_bytes(original)
            target.chmod(0o600)
            with patch.object(health.getpass, 'getpass', side_effect=[URL, URL2]), \
                    patch.object(health.sys.stdin, 'isatty', return_value=True), \
                    patch.object(health, 'collect', return_value=report()), \
                    patch.object(health, 'ping', side_effect=health.HealthError('PING_DELIVERY_FAILED')), \
                    patch('sys.stdout', new_callable=io.StringIO) as output:
                with self.assertRaisesRegex(health.HealthError, 'CONFIGURATION_DELIVERY_FAILED'):
                    health.configure(target)
                self.assertNotIn(URL, output.getvalue())
            self.assertEqual(target.read_bytes(), original)

    def test_config_is_atomically_installed_only_after_both_probes(self):
        if os.name != 'posix' or os.geteuid() != 0:
            self.skipTest('interactive configurator requires root')
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            parent.chmod(0o700)
            target = parent/'alerts.json'
            with patch.object(health.getpass, 'getpass', side_effect=[URL, URL2]), \
                    patch.object(health.sys.stdin, 'isatty', return_value=True), \
                    patch.object(health, 'collect', return_value=report(backup='failed')), \
                    patch.object(health, 'ping') as ping, patch('sys.stdout', new_callable=io.StringIO):
                health.configure(target)
                # No Healthchecks /log equivalent: use real failure, never fake OK.
                self.assertEqual([call.args[1] for call in ping.call_args_list], ['fail', 'tick'])
            self.assertEqual(health.validate_config(health.read_json(target))[0]['storage'], URL2)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_configurator_refuses_noninteractive_input_before_reading_secrets(self):
        if os.name != 'posix' or os.geteuid() != 0:
            self.skipTest('interactive configurator requires root')
        with patch.object(health.sys.stdin, 'isatty', return_value=False), \
                patch.object(health.getpass, 'getpass') as getpass:
            with self.assertRaisesRegex(health.HealthError, 'SECURE_TERMINAL_REQUIRED'):
                health.configure()
            getpass.assert_not_called()

    def test_configurator_never_falls_back_to_visible_secret_input(self):
        if os.name != 'posix' or os.geteuid() != 0:
            self.skipTest('interactive configurator requires root')
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory)
            parent.chmod(0o700)
            with patch.object(health.sys.stdin, 'isatty', return_value=True), \
                    patch.object(health.getpass, 'getpass', side_effect=health.getpass.GetPassWarning), \
                    patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaisesRegex(health.HealthError, 'SECURE_TERMINAL_REQUIRED'):
                    health.configure(parent/'alerts.json')


if __name__ == '__main__':
    unittest.main()
