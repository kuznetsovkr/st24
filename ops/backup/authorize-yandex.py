#!/usr/bin/env python3
"""Install a verified Yandex authorization-code grant, without exposing secrets."""

import configparser
import datetime
import fcntl
import getpass
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


CONFIG = Path('/root/.config/rclone/rclone.conf')
BACKUP_LOCK = Path('/var/lock/st24-backup.lock')
TOKEN_URL = 'https://oauth.yandex.ru/token'
REQUIRED_SCOPES = {'cloud_api:disk.read', 'cloud_api:disk.write', 'cloud_api:disk.info'}
ERROR_MESSAGES = {
    'TERMINAL_REQUIRED': 'Run from an interactive root SSH terminal.',
    'CONFIG_UNEXPECTED': 'The expected backup configuration was not found.',
    'CLIENT_ID_INVALID': 'ClientID must contain exactly 32 hexadecimal characters.',
    'CLIENT_SECRET_INVALID': 'Paste the Client secret from this application settings page.',
    'CODE_INVALID': 'Paste the complete confirmation CODE shown on the page, without spaces or line breaks.',
    'TOKEN_RESPONSE_INVALID': 'Yandex returned an incomplete token response; configuration was not replaced.',
    'REFRESH_MISSING': 'A real refresh token is required by the installed rclone. Use the code flow.',
    'TOKEN_CLIENT_REJECTED': 'Yandex rejected the ClientID/Client secret or the application is blocked.',
    'TOKEN_CODE_REJECTED': 'The code is invalid, expired or already used. Run again and get a fresh code.',
    'TOKEN_SCOPE_REJECTED': 'Check that Disk read, write and info permissions are enabled.',
    'TOKEN_REQUEST_FAILED': 'Yandex rejected the token request. Send only this code to the operator.',
    'TOKEN_NETWORK': 'The HTTPS token request failed. Check the connection and retry.',
    'REMOTE_401': 'Yandex rejected Disk access (HTTP 401). Obtain a new grant and check the account.',
    'REMOTE_403': 'Yandex denied Disk access (HTTP 403). Check permissions and the account.',
    'REMOTE_410': 'Yandex still returns HTTP 410 with the new grant; the API needs investigation.',
    'REMOTE_429': 'Yandex is rate-limiting requests. Try again later.',
    'REMOTE_UNAVAILABLE': 'Yandex returned a server error. Try again later.',
    'REMOTE_CHECK_FAILED': 'The Disk access check failed. Configuration was not replaced.',
    'BACKUP_BUSY': 'A backup is running. Wait for it to finish, then retry.',
    'REMOTE_TIMEOUT': 'The access check timed out. Check the connection and retry.',
    'CANCELLED': 'Input was cancelled. Run again when ready.',
    'INTERNAL': 'An internal setup error occurred. Send only this error code to the operator.',
}


class AuthorizationError(ValueError):
    def __init__(self, code):
        self.code = code if code in ERROR_MESSAGES else 'INTERNAL'
        super().__init__(self.code)


def safe_error_text(error):
    # Never render str(error): it can contain a token, client secret or URL.
    if isinstance(error, AuthorizationError):
        code = error.code
    elif isinstance(error, BlockingIOError):
        code = 'BACKUP_BUSY'
    elif isinstance(error, subprocess.TimeoutExpired):
        code = 'REMOTE_TIMEOUT'
    elif isinstance(error, (KeyboardInterrupt, EOFError)):
        code = 'CANCELLED'
    else:
        code = 'INTERNAL'
    return '[' + code + '] ' + ERROR_MESSAGES[code]


def parse_code(value):
    # Authorization codes are opaque strings, not necessarily numeric or a
    # fixed length. Validate only safe single-line input; Yandex validates it.
    code = value.strip()
    if not re.fullmatch(r'[\x21-\x7e]{1,4096}', code):
        raise AuthorizationError('CODE_INVALID')
    return code


def parse_token_response(response, requested_at):
    if not isinstance(response, dict):
        raise AuthorizationError('TOKEN_RESPONSE_INVALID')
    token = response.get('access_token', '')
    refresh = response.get('refresh_token', '')
    lifetime = response.get('expires_in')
    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{20,4096}', token):
        raise AuthorizationError('TOKEN_RESPONSE_INVALID')
    if not isinstance(refresh, str) or not re.fullmatch(r'[!-~]{20,4096}', refresh):
        raise AuthorizationError('REFRESH_MISSING')
    if type(lifetime) is not int or not 120 < lifetime <= 315360000:
        raise AuthorizationError('TOKEN_RESPONSE_INVALID')
    if 'scope' in response:
        scope = response['scope']
        if not isinstance(scope, str) or not REQUIRED_SCOPES.issubset(set(scope.split())):
            raise AuthorizationError('TOKEN_SCOPE_REJECTED')
    expiry = requested_at + datetime.timedelta(seconds=lifetime - 60)
    if expiry <= datetime.datetime.now(datetime.timezone.utc):
        raise AuthorizationError('TOKEN_RESPONSE_INVALID')
    # Yandex's rclone backend expects OAuth even though the endpoint says bearer.
    return {'access_token': token, 'refresh_token': refresh, 'token_type': 'OAuth',
            'expiry': expiry.isoformat().replace('+00:00', 'Z')}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file, code, message, headers, new_url):
        return None  # Never forward client credentials to another endpoint.


def exchange_token(client_id, client_secret, grant_type, credential):
    field = {'authorization_code': 'code', 'refresh_token': 'refresh_token'}.get(grant_type)
    if field is None:
        raise AuthorizationError('TOKEN_REQUEST_FAILED')
    body = urllib.parse.urlencode({'grant_type': grant_type, field: credential,
                                  'client_id': client_id, 'client_secret': client_secret}).encode('ascii')
    request = urllib.request.Request(TOKEN_URL, data=body,
                                    headers={'Content-Type': 'application/x-www-form-urlencoded'},
                                    method='POST')
    requested_at = datetime.datetime.now(datetime.timezone.utc)
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as reply:
            payload = reply.read(65537)
            if len(payload) > 65536:
                raise AuthorizationError('TOKEN_RESPONSE_INVALID')
            response = json.loads(payload)
    except urllib.error.HTTPError as error:
        # Read only the machine error name; never print error_description/body.
        try:
            response = json.loads(error.read(65536))
            name = response.get('error') if isinstance(response, dict) else None
        except (ValueError, OSError):
            name = None
        finally:
            error.close()
        code = {'invalid_client': 'TOKEN_CLIENT_REJECTED',
                'unauthorized_client': 'TOKEN_CLIENT_REJECTED',
                'invalid_grant': 'TOKEN_CODE_REJECTED',
                'bad_verification_code': 'TOKEN_CODE_REJECTED',
                'invalid_scope': 'TOKEN_SCOPE_REJECTED'}.get(name, 'TOKEN_REQUEST_FAILED')
        raise AuthorizationError(code) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise AuthorizationError('TOKEN_NETWORK') from None
    except (ValueError, UnicodeError):
        raise AuthorizationError('TOKEN_RESPONSE_INVALID') from None
    return parse_token_response(response, requested_at)


def prepare_config(original, client_id, client_secret, token):
    if not re.fullmatch(r'[a-fA-F0-9]{32}', client_id):
        raise AuthorizationError('CLIENT_ID_INVALID')
    if not token.get('refresh_token') or not token.get('expiry'):
        raise AuthorizationError('REFRESH_MISSING')
    config = configparser.ConfigParser(interpolation=None)
    config.read_string(original)
    if config.get('yadisk', 'type', fallback='') != 'yandex':
        raise AuthorizationError('CONFIG_UNEXPECTED')
    config.set('yadisk', 'client_id', client_id)
    config.set('yadisk', 'client_secret', client_secret)
    # Use the same verified regional endpoint for subsequent rclone renewals.
    config.set('yadisk', 'token_url', TOKEN_URL)
    config.set('yadisk', 'token', json.dumps(token, separators=(',', ':')))
    output = io.StringIO()
    config.write(output)
    return output.getvalue()


def check_remote(temporary):
    result = subprocess.run(
        ['rclone', '--config', str(temporary), 'lsf', 'yadisk:',
         '--max-depth', '1', '--retries', '1', '--low-level-retries', '1',
         '--contimeout', '15s', '--timeout', '30s'],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE, text=True, timeout=90, check=False)
    if result.returncode == 0:
        return
    diagnostic = result.stderr or ''
    if 'unable to get RefreshToken' in diagnostic:
        raise AuthorizationError('REFRESH_MISSING')
    match = re.search(r'\[(401|403|410|429|5[0-9]{2})\s*-', diagnostic)
    code = 'REMOTE_CHECK_FAILED'
    if match:
        status = match.group(1)
        code = 'REMOTE_UNAVAILABLE' if status.startswith('5') else 'REMOTE_' + status
    raise AuthorizationError(code)


def main():
    if os.geteuid() != 0 or not sys.stdin.isatty():
        raise AuthorizationError('TERMINAL_REQUIRED')
    os.umask(0o077)
    if CONFIG.is_symlink() or not CONFIG.is_file():
        raise AuthorizationError('CONFIG_UNEXPECTED')
    client_id = input('ClientID (public, 32 hexadecimal characters): ').strip()
    if not re.fullmatch(r'[a-fA-F0-9]{32}', client_id):
        raise AuthorizationError('CLIENT_ID_INVALID')
    print('Open this application settings page; copy its Client secret, NOT an access token:')
    print('https://oauth.yandex.ru/client/' + client_id)
    client_secret = getpass.getpass('Client secret from application settings (hidden): ').strip()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{20,256}', client_secret):
        raise AuthorizationError('CLIENT_SECRET_INVALID')
    print('Now open this address in your browser using your own Yandex account:')
    query = urllib.parse.urlencode({'response_type': 'code', 'client_id': client_id,
                                   'redirect_uri': 'https://oauth.yandex.ru/verification_code',
                                   'force_confirm': 'yes'})
    print('https://oauth.yandex.ru/authorize?' + query)
    print('After approval, copy the COMPLETE CONFIRMATION CODE SHOWN ON THE PAGE.')
    print('The code may contain letters and digits; it does not have to be 7 digits.')
    print('All secret input is hidden. Do not send secrets to chat or put them in commands.')
    for attempt in range(3):
        try:
            code = parse_code(getpass.getpass('Confirmation code from the page (hidden): '))
            break
        except AuthorizationError as error:
            if attempt == 2:
                raise
            print(safe_error_text(error), file=sys.stderr)
    with BACKUP_LOCK.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        original = CONFIG.read_text(encoding='utf-8')
        print('Exchanging code for a real access/refresh token pair...')
        token = exchange_token(client_id, client_secret, 'authorization_code', code)
        print('Checking actual token renewal before changing the current configuration...')
        token = exchange_token(client_id, client_secret, 'refresh_token', token['refresh_token'])
        replacement = prepare_config(original, client_id, client_secret, token)
        CONFIG.parent.chmod(0o700)
        CONFIG.chmod(0o600)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8',
                                             dir=CONFIG.parent, delete=False) as file:
                temporary = Path(file.name)
                file.write(replacement)
            print('Checking Disk access using the installed rclone...')
            check_remote(temporary)
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            rollback = CONFIG.with_name('rclone.conf.before-karcher-' + stamp)
            with rollback.open('x', encoding='utf-8') as file:
                file.write(original)
            os.replace(temporary, CONFIG)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    print('New access installed. Token expiry:', token['expiry'])
    print('Token renewal and Disk read access verified. Revoked grants still need reauthorization.')
    print('Tell the operator authorization is complete; do not share secrets.')
    print('An upload and downloaded-content verification are still required.')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        print(safe_error_text(error), file=sys.stderr)
        print('Authorization not completed. Existing backup configuration was retained.', file=sys.stderr)
        sys.exit(1)
