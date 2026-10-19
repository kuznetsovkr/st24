#!/usr/bin/env python3
"""Host-specific Node 24 package switch; no application checkout or OS upgrade.

Requires previously verified .debs, isolated application tests, a fresh backup,
and an independently armed rollback timer. All command output stays root-only.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.request

BASE = Path('/root/karcher-node24-20261019')
OLD = '20.20.0-1nodesource1'
NEW = '24.22.0-1nodesource1'
SOURCE = Path('/etc/apt/sources.list.d/karcher-nodesource.sources')
PIN = Path('/etc/apt/preferences.d/karcher-nodejs')
PROTECTED = ('nginx', 'ssh', 'postgresql@16-main', 'redis-server', 'cron', 'fail2ban')
CONFIGS = ('/etc/karcher/api.env', '/etc/karcher/client.env',
           '/etc/systemd/system/karcher-api.service', '/etc/nginx/nginx.conf',
           '/etc/nginx/sites-available/st24', '/etc/karcher-security/inbound.nft',
           '/var/www/st24/server/dist/index.js',
           '/var/www/st24/server/dist/startupConfig.js')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(name, value):
    tmp = BASE / (name + '.tmp')
    with tmp.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    tmp.chmod(0o600)
    tmp.replace(BASE / name)


def run(args, label, *, timeout=180, env=None):
    p = subprocess.run(args, capture_output=True, timeout=timeout, env=env)
    with (BASE / (label + '.log')).open('ab') as log:
        log.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f'{label} failed; inspect its root-only log')
    return p.stdout.decode()


def validate_plan(text):
    installed = re.findall(r'^Inst (\S+)', text, re.M)
    if installed != ['nodejs'] or re.search(r'^(Remv|Purg) ', text, re.M):
        raise RuntimeError('Package plan changes something other than nodejs')
    if not re.search(r'1 upgraded, 0 newly installed, 0 to remove', text):
        raise RuntimeError('Package plan is not the reviewed one-package upgrade')


def package_command(v):
    if v not in (OLD, NEW):
        raise RuntimeError('Package version is outside the reviewed allowlist')
    return ['dpkg', '--force-confold', '--install',
            str(BASE / 'packages' / ('nodejs_' + v + '_amd64.deb'))]


def version():
    return run(['dpkg-query', '-W', '-f=${Version}', 'nodejs'], 'package-version').strip()


def unit(name):
    text = run(['systemctl', 'show', name, '-p', 'ActiveState', '-p', 'MainPID'],
               'unit-' + name)
    return dict(s.split('=', 1) for s in text.splitlines())


def apt_options():
    return ['-o', 'Dir::Etc::sourcelist=' + str(BASE / 'nodesource24.sources'),
            '-o', 'Dir::Etc::sourceparts=-',
            '-o', 'Dir::State::lists=' + str(BASE / 'apt-lists'),
            '-o', 'Dir::Cache::archives=' + str(BASE / 'apt-cache'),
            '-o', 'APT::Sandbox::User=root']


def check_artifacts():
    receipt = json.loads((BASE / 'package-receipt.json').read_text())
    for label, v in [('old', OLD), ('new', NEW)]:
        deb = BASE / 'packages' / ('nodejs_' + v + '_amd64.deb')
        if sha(deb) != receipt[label]['sha256']:
            raise RuntimeError('Package hash differs from verified receipt')
    tests = json.loads((BASE / 'stage-verification.json').read_text())
    if tests['nodeVersion'] != 'v24.22.0' or not tests['steps']:
        raise RuntimeError('Isolated Node 24 test receipt is invalid')
    if any(s['rc'] for s in tests['steps']) or sha(BASE / 'source.tar') != tests['sourceSha256']:
        raise RuntimeError('Isolated source/tests changed')


def prepare():
    if (BASE / 'switch-state.json').exists():
        raise RuntimeError('Switch snapshot already exists')
    check_artifacts()
    if version() != OLD or SOURCE.exists() or SOURCE.is_symlink() or PIN.exists() or PIN.is_symlink():
        raise RuntimeError('Production package or repository state differs from inventory')
    for path in (BASE / 'nodesource24.sources', BASE / 'karcher-nodejs.pref'):
        if path.is_symlink() or not path.is_file():
            raise RuntimeError('Invalid repository template')
    plan = run(['apt-get', *apt_options(), '-s', '--no-remove', '--no-install-recommends',
                'install', 'nodejs=' + NEW], 'pre-switch-simulation')
    validate_plan(plan)
    protected = {name: unit(name) for name in PROTECTED}
    if any(v['ActiveState'] != 'active' for v in protected.values()):
        raise RuntimeError('Protected service is not active')
    api = unit('karcher-api')
    if api['ActiveState'] != 'active':
        raise RuntimeError('API is not healthy before switching')
    state = {'phase': 'prepared', 'preparedAt': time.time(), 'apiBefore': api,
             'protected': protected, 'configs': {p: sha(p) for p in CONFIGS},
             'cronHash': hashlib.sha256(run(['crontab', '-l'], 'cron-baseline').encode()).hexdigest(),
             'templates': {'nodesource24.sources': sha(BASE / 'nodesource24.sources'),
                           'karcher-nodejs.pref': sha(BASE / 'karcher-nodejs.pref')}}
    save('switch-state.json', state)
    print(json.dumps({'phase': 'prepared', 'old': OLD, 'new': NEW}))


def load():
    if BASE.is_symlink() or BASE.stat().st_uid != 0 or BASE.stat().st_mode & 0o077:
        raise RuntimeError('Private snapshot permissions invalid')
    return json.loads((BASE / 'switch-state.json').read_text())


def unchanged(state):
    if any(unit(name) != value for name, value in state['protected'].items()):
        raise RuntimeError('Unrelated service state/PID changed')
    if any(sha(p) != h for p, h in state['configs'].items()):
        raise RuntimeError('Protected production configuration changed')


def report(path):
    req = urllib.request.Request('https://xn---24-3edf.xn--p1ai' + path,
                                 headers={'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(req, timeout=10) as response:
        value = json.load(response)
        if (response.status != 200 or value['status'] != 'ok'
                or response.headers.get('Cache-Control') != 'no-store'
                or 'application/json' not in response.headers.get('Content-Type', '')):
            raise RuntimeError('Public health is not healthy')
        return value


def verify():
    state = load()
    if version() != NEW or run(['/usr/bin/node', '--version'], 'runtime-version').strip() != 'v24.22.0':
        raise RuntimeError('Node 24 is not installed')
    unchanged(state)
    if hashlib.sha256(run(['crontab', '-l'], 'cron-current').encode()).hexdigest() != state['cronHash']:
        raise RuntimeError('Root cron changed during runtime upgrade')
    for process in Path('/proc').iterdir():
        if not process.name.isdigit():
            continue
        try:
            if os.readlink(process / 'exe').startswith('/usr/local/mgr5/'):
                raise RuntimeError('Panel process returned during runtime upgrade')
        except (FileNotFoundError, ProcessLookupError):
            continue
    for dest, name in [(SOURCE, 'nodesource24.sources'), (PIN, 'karcher-nodejs.pref')]:
        if dest.is_symlink() or sha(dest) != state['templates'][name]:
            raise RuntimeError('Managed repository differs from reviewed template')
    api = unit('karcher-api')
    if api['ActiveState'] != 'active' or api['MainPID'] == state['apiBefore']['MainPID']:
        raise RuntimeError('API did not switch to a fresh process')
    # Execute the running process's pinned binary, not merely the current PATH.
    running = run(['/proc/' + api['MainPID'] + '/exe', '--version'], 'running-runtime').strip()
    if running != 'v24.22.0':
        raise RuntimeError('Running API still uses the old runtime')
    ready = report('/api/health/ready')
    from datetime import datetime
    checked = datetime.fromisoformat(ready['checkedAt'].replace('Z', '+00:00')).timestamp()
    if checked < state['restartAt']:
        raise RuntimeError('Readiness predates the API restart')
    with urllib.request.urlopen('http://127.0.0.1:4000/api/health/ready', timeout=10) as response:
        direct = json.load(response)
    if not ready.get('instanceId') or ready['instanceId'] != direct.get('instanceId'):
        raise RuntimeError('Public readiness does not reach the fresh local API')
    notifications = report('/api/health/notifications')
    if notifications['worker']['status'] != 'ok' or any(b['status'] != 'ok' for b in notifications['bots']):
        raise RuntimeError('Notification worker or bot not healthy')
    if notifications['outbox']['dead'] or any(notifications['invariants'].values()):
        raise RuntimeError('Notification/business health is not healthy')
    return {'verifiedAt': time.time(), 'nodeVersion': running, 'apiPID': api['MainPID'],
            'readyInstance': ready.get('instanceId'), 'bots': len(notifications['bots']),
            'outbox': notifications['outbox'], 'protectedPidsAndConfigsUnchanged': True}


def apply():
    state = load()
    if state['phase'] != 'prepared' or version() != OLD:
        raise RuntimeError('Switch is not in the prepared original state')
    check_artifacts()
    unchanged(state)
    if not (BASE / 'switch-selftest.passed').is_file():
        raise RuntimeError('Independent rollback self-test is missing')
    run(['systemctl', 'is-active', '--quiet', 'karcher-node24-rollback.timer'], 'rollback-armed')
    backup = json.loads(Path('/var/backups/st24/.last-success.json').read_text())
    from datetime import datetime, timezone
    age = datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(backup['checkedAt'].replace('Z', '+00:00')).timestamp()
    if backup['status'] != 'verified' or not 0 <= age < 3600:
        raise RuntimeError('A verified backup less than one hour old is required')
    deb = BASE / 'packages' / ('nodejs_' + NEW + '_amd64.deb')
    validate_plan(run(['apt-get', '-s', '--no-remove', '--no-install-recommends',
                       'install', str(deb)], 'actual-local-package-plan'))
    state['phase'] = 'applying'
    save('switch-state.json', state)
    for path, source in [(SOURCE, 'nodesource24.sources'), (PIN, 'karcher-nodejs.pref')]:
        if path.exists() or path.is_symlink() or sha(BASE / source) != state['templates'][source]:
            raise RuntimeError('Unexpected existing repository or template change')
        run(['install', '-o', 'root', '-g', 'root', '-m', '0644', str(BASE / source), str(path)], 'install-' + source)
    # Only the already authenticated nodejs artifact is installed. No OS upgrades,
    # package removals, or automatic unrelated daemon restarts are allowed.
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
    # dpkg consumes exactly this local artifact, with no resolver/downloads.
    # APT has already verified that its dependencies are installed.
    run(package_command(NEW), 'install-node24', env=env)
    if version() != NEW:
        raise RuntimeError('Package did not upgrade')
    run(['/usr/bin/env', 'NODE_ENV=production', 'DOTENV_CONFIG_PATH=/etc/karcher/api.env',
         'DOTENV_CONFIG_QUIET=true', '/usr/bin/node', '/var/www/st24/server/dist/configCheck.js'],
        'production-config-preflight')
    state['restartAt'] = time.time()
    save('switch-state.json', state)
    run(['systemctl', 'restart', 'karcher-api'], 'restart-api')
    state['phase'] = 'applied'
    save('switch-state.json', state)
    print(json.dumps({'phase': 'applied', 'runtime': NEW, 'waitForBots': True}))


def rollback(manual=False):
    state = load()
    if state['phase'] == 'rolled_back' or (state['phase'] == 'accepted' and not manual):
        print('No rollback: already accepted or rolled back')
        return
    check_artifacts()
    current = version()
    if current not in (OLD, NEW):
        raise RuntimeError('Unreviewed installed Node package; manual review required')
    unchanged(state)
    for dest, name in [(SOURCE, 'nodesource24.sources'), (PIN, 'karcher-nodejs.pref')]:
        if dest.exists() or dest.is_symlink():
            if dest.is_symlink() or sha(dest) != state['templates'][name]:
                raise RuntimeError('Refusing to remove independently changed repository')
            dest.unlink()
    if current != OLD:
        run(package_command(OLD), 'rollback-package',
            env=dict(os.environ, NEEDRESTART_MODE='l', DEBIAN_FRONTEND='noninteractive'))
    if unit('karcher-api')['MainPID'] != state['apiBefore']['MainPID']:
        run(['systemctl', 'restart', 'karcher-api'], 'rollback-api')
    state['phase'] = 'rolled_back'
    save('switch-state.json', state)
    print('Original Node package and API runtime restored')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'selftest', 'apply', 'verify', 'accept', 'rollback', 'revert'))
    action = parser.parse_args().action
    if os.geteuid() != 0:
        raise SystemExit('root required')
    os.umask(0o077)
    import fcntl
    lock = os.open('/run/lock/karcher-node24.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    if action == 'prepare':
        prepare()
    elif action == 'selftest':
        state = load()
        if state['phase'] != 'prepared' or version() != OLD:
            raise RuntimeError('Self-test requires unchanged original runtime')
        rollback()
        unchanged(state)
        state['phase'] = 'prepared'
        save('switch-state.json', state)
        (BASE / 'switch-selftest.passed').touch(mode=0o600, exist_ok=False)
        print('Independent rollback handler self-test passed')
    elif action == 'apply':
        apply()
    elif action == 'verify':
        print(json.dumps(verify()))
    elif action == 'accept':
        result = verify()
        state = load()
        if state['phase'] != 'applied':
            raise RuntimeError('Only an applied switch can be accepted')
        save('switch-acceptance.json', result)
        state.update(phase='accepted', acceptedAt=time.time())
        save('switch-state.json', state)
        print('Runtime switch accepted; cancel the independent rollback timer')
    else:
        rollback(manual=action == 'revert')


if __name__ == '__main__':
    main()
