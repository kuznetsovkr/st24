import contextlib
import datetime
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.parse


spec = importlib.util.spec_from_file_location('authorize_yandex', Path(__file__).with_name('authorize-yandex.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class AuthorizationTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.datetime.now(datetime.timezone.utc)
        self.client_id = 'a' * 32
        self.secret = 'test-only-client-secret-' * 2
        self.response = {'access_token': 'y0_' + 'test-only-access-token-' * 2,
                         'refresh_token': '1:test-only-real-shaped-refresh-token-1234567890',
                         'expires_in': 3600, 'token_type': 'bearer'}
        self.token = module.parse_token_response(self.response, self.now)
        self.renewed = {**self.token, 'refresh_token': self.token['refresh_token'] + '-rotated'}
        self.original = '[yadisk]\ntype = yandex\ntoken = old-token\n'

    def test_accepts_opaque_codes_without_fixed_length_or_numeric_restriction(self):
        for value in ['1234567', 'ab9testcode42xyzw', 'Other-Length-Code_123', 'opaque+code/value=']:
            with self.subTest(input_kind='synthetic-valid'):
                self.assertEqual(module.parse_code(' ' + value + '\n'), value)

    def test_rejects_empty_oversized_non_ascii_and_multiline_codes(self):
        for value in ['', ' \n', '１２３４５６７', 'not a code', 'two\nlines',
                      'has\ttab', 'has\x00nul', 'x' * 4097]:
            with self.subTest(input_kind='invalid'), self.assertRaises(module.AuthorizationError):
                module.parse_code(value)

    def test_uses_real_refresh_token_and_actual_expiry(self):
        self.assertEqual(self.token['refresh_token'], self.response['refresh_token'])
        self.assertEqual(self.token['token_type'], 'OAuth')
        expiry = datetime.datetime.fromisoformat(self.token['expiry'].replace('Z', '+00:00'))
        self.assertEqual(expiry, self.now + datetime.timedelta(seconds=3540))

    def test_rejects_missing_or_placeholder_refresh_token_before_rclone(self):
        for value in ['', None, 'none']:
            with self.subTest(refresh_kind='invalid'):
                with self.assertRaises(module.AuthorizationError) as raised:
                    module.parse_token_response({**self.response, 'refresh_token': value}, self.now)
                self.assertEqual(raised.exception.code, 'REFRESH_MISSING')

    def test_rejects_invalid_or_missing_lifetime_and_malformed_responses(self):
        for lifetime in [None, 0, -1, True, '3600', 9999999999999]:
            with self.subTest(lifetime=lifetime), self.assertRaises(module.AuthorizationError):
                module.parse_token_response({**self.response, 'expires_in': lifetime}, self.now)
        for response in [[], None, {}, {**self.response, 'access_token': 123}]:
            with self.subTest(response_kind='invalid'), self.assertRaises(module.AuthorizationError):
                module.parse_token_response(response, self.now)

    def test_rejects_explicitly_reduced_disk_permissions(self):
        for scope in ['cloud_api:disk.read', None]:
            with self.assertRaises(module.AuthorizationError) as raised:
                module.parse_token_response({**self.response, 'scope': scope}, self.now)
            self.assertEqual(raised.exception.code, 'TOKEN_SCOPE_REJECTED')
        module.parse_token_response({**self.response, 'scope': ' '.join(module.REQUIRED_SCOPES)}, self.now)

    def test_preserves_other_remotes_and_uses_matching_client_credentials(self):
        output = module.prepare_config('[other]\ntype = local\n\n' + self.original,
                                       self.client_id, self.secret, self.token)
        config = module.configparser.ConfigParser(interpolation=None)
        config.read_string(output)
        self.assertEqual(config['other']['type'], 'local')
        self.assertEqual(config['yadisk']['client_id'], self.client_id)
        self.assertEqual(config['yadisk']['client_secret'], self.secret)
        self.assertEqual(config['yadisk']['token_url'], module.TOKEN_URL)
        self.assertEqual(json.loads(config['yadisk']['token']), self.token)

    def test_prevents_access_only_configuration_regression(self):
        with self.assertRaises(module.AuthorizationError) as raised:
            module.prepare_config(self.original, self.client_id, self.secret,
                                  {'access_token': self.response['access_token']})
        self.assertEqual(raised.exception.code, 'REFRESH_MISSING')
        for original in ['[other]\ntype = local\n', '[yadisk]\ntype = local\n']:
            with self.assertRaises(module.AuthorizationError):
                module.prepare_config(original, self.client_id, self.secret, self.token)

    def test_errors_never_render_credential_bearing_exception_messages(self):
        for error in [ValueError(self.secret), module.configparser.Error(self.secret),
                      subprocess.TimeoutExpired(self.secret, 90, stderr=self.secret),
                      BlockingIOError(self.secret), EOFError(self.secret),
                      module.AuthorizationError(self.secret)]:
            with self.subTest(error_kind=type(error).__name__):
                self.assertNotIn(self.secret, module.safe_error_text(error))

    def test_code_exchange_sends_secrets_only_in_https_post_body(self):
        with mock.patch.object(module.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(self.response).encode()
            result = module.exchange_token(self.client_id, self.secret, 'authorization_code', '1234567')
            self.assertEqual(result['refresh_token'], self.response['refresh_token'])
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://oauth.yandex.ru/token')
            self.assertEqual(request.method, 'POST')
            self.assertNotIn(self.secret, request.full_url)
            body = urllib.parse.parse_qs(request.data.decode())
            self.assertEqual(body['client_secret'], [self.secret])
            self.assertEqual(body['code'], ['1234567'])
            self.assertEqual(body['grant_type'], ['authorization_code'])
            self.assertIsInstance(build.call_args.args[0], module.NoRedirect)

    def test_refresh_exchange_uses_the_actual_refresh_token(self):
        with mock.patch.object(module.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(self.response).encode()
            module.exchange_token(self.client_id, self.secret, 'refresh_token', self.token['refresh_token'])
            request = build.return_value.open.call_args.args[0]
            body = urllib.parse.parse_qs(request.data.decode())
            self.assertEqual(body['refresh_token'], [self.token['refresh_token']])
            self.assertNotIn('code', body)

    def test_token_endpoint_errors_are_allowlisted_and_redacted(self):
        for name, code in [('invalid_client', 'TOKEN_CLIENT_REJECTED'),
                           ('invalid_grant', 'TOKEN_CODE_REJECTED'),
                           ('invalid_scope', 'TOKEN_SCOPE_REJECTED'),
                           (self.secret, 'TOKEN_REQUEST_FAILED')]:
            error = urllib.error.HTTPError(module.TOKEN_URL, 400, self.secret, {},
                                           io.BytesIO(json.dumps({'error': name,
                                                                  'error_description': self.secret}).encode()))
            with mock.patch.object(module.urllib.request, 'build_opener') as build:
                build.return_value.open.side_effect = error
                with self.assertRaises(module.AuthorizationError) as raised:
                    module.exchange_token(self.client_id, self.secret, 'authorization_code', '1234567')
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn(self.secret, module.safe_error_text(raised.exception))

    def test_token_network_failures_do_not_reflect_credentials(self):
        with mock.patch.object(module.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = urllib.error.URLError(self.secret)
            with self.assertRaises(module.AuthorizationError) as raised:
                module.exchange_token(self.client_id, self.secret, 'authorization_code', '1234567')
        self.assertEqual(raised.exception.code, 'TOKEN_NETWORK')
        self.assertNotIn(self.secret, module.safe_error_text(raised.exception))

    def test_secret_post_cannot_be_redirected(self):
        self.assertIsNone(module.NoRedirect().redirect_request(None, None, 307, '',
                                                               {}, 'https://other.invalid/'))

    def test_actual_rclone_error_categories_do_not_expose_stderr(self):
        for diagnostic, code in [('unable to get RefreshToken ' + self.secret, 'REFRESH_MISSING'),
                                 ('[410 - GoneError] ' + self.secret, 'REMOTE_410'),
                                 ('[403 - ForbiddenError] ' + self.secret, 'REMOTE_403'),
                                 ('[503 - ServiceUnavailable] ' + self.secret, 'REMOTE_UNAVAILABLE'),
                                 (self.secret, 'REMOTE_CHECK_FAILED')]:
            with mock.patch.object(module.subprocess, 'run',
                                   return_value=subprocess.CompletedProcess([], 1, stderr=diagnostic)):
                with self.assertRaises(module.AuthorizationError) as raised:
                    module.check_remote(Path('/test/config'))
            self.assertEqual(raised.exception.code, code)
            self.assertNotIn(self.secret, module.safe_error_text(raised.exception))

    @contextlib.contextmanager
    def main_environment(self, hidden_inputs=None):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory)/'rclone.conf'
            config.write_text(self.original, encoding='utf-8')
            with (mock.patch.object(module, 'CONFIG', config),
                  mock.patch.object(module, 'BACKUP_LOCK', Path(directory)/'backup.lock'),
                  mock.patch.object(module.os, 'geteuid', return_value=0),
                  mock.patch.object(module.sys.stdin, 'isatty', return_value=True),
                  mock.patch('builtins.input', return_value=self.client_id),
                  mock.patch.object(module.getpass, 'getpass',
                                    side_effect=hidden_inputs or [self.secret, '1234567']),
                  mock.patch.object(module, 'exchange_token',
                                    side_effect=[self.token, self.renewed]) as exchange,
                  mock.patch.object(module, 'check_remote') as check,
                  mock.patch('builtins.print') as printer):
                yield config, exchange, check, printer

    def test_success_verifies_real_renewal_and_keeps_a_private_rollback(self):
        with self.main_environment() as (config, exchange, check, printer):
            module.main()
            self.assertEqual(exchange.call_args_list, [
                mock.call(self.client_id, self.secret, 'authorization_code', '1234567'),
                mock.call(self.client_id, self.secret, 'refresh_token', self.token['refresh_token'])])
            check.assert_called_once()
            config_value = module.configparser.ConfigParser(interpolation=None)
            config_value.read(config)
            self.assertEqual(json.loads(config_value['yadisk']['token']), self.renewed)
            rollback = list(config.parent.glob('rclone.conf.before-karcher-*'))
            self.assertEqual(len(rollback), 1)
            self.assertEqual(rollback[0].read_text(), self.original)
            for path in [config, rollback[0]]:
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            output = str(printer.call_args_list)
            for secret in [self.secret, self.token['access_token'], self.token['refresh_token'],
                           self.renewed['refresh_token']]:
                self.assertNotIn(secret, output)

    def test_failed_remote_check_never_replaces_config_and_removes_temporary_file(self):
        with self.main_environment() as (config, exchange, check, printer):
            check.side_effect = module.AuthorizationError('REMOTE_410')
            with self.assertRaises(module.AuthorizationError):
                module.main()
            self.assertEqual(config.read_text(), self.original)
            self.assertEqual(sorted(p.name for p in config.parent.iterdir()),
                             ['backup.lock', 'rclone.conf'])

    def test_failed_renewal_does_not_install_an_unrenewable_grant(self):
        with self.main_environment() as (config, exchange, check, printer):
            exchange.side_effect = [self.token, module.AuthorizationError('TOKEN_REQUEST_FAILED')]
            with self.assertRaises(module.AuthorizationError):
                module.main()
            check.assert_not_called()
            self.assertEqual(config.read_text(), self.original)

    def test_invalid_code_can_be_retried_without_retyping_the_secret(self):
        with self.main_environment([self.secret, 'not a code', '1234567']) as (config, exchange, check, printer):
            module.main()
            self.assertIn('[CODE_INVALID]', str(printer.call_args_list))
            self.assertNotIn(self.secret, str(printer.call_args_list))
            self.assertEqual(exchange.call_args_list[0].args[-1], '1234567')

    def test_alphanumeric_code_reaches_exchange_unchanged_and_is_never_printed(self):
        code = 'ab9testcode42xyzw'
        with self.main_environment([self.secret, code]) as (config, exchange, check, printer):
            module.main()
            self.assertEqual(exchange.call_args_list[0].args[-1], code)
            self.assertNotIn(code, str(printer.call_args_list))

    def test_alphanumeric_code_is_not_truncated_or_converted_in_https_post(self):
        code = 'ab9testcode42xyzw'
        with mock.patch.object(module.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value.__enter__.return_value.read.return_value = json.dumps(self.response).encode()
            module.exchange_token(self.client_id, self.secret, 'authorization_code', code)
            request = build.return_value.open.call_args.args[0]
            body = urllib.parse.parse_qs(request.data.decode())
            self.assertEqual(body['code'], [code])
            self.assertNotIn(code, request.full_url)


if __name__ == '__main__':
    unittest.main()
