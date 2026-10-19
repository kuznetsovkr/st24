#!/usr/bin/env python3
"""Host-specific, offline-artifact nginx package migration. NOT an OS updater.

Requires signed-index-verified nginx.org .deb, nine verified repacked rollback
packages, isolated tests, a fresh backup and an independent rollback timer.
Private snapshots contain payment gate configuration: NEVER publish them.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import urllib.request

BASE = Path('/root/karcher-nginx-upgrade-plan-20261019')
OLD = '1:1.28.2-142-ubuntu24'
NEW = '1.30.6-1~noble'
NEW_SHA = '86f0f503139203e8d75f1832b309ec084b0de5dfb6b72e11d0327790d3ffb90b'
REMOVED = {'nginx-common', 'nginx-core', 'libnginx-mod-http-geoip',
           'libnginx-mod-http-image-filter', 'libnginx-mod-http-xslt-filter',
           'libnginx-mod-mail', 'libnginx-mod-stream', 'libnginx-mod-stream-geoip'}
PACKAGES = REMOVED | {'nginx'}
PROTECTED = ('karcher-api', 'ssh', 'postgresql@16-main', 'redis-server', 'cron', 'fail2ban')
CONFIGS = ('/etc/karcher/api.env', '/etc/karcher/client.env',
           '/etc/systemd/system/karcher-api.service', '/etc/karcher-security/inbound.nft',
           '/var/www/st24/server/dist/index.js', '/etc/nginx/nginx.conf',
           '/etc/nginx/sites-available/st24', '/etc/nginx/conf.d/00-karcher-default-deny.conf')
SNAPSHOT_PATHS = ('/etc/nginx', '/etc/default/nginx', '/etc/init.d/nginx',
                  '/etc/logrotate.d/nginx', '/usr/lib/systemd/system/nginx.service',
                  '/etc/systemd/system/nginx.service.d')
OLD_SOURCE = Path('/etc/apt/sources.list.d/ispmanager-repo-nginx.list')
DISABLED_SOURCE = OLD_SOURCE.with_suffix('.list.disabled-karcher')
MANAGED = {'nginx.sources': Path('/etc/apt/sources.list.d/karcher-nginx.sources'),
           'karcher-nginx.pref': Path('/etc/apt/preferences.d/karcher-nginx'),
           'nginx.gpg': Path('/usr/share/keyrings/karcher-nginx.gpg')}
POLICY = Path('/usr/sbin/policy-rc.d')
POLICY_BYTES = b'#!/bin/sh\n# KARCHER temporary nginx package transaction guard\nfor arg in "$@"; do case "$arg" in nginx|nginx-debug) exit 101;; esac; done\nexit 0\n'


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
        raise RuntimeError(f'{label} failed; inspect root-only log')
    return p.stdout.decode()


def validate_plan(text):
    removed = re.findall(r'^Remv (\S+)', text, re.M)
    installed = re.findall(r'^Inst (\S+)', text, re.M)
    if set(removed) != REMOVED or len(removed) != len(REMOVED) or installed != ['nginx']:
        raise RuntimeError('APT plan is not the approved nine-package migration')
    if re.search(r'^Purg ', text, re.M) or NEW not in text:
        raise RuntimeError('Unexpected purge or target version')


def inventory():
    text = run(['dpkg-query', '-W', '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\n'], 'inventory')
    return {n: v for n, status, v in (line.split('\t') for line in text.splitlines())
            if len(status) == 3 and status[1:] == 'i '}


def unit(name):
    text = run(['systemctl', 'show', name, '-p', 'ActiveState', '-p', 'MainPID'], 'unit-' + name)
    return dict(s.split('=', 1) for s in text.splitlines())


def check_artifacts():
    new = BASE / 'packages/nginx_1.30.6-1~noble_amd64.deb'
    if sha(new) != NEW_SHA:
        raise RuntimeError('New package is not the signed-index-verified artifact')
    receipt = json.loads((BASE / 'old-package-receipt.json').read_text())
    if set(receipt) != PACKAGES:
        raise RuntimeError('Incomplete offline rollback package set')
    for name, r in receipt.items():
        if Path(r['file']).name != r['file'] or r['version'] != OLD:
            raise RuntimeError('Invalid rollback package receipt')
        if sha(BASE / 'old-packages' / r['file']) != r['sha256']:
            raise RuntimeError('Rollback package hash changed')
    test = json.loads((BASE / 'preflight-test.json').read_text())
    if test['isolatedRc'] or test['oldPayloadFiles'] < 50 or test['newSha256'] != NEW_SHA:
        raise RuntimeError('Successful isolated and rollback payload tests are missing')


def load():
    if BASE.is_symlink() or BASE.stat().st_uid != 0 or BASE.stat().st_mode & 0o077:
        raise RuntimeError('Private snapshot permissions invalid')
    return json.loads((BASE / 'nginx-state.json').read_text())


def unchanged(state, *, include_nginx=True):
    if any(unit(n) != v for n, v in state['protected'].items()):
        raise RuntimeError('Unrelated service state/PID changed')
    if any(sha(p) != h for p, h in state['configs'].items()
           if include_nginx or not p.startswith('/etc/nginx/')):
        raise RuntimeError('Protected configuration changed')
    cron = hashlib.sha256(run(['crontab', '-l'], 'cron-current').encode()).hexdigest()
    if cron != state['cronHash']:
        raise RuntimeError('Root cron changed')


def install_policy():
    if POLICY.is_symlink():
        raise RuntimeError('Refusing policy symlink')
    if POLICY.exists():
        if POLICY.read_bytes() != POLICY_BYTES:
            raise RuntimeError('An unrelated service policy already exists')
        return
    fd = os.open(POLICY, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o755)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), 0o755)
        stream.write(POLICY_BYTES)
        stream.flush()
        os.fsync(stream.fileno())


def remove_policy():
    if POLICY.exists() or POLICY.is_symlink():
        if POLICY.is_symlink() or POLICY.read_bytes() != POLICY_BYTES:
            raise RuntimeError('Refusing to remove unrelated policy')
        POLICY.unlink()


def prepare():
    if (BASE / 'nginx-state.json').exists():
        raise RuntimeError('Snapshot already exists')
    check_artifacts()
    inv = inventory()
    if any(inv.get(p) != OLD for p in PACKAGES):
        raise RuntimeError('Original nginx package set changed')
    if POLICY.exists() or POLICY.is_symlink() or DISABLED_SOURCE.exists():
        raise RuntimeError('Unexpected policy or disabled source')
    if any(p.exists() or p.is_symlink() for p in MANAGED.values()):
        raise RuntimeError('Managed repository paths already exist')
    validate_plan(run(['apt-get', '-s', '--allow-downgrades', '--no-install-recommends',
                       'install', str(BASE / 'packages/nginx_1.30.6-1~noble_amd64.deb')], 'prepare-plan'))
    protected = {n: unit(n) for n in PROTECTED}
    if any(v['ActiveState'] != 'active' for v in protected.values()) or unit('nginx')['ActiveState'] != 'active':
        raise RuntimeError('Required baseline service inactive')
    snap = BASE / 'original'
    snap.mkdir(mode=0o700)
    for path in SNAPSHOT_PATHS:
        src = Path(path)
        dest = snap / src.relative_to('/')
        dest.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dest, symlinks=True)
        else:
            shutil.copy2(src, dest, follow_symlinks=False)
    shutil.copy2(OLD_SOURCE, snap / 'old-nginx.list')
    state = {'phase': 'prepared', 'preparedAt': time.time(), 'inventory': inv,
             'nginxBefore': unit('nginx'), 'protected': protected,
             'configs': {p: sha(p) for p in CONFIGS}, 'oldSourceHash': sha(OLD_SOURCE),
             'cronHash': hashlib.sha256(run(['crontab', '-l'], 'cron-baseline').encode()).hexdigest(),
             'templates': {n: sha(BASE / n) for n in MANAGED},
             'holds': run(['apt-mark', 'showhold'], 'holds-before').splitlines()}
    save('nginx-state.json', state)
    print('Prepared: offline rollback packages, config/unit snapshot and exact APT plan')


def stop_nginx():
    run(['systemctl', 'stop', 'nginx'], 'stop-nginx', timeout=45)
    if unit('nginx')['MainPID'] != '0':
        raise RuntimeError('Nginx master did not stop')
    # The vendor postinst bypasses invoke-rc.d policy on a live PID: never allow it.
    pidfile = Path('/run/nginx.pid')
    if pidfile.exists():
        raise RuntimeError('PID file remains after stop; refuse automatic binary upgrade')


def apply():
    state = load()
    if state['phase'] != 'prepared' or inventory() != state['inventory']:
        raise RuntimeError('Not in prepared package state')
    unchanged(state)
    check_artifacts()
    if not (BASE / 'nginx-selftest.passed').is_file():
        raise RuntimeError('Independent rollback handler self-test missing')
    run(['systemctl', 'is-active', '--quiet', 'karcher-nginx-rollback.timer'], 'rollback-armed')
    from datetime import datetime
    backup = json.loads(Path('/var/backups/st24/.last-success.json').read_text())
    age = time.time() - datetime.fromisoformat(backup['checkedAt'].replace('Z', '+00:00')).timestamp()
    if backup['status'] != 'verified' or not 0 <= age < 3600:
        raise RuntimeError('Verified backup less than one hour old required')
    deb = BASE / 'packages/nginx_1.30.6-1~noble_amd64.deb'
    validate_plan(run(['apt-get', '-s', '--allow-downgrades', '--no-install-recommends',
                       'install', str(deb)], 'actual-plan'))
    state.update(phase='applying', switchAt=time.time())
    save('nginx-state.json', state)
    install_policy()
    stop_nginx()
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l', LC_ALL='C')
    run(['apt-get', '-y', '--allow-downgrades', '--no-install-recommends',
         '-o', 'Dpkg::Options::=--force-confold', 'install', str(deb)], 'install-nginx', env=env)
    # Disable ONLY the package's new default vhost. Never expose a welcome site.
    default = Path('/etc/nginx/conf.d/default.conf')
    if default.is_symlink() or sha(default) != sha(BASE / 'new-extract/etc/nginx/conf.d/default.conf'):
        raise RuntimeError('Unexpected default vhost content')
    disabled_default = default.with_suffix('.conf.disabled-karcher')
    if disabled_default.exists() or disabled_default.is_symlink():
        raise RuntimeError('Disabled default destination already exists')
    default.rename(disabled_default)
    if list(Path('/etc/nginx/modules-enabled').glob('*.conf')):
        raise RuntimeError('Old ABI module includes remain active')
    unchanged(state)
    for name, dest in MANAGED.items():
        if dest.exists() or dest.is_symlink() or sha(BASE / name) != state['templates'][name]:
            raise RuntimeError('Repository paths or templates changed')
        run(['install', '-o', 'root', '-g', 'root', '-m', '0644', str(BASE / name), str(dest)], 'install-' + name)
    if sha(OLD_SOURCE) != state['oldSourceHash']:
        raise RuntimeError('Vendor repository changed')
    OLD_SOURCE.rename(DISABLED_SOURCE)
    run(['apt-mark', 'hold', 'ispmanager-pkg-nginx'], 'hold-panel-wrapper')
    run(['systemctl', 'daemon-reload'], 'daemon-reload')
    run(['/usr/sbin/nginx', '-t'], 'new-live-syntax')
    remove_policy()
    run(['systemctl', 'start', 'nginx'], 'start-nginx')
    state.update(phase='applied', startedAt=time.time())
    save('nginx-state.json', state)
    save('nginx-first-verification.json', verify())
    print('Nginx switched; public and loopback health passed; acceptance still required')


def report(path):
    with urllib.request.urlopen('https://xn---24-3edf.xn--p1ai' + path, timeout=10) as response:
        value = json.load(response)
        if (response.status != 200 or value['status'] != 'ok'
                or response.headers.get('Cache-Control') != 'no-store'
                or 'application/json' not in response.headers.get('Content-Type', '')):
            raise RuntimeError('Public readiness/notifications not healthy')
        return value


def verify():
    state = load()
    unchanged(state)
    inv = inventory()
    expected = {n: v for n, v in state['inventory'].items() if n not in PACKAGES}
    expected['nginx'] = NEW
    if inv != expected:
        raise RuntimeError('Package state differs from approved migration')
    current = unit('nginx')
    if current['ActiveState'] != 'active' or current['MainPID'] in ('0', state['nginxBefore']['MainPID']):
        raise RuntimeError('Nginx did not switch to a new master')
    binary = '/proc/' + current['MainPID'] + '/exe'
    # nginx -v writes stderr; identify the actual mapped executable by its hash.
    if sha(binary) != sha(BASE / 'new-extract/usr/sbin/nginx'):
        raise RuntimeError('Running nginx is not the reviewed binary')
    if POLICY.exists() or POLICY.is_symlink():
        raise RuntimeError('Temporary package policy remains installed')
    for name, dest in MANAGED.items():
        if dest.is_symlink() or sha(dest) != state['templates'][name]:
            raise RuntimeError('Managed repository changed')
    if OLD_SOURCE.exists() or sha(DISABLED_SOURCE) != state['oldSourceHash']:
        raise RuntimeError('Old vendor repository not disabled correctly')
    if list(Path('/etc/nginx/modules-enabled').glob('*.conf')) or Path('/etc/nginx/conf.d/default.conf').exists():
        raise RuntimeError('Legacy modules/default site remain enabled')
    run(['nginx', '-t'], 'verify-syntax')
    run(['systemctl', 'is-enabled', '--quiet', 'nginx'], 'verify-boot')
    if run(['dpkg', '--audit'], 'verify-dpkg-audit').strip():
        raise RuntimeError('Dpkg audit reports incomplete packages')
    ready = report('/api/health/ready')
    with urllib.request.urlopen('http://127.0.0.1:4000/api/health/ready', timeout=10) as response:
        direct = json.load(response)
    if not ready.get('instanceId') or ready['instanceId'] != direct.get('instanceId'):
        raise RuntimeError('Public API does not reach local instance')
    notifications = report('/api/health/notifications')
    if (notifications['worker']['status'] != 'ok' or any(b['status'] != 'ok' for b in notifications['bots'])
            or notifications['outbox']['dead'] or any(notifications['invariants'].values())):
        raise RuntimeError('Worker/bot/business health not healthy')
    return {'verifiedAt': time.time(), 'nginxVersion': NEW, 'nginxPID': current['MainPID'],
            'apiPID': unit('karcher-api')['MainPID'], 'readyInstance': ready['instanceId'],
            'outbox': notifications['outbox'], 'unrelatedPidsAndConfigsUnchanged': True}


def rollback(manual=False):
    state = load()
    if state['phase'] == 'rolled_back' or (state['phase'] == 'accepted' and not manual):
        print('No automatic rollback: already accepted or rolled back')
        return
    check_artifacts()
    # A failed package transaction may itself have changed nginx conffiles.
    # Fence unrelated services/secrets, then restore nginx from the private snapshot.
    unchanged(state, include_nginx=False)
    current = inventory()
    if ({n: v for n, v in current.items() if n not in PACKAGES}
            != {n: v for n, v in state['inventory'].items() if n not in PACKAGES}):
        raise RuntimeError('Unrelated package state changed; manual review required')
    if current.get('nginx') not in (OLD, NEW, None):
        raise RuntimeError('Unreviewed nginx version; manual review required')
    if state['phase'] == 'accepted':
        unchanged(state)
        if current.get('nginx') != NEW:
            raise RuntimeError('Accepted package state changed')
    if state['phase'] == 'prepared':
        unchanged(state)
        if inventory() != state['inventory']:
            raise RuntimeError('Prepared package state changed')
        print('Original state unchanged; rollback handler verified')
        return
    install_policy()
    stop_nginx()
    receipt = json.loads((BASE / 'old-package-receipt.json').read_text())
    # nginx first replaces the conflicting official package, then restore core/modules.
    order = ['nginx', 'nginx-common', 'nginx-core', *sorted(REMOVED - {'nginx-core', 'nginx-common'})]
    debs = [str(BASE / 'old-packages' / receipt[n]['file']) for n in order]
    env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_MODE='l')
    run(['dpkg', '--force-confold', '--unpack', *debs], 'rollback-unpack', env=env)
    run(['dpkg', '--force-confold', '--configure', *order], 'rollback-configure', env=env)
    # Restore the original complete tree, not an overlay that could retain default.conf.
    replacement = Path('/etc/nginx.karcher-restore-20261019')
    displaced = Path('/etc/nginx.karcher-failed-20261019')
    if replacement.exists() or displaced.exists():
        raise RuntimeError('Rollback destination collision')
    shutil.copytree(BASE / 'original/etc/nginx', replacement, symlinks=True)
    Path('/etc/nginx').rename(displaced)
    replacement.rename('/etc/nginx')
    displaced.chmod(0o700)
    for path in SNAPSHOT_PATHS[1:]:
        src = BASE / 'original' / Path(path).relative_to('/')
        if src.is_dir():
            shutil.copytree(src, path, symlinks=True, dirs_exist_ok=True)
        else:
            shutil.copy2(src, path, follow_symlinks=False)
    for name, dest in MANAGED.items():
        if dest.exists() or dest.is_symlink():
            if dest.is_symlink() or sha(dest) != state['templates'][name]:
                raise RuntimeError('Refusing to remove independently changed repo/key')
            dest.unlink()
    if DISABLED_SOURCE.exists():
        if OLD_SOURCE.exists() or sha(DISABLED_SOURCE) != state['oldSourceHash']:
            raise RuntimeError('Old vendor repository changed')
        DISABLED_SOURCE.rename(OLD_SOURCE)
    if 'ispmanager-pkg-nginx' not in state['holds']:
        run(['apt-mark', 'unhold', 'ispmanager-pkg-nginx'], 'rollback-hold')
    run(['systemctl', 'daemon-reload'], 'rollback-daemon-reload')
    run(['nginx', '-t'], 'rollback-syntax')
    remove_policy()
    run(['systemctl', 'start', 'nginx'], 'rollback-start')
    unchanged(state)
    if inventory() != state['inventory']:
        raise RuntimeError('Original package inventory not restored')
    report('/api/health/ready')
    state.update(phase='rolled_back', rolledBackAt=time.time())
    save('nginx-state.json', state)
    print('Original nginx package set, configuration and running site restored')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'selftest', 'apply', 'verify', 'accept', 'rollback', 'revert'))
    action = parser.parse_args().action
    if os.geteuid() != 0:
        raise SystemExit('root required')
    os.umask(0o077)
    import fcntl
    fd = os.open('/run/lock/karcher-nginx-upgrade.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    if action == 'prepare':
        prepare()
    elif action == 'selftest':
        if load()['phase'] != 'prepared':
            raise RuntimeError('Self-test requires original state')
        rollback()
        (BASE / 'nginx-selftest.passed').touch(mode=0o600, exist_ok=False)
    elif action == 'apply':
        try:
            apply()
        except Exception:
            rollback()
            raise
    elif action == 'verify':
        print(json.dumps(verify()))
    elif action == 'accept':
        result = verify()
        state = load()
        if state['phase'] != 'applied':
            raise RuntimeError('Only an applied migration can be accepted')
        save('nginx-acceptance.json', result)
        state.update(phase='accepted', acceptedAt=time.time())
        save('nginx-state.json', state)
        print('Migration accepted; cancel independent rollback timer')
    else:
        rollback(manual=action == 'revert')


if __name__ == '__main__':
    main()
