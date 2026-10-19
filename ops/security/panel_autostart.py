#!/usr/bin/env python3
"""Retire the reviewed ISPmanager cron entry points on the existing shop VPS.

Host-specific, root-only and deliberately separate from application deployment.
Prepare a private snapshot, arm an independent rollback, then apply and verify.
Never changes SSH/firewall, packages, service masks or application configuration.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import time


DAILY = Path('/etc/cron.daily/phpsess_cron')
CORE = Path('/usr/local/mgr5/bin/core')
BACKUP_JOB = '30 3 * * * /usr/local/bin/st24-backup.sh >> /var/log/st24-backup.log 2>&1'
MARKER = '# KARCHER_DISABLED_ISPMANAGER '
OVERRIDE = f'root root 644 {DAILY}'
PROTECTED = (
    'karcher-api.service', 'nginx.service', 'ssh.service',
    'postgresql@16-main.service', 'redis-server.service', 'cron.service',
    'fail2ban.service', 'karcher-firewall.service', 'certbot.timer',
    'karcher-backup-health.timer',
)
CONFIG_FILES = (
    '/etc/karcher/api.env', '/etc/karcher/client.env',
    '/etc/nginx/nginx.conf', '/etc/nginx/sites-available/st24',
    '/etc/nginx/conf.d/00-karcher-default-deny.conf',
    '/etc/ssh/sshd_config.d/00-karcher-access.conf',
    '/etc/karcher-security/inbound.nft',
)


def run(args, *, allowed=(0,), **kwargs):
    # Do not emit raw stderr/cron/configuration, which may contain secrets.
    result = subprocess.run(args, capture_output=True, timeout=30, **kwargs)
    if result.returncode not in allowed:
        raise RuntimeError(f'Command failed: {args[0]} (exit {result.returncode})')
    return result


def digest(data):
    return hashlib.sha256(data).hexdigest()


def pause_panel_jobs(data):
    lines = data.decode('utf-8').splitlines(keepends=True)
    active = [s for s in lines if s.strip() and not s.lstrip().startswith('#')]
    panel = [s for s in active if '/usr/local/mgr5/' in s]
    others = [s.strip() for s in active if '/usr/local/mgr5/' not in s]
    if others != [BACKUP_JOB]:
        raise RuntimeError('Unreviewed non-panel cron entries; refusing changes')
    if not panel:
        raise RuntimeError('No active panel jobs; take a new inventory first')
    result = ''.join(MARKER + s if s in panel else s for s in lines).encode('utf-8')
    return result, len(panel)


def checked_daily():
    st = DAILY.lstat()
    if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_gid != 0:
        raise RuntimeError('Unexpected daily hook type/owner')
    return st


def override():
    result = run(['dpkg-statoverride', '--list', str(DAILY)], allowed=(0, 1))
    return result.stdout.decode().strip()


def cron():
    return run(['crontab', '-u', 'root', '-l']).stdout


def properties(unit):
    result = run(['systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'MainPID',
                  '-p', 'UnitFileState'])
    return dict(s.split('=', 1) for s in result.stdout.decode().splitlines())


def cores():
    found = []
    for path in Path('/proc').iterdir():
        if not path.name.isdigit():
            continue
        try:
            if (path / 'exe').resolve(strict=True) != CORE:
                continue
            args = (path / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
            if len(args) != 2 or args[1] not in (b'core', b'ispmgr'):
                raise RuntimeError('Unreviewed panel process arguments')
            # The remaining stat fields start at field 3, after the final ')'.
            start = (path / 'stat').read_text().rsplit(')', 1)[1].split()[19]
            found.append({'pid': int(path.name), 'module': args[1].decode(),
                          'start': start})
        except (FileNotFoundError, ProcessLookupError):
            continue
    return found


def stop_cores():
    for entry in cores():
        # Pin the process, then re-check its identity before sending SIGTERM.
        try:
            fd = os.pidfd_open(entry['pid'])
        except ProcessLookupError:
            continue
        try:
            if entry not in cores():
                continue
            signal.pidfd_send_signal(fd, signal.SIGTERM)
        finally:
            os.close(fd)
    deadline = time.monotonic() + 25
    while cores() and time.monotonic() < deadline:
        time.sleep(0.2)
    if cores():
        raise RuntimeError('Panel did not stop on SIGTERM; not using SIGKILL')


def save(base, name, value):
    target = base / name
    tmp = base / (name + '.tmp')
    with tmp.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    tmp.chmod(0o600)
    tmp.replace(target)


def prepare(base):
    if base.exists() or base.is_symlink():
        raise RuntimeError('Snapshot already exists')
    st = checked_daily()
    if stat.S_IMODE(st.st_mode) != 0o755 or override():
        raise RuntimeError('Daily hook mode/override differs from inventory')
    if str(DAILY) not in run(['run-parts', '--test', '/etc/cron.daily']).stdout.decode().splitlines():
        raise RuntimeError('Daily hook is not currently selected')
    before = cron()
    after, count = pause_panel_jobs(before)
    units = {u: properties(u) for u in PROTECTED}
    if any(p['ActiveState'] != 'active' for p in units.values()):
        raise RuntimeError('Protected services are not healthy before changes')
    if properties('ihttpd.service')['UnitFileState'] != 'masked':
        raise RuntimeError('Panel service is not masked')
    state = {'phase': 'prepared', 'createdAt': time.time(), 'panelJobs': count,
             'dailyHash': digest(DAILY.read_bytes()), 'dailyMode': stat.S_IMODE(st.st_mode),
             'cronBeforeHash': digest(before), 'cronAfterHash': digest(after),
             'units': units, 'cores': cores(),
             'configHashes': {p: digest(Path(p).read_bytes()) for p in CONFIG_FILES}}
    base.mkdir(mode=0o700)
    for name, data in [('root.crontab.before', before), ('root.crontab.after', after)]:
        (base / name).write_bytes(data)
        (base / name).chmod(0o600)
    save(base, 'state.json', state)
    print(json.dumps({'phase': 'prepared', 'snapshot': str(base), 'panelJobs': count}))


def state_of(base):
    if base.is_symlink() or not base.is_dir():
        raise RuntimeError('Invalid snapshot directory')
    st = base.stat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) != 0o700:
        raise RuntimeError('Snapshot is not root-only')
    state = json.loads((base / 'state.json').read_text())
    for name, key in [('root.crontab.before', 'cronBeforeHash'),
                      ('root.crontab.after', 'cronAfterHash')]:
        if digest((base / name).read_bytes()) != state[key]:
            raise RuntimeError('Snapshot cron integrity check failed')
    return state


def verify(base):
    state = state_of(base)
    st = checked_daily()
    if digest(DAILY.read_bytes()) != state['dailyHash']:
        raise RuntimeError('Daily hook content unexpectedly changed')
    if stat.S_IMODE(st.st_mode) != 0o644 or override() != OVERRIDE:
        raise RuntimeError('Persistent non-executable override is missing')
    selected = run(['run-parts', '--test', '/etc/cron.daily']).stdout.decode().splitlines()
    if str(DAILY) in selected:
        raise RuntimeError('Daily hook is still runnable by cron')
    if digest(cron()) != state['cronAfterHash'] or cores():
        raise RuntimeError('Panel jobs or processes returned')
    units = {u: properties(u) for u in PROTECTED}
    if units != state['units']:
        raise RuntimeError('Protected service state/PID changed')
    if properties('ihttpd.service')['UnitFileState'] != 'masked':
        raise RuntimeError('Panel service mask changed')
    if any(digest(Path(p).read_bytes()) != h for p, h in state['configHashes'].items()):
        raise RuntimeError('Protected configuration changed')
    return {'verifiedAt': time.time(), 'panelJobs': 0, 'panelCores': 0,
            'dailySelected': False, 'persistentOverride': True,
            'protectedPidsAndConfigsUnchanged': True}


def apply(base):
    state = state_of(base)
    if state['phase'] != 'prepared' or digest(cron()) != state['cronBeforeHash']:
        raise RuntimeError('State/cron changed since preparation')
    if override() or digest(DAILY.read_bytes()) != state['dailyHash']:
        raise RuntimeError('Daily hook changed since preparation')
    checked_daily()
    if not (base / 'timer-selftest.passed').exists():
        raise RuntimeError('Independent timer self-test is required')
    timer = run(['systemctl', 'is-active', 'karcher-panel-autostart-rollback.timer'])
    if timer.stdout.strip() != b'active':
        raise RuntimeError('Independent rollback timer is not armed')
    # Persist intent before the first mutation so a disconnected caller is safe.
    state['phase'] = 'applying'
    save(base, 'state.json', state)
    run(['dpkg-statoverride', '--update', '--add', 'root', 'root', '0644', str(DAILY)])
    run(['crontab', '-u', 'root', str(base / 'root.crontab.after')])
    stop_cores()
    result = verify(base)
    state['phase'] = 'applied'
    save(base, 'state.json', state)
    save(base, 'acceptance.json', result)
    print(json.dumps(result))


def rollback(base, *, manual=False):
    state = state_of(base)
    if state['phase'] == 'rolled_back' or (state['phase'] == 'accepted' and not manual):
        print('No rollback: already accepted or rolled back')
        return
    checked_daily()
    if digest(DAILY.read_bytes()) != state['dailyHash']:
        raise RuntimeError('Refusing rollback over independently changed daily hook')
    current = override()
    if current not in ('', OVERRIDE):
        raise RuntimeError('Refusing rollback over unrelated statoverride')
    if digest(cron()) not in (state['cronBeforeHash'], state['cronAfterHash']):
        raise RuntimeError('Refusing rollback over independently changed root cron')
    if current:
        run(['dpkg-statoverride', '--remove', str(DAILY)])
    # --remove intentionally does NOT restore permissions; do it explicitly.
    DAILY.chmod(state['dailyMode'])
    existing = {p['module'] for p in cores()}
    with (base / 'rollback.log').open('ab', buffering=0) as log:
        for module in sorted({p['module'] for p in state['cores']} - existing):
            subprocess.Popen([str(CORE), module], cwd=CORE.parent.parent,
                             stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                             start_new_session=True)
    run(['crontab', '-u', 'root', str(base / 'root.crontab.before')])
    state['phase'] = 'rolled_back'
    save(base, 'state.json', state)
    print('Original daily mode, override absence and root cron restored')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'selftest', 'apply', 'verify',
                                           'accept', 'rollback', 'revert'))
    parser.add_argument('snapshot', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if os.geteuid() != 0:
        raise SystemExit('root required')
    base = args.snapshot
    if base.parent != Path('/root') or not re.fullmatch(
            r'karcher-panel-autostart-\d{8}T\d{6}Z', base.name):
        raise SystemExit('Unexpected snapshot path')
    # Serialize the operator and the independent rollback/acceptance timer.
    # Import here so pure unit tests also work on a Windows development machine.
    import fcntl
    lock = os.open('/run/lock/karcher-panel-autostart.lock',
                   os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX)
    if args.action == 'prepare':
        prepare(base)
    elif args.action == 'selftest':
        state = state_of(base)
        if state['phase'] != 'prepared' or digest(cron()) != state['cronBeforeHash']:
            raise RuntimeError('Self-test requires an unchanged prepared snapshot')
        if override() or stat.S_IMODE(checked_daily().st_mode) != state['dailyMode']:
            raise RuntimeError('Self-test requires the original daily hook state')
        # Exercise the actual rollback handler from the independent timer,
        # before any changes; do not start previously inactive services.
        rollback(base)
        if digest(cron()) != state['cronBeforeHash'] or override():
            raise RuntimeError('Rollback self-test did not preserve the original state')
        state['phase'] = 'prepared'
        save(base, 'state.json', state)
        (base / 'timer-selftest.passed').touch(mode=0o600, exist_ok=False)
        print('Independent timer handler self-test passed')
    elif args.action == 'apply':
        apply(base)
    elif args.action == 'verify':
        print(json.dumps(verify(base)))
    elif args.action == 'accept':
        result = verify(base)
        state = state_of(base)
        if state['phase'] != 'applied':
            raise RuntimeError('Only an applied change can be accepted')
        state.update(phase='accepted', acceptedAt=time.time())
        save(base, 'acceptance.json', result)
        save(base, 'state.json', state)
        print('Accepted; cancel the independent rollback timer')
    else:
        rollback(base, manual=args.action == 'revert')


if __name__ == '__main__':
    main()
