#!/usr/bin/env python3
"""Host-specific Ubuntu maintenance, without firmware/boot/policy changes/reboot.

Offline, authenticated artifacts only. No automatic system-library downgrade:
on failure keep the private recovery inputs and inspect the transaction log.
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

BASE = Path('/root/karcher-ubuntu-updates-20261019')
EXPECTED = {'base-files', 'binutils', 'binutils-common', 'binutils-x86-64-linux-gnu',
            'dmidecode', 'iproute2', 'kpartx', 'language-pack-en', 'language-pack-en-base',
            'libapparmor1', 'libaudit-common', 'libaudit1', 'libbinutils', 'libctf-nobfd0',
            'libctf0', 'libgprofng0', 'libgssapi-krb5-2', 'libk5crypto3', 'libkrb5-3',
            'libkrb5support0', 'libproc2-0', 'libsframe1', 'linux-base', 'procps',
            'python-apt-common', 'python3-apt', 'python3-distupgrade', 'qemu-guest-agent',
            'tzdata', 'ubuntu-release-upgrader-core'}
FROZEN = {'apparmor': '4.0.1really4.0.1-0ubuntu0.24.04.5',
          'console-setup': '1.226ubuntu1', 'console-setup-linux': '1.226ubuntu1',
          'keyboard-configuration': '1.226ubuntu1',
          'linux-firmware': '20240318.git3b128b60-0ubuntu2.26'}
SERVICES = ('nginx', 'karcher-api', 'ssh', 'postgresql@16-main', 'redis-server',
            'cron', 'fail2ban', 'systemd-resolved')
TIMERS = ('apt-daily.timer', 'apt-daily-upgrade.timer')
CONFIGS = ('/etc/karcher/api.env', '/etc/karcher/client.env',
           '/etc/systemd/system/karcher-api.service', '/etc/karcher-security/inbound.nft',
           '/etc/nginx/nginx.conf', '/etc/nginx/sites-available/st24',
           '/etc/nginx/conf.d/00-karcher-default-deny.conf', '/etc/ssh/sshd_config',
           '/var/www/st24/server/dist/index.js', '/var/lib/dpkg/statoverride',
           '/boot/initrd.img-6.8.0-147-generic', '/boot/vmlinuz-6.8.0-147-generic',
           '/boot/grub/grub.cfg')
POLICY = Path('/usr/sbin/policy-rc.d')
POLICY_BYTES = b'#!/bin/sh\n# KARCHER Ubuntu maintenance: no automatic service actions\nexit 101\n'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, label, *, env=None):
    p = subprocess.run(args, capture_output=True, env=env)
    with (BASE / (label + '.log')).open('ab') as stream:
        stream.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f'{label} failed; inspect root-only log')
    return p.stdout.decode()


def save(value):
    tmp = BASE / 'ubuntu-state.tmp'
    with tmp.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(BASE / 'ubuntu-state.json')


def load():
    if BASE.is_symlink() or BASE.stat().st_uid != 0 or BASE.stat().st_mode & 0o077:
        raise RuntimeError('Private directory ownership/mode invalid')
    return json.loads((BASE / 'ubuntu-state.json').read_text())


def inventory():
    text = run(['dpkg-query', '-W', '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\n'], 'inventory')
    # python-apt exposes native package names without Multi-Arch :amd64 suffixes.
    # Keep any foreign-architecture suffix distinct in the full inventory.
    return {n.removesuffix(':amd64'): v for n, status, v in (line.split('\t') for line in text.splitlines())
            if len(status) == 3 and status[1:] == 'i '}


def validate_plan(text, rows):
    names = {r['package'] for r in rows}
    if names != EXPECTED or len(rows) != len(names):
        raise RuntimeError('Selection differs from the reviewed 30-package allowlist')
    installs = re.findall(r'^Inst (\S+) \[([^\]]+)\] \((\S+)', text, re.M)
    expected = {r['package']: (r['old'], r['new']) for r in rows}
    if len(installs) != len(rows) or {n: (old, new) for n, old, new in installs} != expected:
        raise RuntimeError('APT plan differs from the exact existing-package upgrades')
    if re.search(r'^(?:Remv|Purg) ', text, re.M):
        raise RuntimeError('Removals/purges are forbidden')
    # Also reject new installations, which lack [installed-version].
    if len(re.findall(r'^Inst ', text, re.M)) != len(installs):
        raise RuntimeError('Unexpected newly installed dependency')


def apt_command(rows):
    # APT may also upgrade reverse dependencies/source siblings. Explicitly keep
    # deferred packages at their inventoried versions, without persistent holds.
    return ['apt-get', '-s', '--no-remove', '--no-install-recommends', '--only-upgrade',
            'install', *(r['package'] + '=' + r['new'] for r in rows),
            *(n + '=' + v for n, v in FROZEN.items())]


def unit(name):
    text = run(['systemctl', 'show', name, '-p', 'ActiveState', '-p', 'MainPID'], 'unit-' + name)
    return dict(s.split('=', 1) for s in text.splitlines())


def check_artifacts(rows):
    for label in ('old', 'new'):
        receipt = json.loads((BASE / (label + '-receipt.json')).read_text())
        for row in rows:
            r = receipt[row['package']]
            if Path(r['file']).name != r['file'] or r['version'] != row[label]:
                raise RuntimeError('Artifact metadata mismatch')
            if sha(BASE / (label + '-packages') / r['file']) != r['sha256']:
                raise RuntimeError('Artifact checksum mismatch')
    test = json.loads((BASE / 'rollback-payload-verification.json').read_text())
    if test['selectedPackages'] != 30 or test['payloadFilesMatch'] < 1800:
        raise RuntimeError('Verified offline recovery payloads are missing')


def unchanged(state):
    if any(unit(n) != value for n, value in state['services'].items()):
        raise RuntimeError('Shop/SSH/network service PID or state changed')
    if any(sha(p) != value for p, value in state['configs'].items()):
        raise RuntimeError('Protected shop/network/boot configuration changed')
    if run(['crontab', '-l'], 'cron-current') != state['cron']:
        raise RuntimeError('Root cron changed')
    if json.loads(run(['aa-status', '--json'], 'aa-current')) != state['apparmor']:
        raise RuntimeError('Active AppArmor policy changed')


def prepare():
    if (BASE / 'ubuntu-state.json').exists() or POLICY.exists() or POLICY.is_symlink():
        raise RuntimeError('Snapshot or service policy already exists')
    rows = json.loads((BASE / 'selected-packages.json').read_text())
    check_artifacts(rows)
    validate_plan(run(apt_command(rows), 'final-simulation'), rows)
    inv = inventory()
    if any(inv.get(r['package']) != r['old'] for r in rows) or any(inv.get(n) != v for n, v in FROZEN.items()):
        raise RuntimeError('Selected installed versions changed')
    state = {'phase': 'prepared', 'preparedAt': time.time(), 'rows': rows, 'inventory': inv,
             'services': {n: unit(n) for n in SERVICES}, 'configs': {p: sha(p) for p in CONFIGS},
             'cron': run(['crontab', '-l'], 'cron-baseline'),
             'apparmor': json.loads(run(['aa-status', '--json'], 'aa-baseline')),
             'qemuBefore': unit('qemu-guest-agent'),
             'timers': {n: unit(n)['ActiveState'] for n in TIMERS}}
    if any(v['ActiveState'] != 'active' for v in state['services'].values()):
        raise RuntimeError('Protected baseline service inactive')
    save(state)
    print('Prepared: 30 exact upgrades, verified local artifacts and protected baseline')


def cleanup():
    state = load()
    if POLICY.exists() or POLICY.is_symlink():
        if POLICY.is_symlink() or POLICY.read_bytes() != POLICY_BYTES:
            raise RuntimeError('Refusing to remove an unrelated policy')
        POLICY.unlink()
    for name, status in state['timers'].items():
        if status == 'active' and unit(name)['ActiveState'] != 'active':
            run(['systemctl', 'start', name], 'resume-' + name)


def apply():
    state = load()
    if state['phase'] != 'prepared' or inventory() != state['inventory']:
        raise RuntimeError('Prepared package state changed')
    unchanged(state)
    rows = state['rows']
    check_artifacts(rows)
    validate_plan(run(apt_command(rows), 'apply-simulation'), rows)
    from datetime import datetime
    backup = json.loads(Path('/var/backups/st24/.last-success.json').read_text())
    age = time.time() - datetime.fromisoformat(backup['checkedAt'].replace('Z', '+00:00')).timestamp()
    if backup['status'] != 'verified' or not 0 <= age < 3600:
        raise RuntimeError('Verified backup less than one hour old required')
    if not (BASE / 'etc-dpkg-before.tar.gz').is_file():
        raise RuntimeError('Private configuration/package-database snapshot missing')
    state.update(phase='applying', startedAt=time.time())
    save(state)
    try:
        for name in TIMERS:
            run(['systemctl', 'stop', name], 'pause-' + name)
        if POLICY.exists() or POLICY.is_symlink():
            raise RuntimeError('Service policy appeared concurrently')
        fd = os.open(POLICY, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o755)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o755)
            stream.write(POLICY_BYTES)
            stream.flush()
            os.fsync(stream.fileno())
        receipt = json.loads((BASE / 'new-receipt.json').read_text())
        # Dependency resolution was checked by APT; dpkg consumes exactly the
        # authenticated local allowlist, without downloads or APT restart hooks.
        env = dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_SUSPEND='1')
        run(['dpkg', '--force-confold', '--install',
             *(str(BASE / 'new-packages' / receipt[r['package']]['file']) for r in rows)],
            'install-ubuntu', env=env)
        unchanged(state)
    finally:
        cleanup()
    if state['qemuBefore']['ActiveState'] == 'active':
        run(['systemctl', 'restart', 'qemu-guest-agent'], 'refresh-qemu-agent')
    state.update(phase='applied', completedAt=time.time())
    save(state)
    print(json.dumps(verify()))


def verify():
    state = load()
    unchanged(state)
    expected = dict(state['inventory'])
    expected.update({r['package']: r['new'] for r in state['rows']})
    if inventory() != expected:
        raise RuntimeError('Package state differs from the reviewed upgrades')
    if run(['dpkg', '--audit'], 'dpkg-audit').strip():
        raise RuntimeError('Incomplete package transaction')
    # Resuming a persistent timer can immediately run apt-daily. Wait for its
    # legitimate frontend lock; never delete lock files or kill package jobs.
    run(['apt-get', '-o', 'DPkg::Lock::Timeout=60', 'check'], 'dependency-check')
    run(['nginx', '-t'], 'nginx-syntax')
    run(['/usr/sbin/sshd', '-t'], 'sshd-syntax')
    if POLICY.exists() or POLICY.is_symlink():
        raise RuntimeError('Temporary policy still installed')
    if any(unit(n)['ActiveState'] != v for n, v in state['timers'].items()):
        raise RuntimeError('Original APT timer state not restored')
    if state['qemuBefore']['ActiveState'] == 'active' and unit('qemu-guest-agent')['ActiveState'] != 'active':
        raise RuntimeError('Guest agent not healthy')
    for path in ['/api/health/ready', '/api/health/notifications']:
        with urllib.request.urlopen('https://xn---24-3edf.xn--p1ai' + path, timeout=10) as response:
            if response.status != 200 or json.load(response)['status'] != 'ok':
                raise RuntimeError('Public health not healthy')
    return {'verifiedAt': time.time(), 'upgradedPackages': len(state['rows']),
            'protectedPidsConfigsBootAndApparmorUnchanged': True, 'rebootPerformed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply', 'cleanup', 'verify', 'accept'))
    action = parser.parse_args().action
    if os.geteuid() != 0:
        raise SystemExit('root required')
    os.umask(0o077)
    import fcntl
    fd = os.open('/run/lock/karcher-ubuntu-update.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    if action == 'prepare':
        prepare()
    elif action == 'apply':
        apply()
    elif action == 'cleanup':
        cleanup()
    elif action == 'verify':
        print(json.dumps(verify()))
    else:
        result = verify()
        state = load()
        if state['phase'] != 'applied':
            raise RuntimeError('Only a completed update can be accepted')
        state.update(phase='accepted', acceptedAt=time.time(), acceptance=result)
        save(state)
        print('Ubuntu maintenance accepted; no reboot or automatic downgrade')


if __name__ == '__main__':
    main()
