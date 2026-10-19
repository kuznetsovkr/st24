#!/usr/bin/env python3
"""Host-specific final Ubuntu updates and guarded, explicitly requested reboot.

No GRUB/NVRAM installation, no AppArmor service activation, no automatic downgrade.
Secrets and recovery inputs remain in the root-only snapshot, never in Git.
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

BASE = Path('/root/karcher-ubuntu-boot-maintenance-20261019')
KERNEL = '6.8.0-147-generic'
UPGRADES = {'apparmor', 'console-setup', 'console-setup-linux',
            'keyboard-configuration', 'linux-firmware'}
NEW = {'linux-firmware-' + n for n in (
    'amd-graphics', 'amd-misc', 'broadcom-wireless', 'intel-graphics', 'intel-misc',
    'intel-wireless', 'marvell-prestera', 'marvell-wireless', 'mediatek',
    'mellanox-spectrum', 'misc', 'netronome', 'nvidia-graphics', 'qlogic',
    'qualcomm-graphics', 'qualcomm-misc', 'qualcomm-wireless', 'realtek')}
SERVICES = ('nginx', 'karcher-api', 'ssh', 'postgresql@16-main', 'redis-server',
            'cron', 'fail2ban', 'systemd-resolved', 'karcher-firewall')
TIMERS = ('apt-daily.timer', 'apt-daily-upgrade.timer')
CONFIGS = ('/etc/karcher/api.env', '/etc/karcher/client.env',
           '/etc/systemd/system/karcher-api.service', '/etc/karcher-security/inbound.nft',
           '/etc/nginx/nginx.conf', '/etc/nginx/sites-available/st24',
           '/etc/nginx/conf.d/00-karcher-default-deny.conf', '/etc/ssh/sshd_config',
           '/root/.ssh/authorized_keys', '/var/www/st24/server/dist/index.js',
           '/var/lib/dpkg/statoverride', '/boot/grub/grub.cfg',
           '/boot/vmlinuz-6.8.0-147-generic', '/boot/vmlinuz-6.8.0-142-generic',
           '/boot/initrd.img-6.8.0-142-generic', '/boot/efi/EFI/BOOT/bootx64.efi',
           '/boot/efi/EFI/BOOT/grubx64.efi', '/boot/efi/EFI/BOOT/mmx64.efi')
POLICY = Path('/usr/sbin/policy-rc.d')
POLICY_BYTES = b'#!/bin/sh\n# KARCHER final Ubuntu maintenance; suppress service actions\nexit 101\n'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args, label, *, env=None):
    p = subprocess.run(args, capture_output=True, env=env)
    with (BASE / (label + '.log')).open('ab') as stream:
        stream.write(p.stdout + p.stderr)
    if p.returncode:
        raise RuntimeError(f'{label} failed; inspect its private log')
    return p.stdout.decode()


def save(value):
    tmp = BASE / 'boot-state.tmp'
    with tmp.open('x') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(BASE / 'boot-state.json')


def load():
    if BASE.is_symlink() or BASE.stat().st_uid != 0 or BASE.stat().st_mode & 0o077:
        raise RuntimeError('Private directory mode/owner invalid')
    return json.loads((BASE / 'boot-state.json').read_text())


def inventory():
    text = run(['dpkg-query', '-W', '-f=${binary:Package}\t${db:Status-Abbrev}\t${Version}\n'], 'inventory')
    return {n.removesuffix(':amd64'): v for n, status, v in (s.split('\t') for s in text.splitlines())
            if len(status) == 3 and status[1:] == 'i '}


def unit(name):
    text = run(['systemctl', 'show', name, '-p', 'ActiveState', '-p', 'MainPID'], 'unit-' + name)
    return dict(s.split('=', 1) for s in text.splitlines())


def enabled(name):
    # is-enabled returns 1 for the legitimate disabled baseline.
    return subprocess.run(['systemctl', 'is-enabled', name], capture_output=True,
                          text=True).stdout.strip()


def boot_id():
    return Path('/proc/sys/kernel/random/boot_id').read_text().strip()


def plan_command(rows, *, simulate=True):
    return ['apt-get', '-o', 'DPkg::Lock::Timeout=60',
            '-o', 'Dir::Cache::archives=' + str(BASE / 'archives'),
            '-o', 'APT::Sandbox::User=root',
            *(['-s'] if simulate else ['-y', '--no-download', '-o', 'Dpkg::Options::=--force-confold']),
            '--no-remove', '--no-install-recommends', 'install',
            *(r['name'] + '=' + r['new'] for r in rows)]


def validate_plan(text, rows):
    if (len(rows) != 23 or {r['name'] for r in rows if r['old']} != UPGRADES
            or {r['name'] for r in rows if not r['old']} != NEW):
        raise RuntimeError('Manifest is not the reviewed 5 upgrades and 18 firmware packages')
    found = re.findall(r'^Inst (\S+)(?: \[([^\]]+)\])? \((\S+)', text, re.M)
    expected = {r['name']: (r['old'] or '', r['new']) for r in rows}
    if len(found) != 23 or {n: (old, new) for n, old, new in found} != expected:
        raise RuntimeError('APT plan differs from reviewed versions/installed state')
    if re.search(r'^(?:Remv|Purg) ', text, re.M):
        raise RuntimeError('Package removals/purges forbidden')


def artifacts(rows):
    receipt = json.loads((BASE / 'new-receipt.json').read_text())
    for r in rows:
        entry = receipt[r['name']]
        if Path(entry['file']).name != entry['file'] or entry['sha256'] != r['sha256']:
            raise RuntimeError('Package receipt differs from signed index')
        if sha(BASE / 'archives' / entry['file']) != r['sha256']:
            raise RuntimeError('Authenticated archive changed')
    old = json.loads((BASE / 'old-receipt.json').read_text())
    if set(old) != UPGRADES:
        raise RuntimeError('Old package set incomplete')
    for r in old.values():
        if Path(r['file']).name != r['file'] or sha(BASE / 'old-packages' / r['file']) != r['sha256']:
            raise RuntimeError('Offline recovery archive changed')
    proof = json.loads((BASE / 'preflight.json').read_text())
    if proof['apparmorCompileRc'] or not proof['activePolicyUnchanged'] or proof['oldPayloadFiles'] < 4000:
        raise RuntimeError('AppArmor/offline recovery preflight missing')
    snap = json.loads((BASE / 'snapshot-receipt.json').read_text())
    if sha(BASE / 'boot-etc-dpkg-before.tar.gz') != snap['sha256']:
        raise RuntimeError('Boot/config/package database snapshot changed')


def unchanged(state, *, pids=True):
    for name, before in state['services'].items():
        now = unit(name)
        if now['ActiveState'] != 'active' or (pids and now != before):
            raise RuntimeError('Protected service changed/not active')
    if any(sha(p) != value for p, value in state['configs'].items()):
        raise RuntimeError('Protected shop/SSH/firewall/kernel/EFI configuration changed')
    if run(['crontab', '-l'], 'cron-current') != state['cron']:
        raise RuntimeError('Root cron changed')
    if enabled('apparmor') != state['apparmorEnabled']:
        raise RuntimeError('AppArmor boot activation differs from baseline')
    for name in state['masked']:
        if enabled(name) != 'masked':
            raise RuntimeError('Retired service mask changed')


def prepare():
    if (BASE / 'boot-state.json').exists() or POLICY.exists() or POLICY.is_symlink():
        raise RuntimeError('Snapshot/policy already exists')
    rows = json.loads((BASE / 'packages.json').read_text())
    artifacts(rows)
    validate_plan(run(plan_command(rows), 'prepare-plan'), rows)
    inv = inventory()
    if any(inv.get(r['name']) != r['old'] for r in rows):
        raise RuntimeError('Original package set changed')
    source = Path('/boot/initrd.img-' + KERNEL)
    shutil.copy2(source, BASE / 'initrd-before.img')
    masked = run(['systemctl', 'list-unit-files', '--state=masked', '--no-legend', '--no-pager'], 'masked-before')
    state = {'phase': 'prepared', 'preparedAt': time.time(), 'bootBefore': boot_id(),
             'rows': rows, 'inventory': inv, 'configs': {p: sha(p) for p in CONFIGS},
             'initrdBeforeSha': sha(source), 'initrdMode': source.stat().st_mode & 0o777,
             'services': {n: unit(n) for n in SERVICES},
             'cron': run(['crontab', '-l'], 'cron-before'),
             'apparmorEnabled': enabled('apparmor'),
             'timers': {n: unit(n)['ActiveState'] for n in TIMERS},
             'masked': [s.split()[0] for s in masked.splitlines()]}
    if state['apparmorEnabled'] != 'disabled' or any(v['ActiveState'] != 'active' for v in state['services'].values()):
        raise RuntimeError('Unexpected service/AppArmor baseline')
    save(state)
    print('Prepared: authenticated packages, boot snapshot, fallback and service guards')


def cleanup():
    state = load()
    if POLICY.exists() or POLICY.is_symlink():
        if POLICY.is_symlink() or POLICY.read_bytes() != POLICY_BYTES:
            raise RuntimeError('Refusing to remove an unrelated policy')
        POLICY.unlink()
    for name, status in state['timers'].items():
        if status == 'active' and unit(name)['ActiveState'] != 'active':
            run(['systemctl', 'start', name], 'resume-' + name)


def fresh_backup(after=0):
    from datetime import datetime
    last = json.loads(Path('/var/backups/st24/.last-success.json').read_text())
    checked = datetime.fromisoformat(last['checkedAt'].replace('Z', '+00:00')).timestamp()
    if last['status'] != 'verified' or not 0 <= time.time() - checked < 3600 or checked < after:
        raise RuntimeError('Fresh, verified offsite backup required')


def restore_triggered_initrds(state):
    """Preserve standard dracut trigger outputs, then restore the boot baseline.

    This image registers dracut for the update-initramfs trigger even though no
    update-initramfs executable is installed. It rebuilds ALL kernel initrds.
    Keep 142/88 unchanged and build the final 147 image separately afterwards.
    """
    snap = json.loads((BASE / 'snapshot-receipt.json').read_text())
    archive = BASE / 'boot-etc-dpkg-before.tar.gz'
    if sha(archive) != snap['sha256']:
        raise RuntimeError('Original boot snapshot changed')
    versions = ['6.8.0-142-generic', KERNEL, '6.8.0-88-generic']
    directory = BASE / 'initrd-restore'
    directory.mkdir(mode=0o700, exist_ok=True)
    names = ['boot/initrd.img-' + v for v in versions]
    run(['tar', '-xzf', str(archive), '-C', str(directory), *names], 'extract-original-initrds')
    automatic = BASE / 'automatic-initrds'
    automatic.mkdir(mode=0o700, exist_ok=True)
    log = (BASE / 'install-final-packages.log').read_text()
    result = {}
    for version, name in zip(versions, names):
        original = directory / name
        live = Path('/') / name
        before = sha(live)
        wanted = sha(original)
        if original.is_symlink() or original.stat().st_uid != 0:
            raise RuntimeError('Invalid original boot image metadata')
        if version == KERNEL and wanted != state['initrdBeforeSha']:
            raise RuntimeError('Boot snapshot does not match prepared baseline')
        if before == wanted:
            continue
        if ('dracut: Generating /' + name) not in log or live.stat().st_mtime < state['applyAt']:
            raise RuntimeError('Image change cannot be attributed to this package trigger')
        saved = automatic / live.name
        if saved.exists() and sha(saved) != before:
            raise RuntimeError('Automatic image receipt collision')
        shutil.copy2(live, saved)
        replacement = Path(str(live) + '.karcher-restore')
        if replacement.exists() or replacement.is_symlink():
            raise RuntimeError('Fallback restore destination collision')
        mode = oct(original.stat().st_mode & 0o777)[2:]
        run(['install', '-o', 'root', '-g', 'root', '-m', mode, str(original), str(replacement)],
            'stage-original-' + version)
        if sha(live) != before or sha(replacement) != wanted:
            raise RuntimeError('Boot image changed concurrently')
        replacement.replace(live)
        result[version] = {'automaticSha': before, 'restoredSha': wanted}
    with (BASE / 'automatic-initrd-generation.json').open('w') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')


def recover_packages():
    """Resume only a completely installed, guarded transaction; never reinstall."""
    state = load()
    if state['phase'] != 'applying' or boot_id() != state['bootBefore']:
        raise RuntimeError('Recovery requires the interrupted pre-reboot transaction')
    expected = dict(state['inventory'])
    expected.update({r['name']: r['new'] for r in state['rows']})
    if inventory() != expected or run(['dpkg', '--audit'], 'recovery-audit').strip():
        raise RuntimeError('Package transaction is not complete; manual review required')
    run(['apt-get', '-o', 'DPkg::Lock::Timeout=60', 'check'], 'recovery-dependencies')
    restore_triggered_initrds(state)
    unchanged(state)
    cleanup()
    state.update(phase='packages_applied', packagesAt=time.time(),
                 recoveredAfterDracutTrigger=True)
    save(state)
    print('Completed package transaction verified; original fallback initrds restored')


def apply():
    state = load()
    if state['phase'] != 'prepared' or boot_id() != state['bootBefore'] or inventory() != state['inventory']:
        raise RuntimeError('Prepared state changed')
    unchanged(state)
    artifacts(state['rows'])
    validate_plan(run(plan_command(state['rows']), 'actual-plan'), state['rows'])
    fresh_backup()
    state.update(phase='applying', applyAt=time.time())
    save(state)
    try:
        for name in TIMERS:
            run(['systemctl', 'stop', name], 'pause-' + name)
        fd = os.open(POLICY, os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY, 0o755)
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o755)
            stream.write(POLICY_BYTES)
            stream.flush()
            os.fsync(stream.fileno())
        run(plan_command(state['rows'], simulate=False), 'install-final-packages',
            env=dict(os.environ, DEBIAN_FRONTEND='noninteractive', NEEDRESTART_SUSPEND='1'))
        # Preserve the operator's existing disabled state. The package's own
        # postinst may reload kernel profiles; that is not a new boot policy.
        if enabled('apparmor') == 'enabled' and state['apparmorEnabled'] == 'disabled':
            run(['systemctl', 'disable', 'apparmor'], 'preserve-apparmor-boot-setting')
        restore_triggered_initrds(state)
        unchanged(state)
    finally:
        cleanup()
    state.update(phase='packages_applied', packagesAt=time.time())
    save(state)
    print('Five updates and 18 firmware packages installed; build/validate initrd next')


def build_initrd():
    state = load()
    if state['phase'] != 'packages_applied' or boot_id() != state['bootBefore']:
        raise RuntimeError('Initrd build requires the completed pre-reboot update')
    unchanged(state)
    target = Path('/boot/initrd.img-' + KERNEL)
    if sha(target) != state['initrdBeforeSha']:
        raise RuntimeError('Original initrd changed outside the staged build')
    candidate = BASE / 'initrd-candidate.img'
    run(['dracut', '-q', '--force', str(candidate), KERNEL], 'dracut-candidate')
    listing = run(['lsinitrd', str(candidate)], 'candidate-list')
    if KERNEL not in listing or not re.search(r'\sinit(?:\s|$| ->)', listing):
        raise RuntimeError('Candidate initrd has no target kernel/init')
    # Root disk/network/filesystem drivers are built into this specific kernel.
    for module in ['virtio', 'virtio_pci', 'virtio_blk', 'virtio_net', 'ext4']:
        if run(['modinfo', '-k', KERNEL, '-F', 'filename', module], 'builtin-' + module).strip() != '(builtin)':
            raise RuntimeError('Root driver assumption differs from preflight')
    run(['grub-script-check', '/boot/grub/grub.cfg'], 'grub-script-check')
    unchanged(state)
    replacement = Path(str(target) + '.karcher-new')
    if replacement.exists() or replacement.is_symlink():
        raise RuntimeError('Initrd destination collision')
    run(['install', '-o', 'root', '-g', 'root', '-m', oct(state['initrdMode'])[2:],
         str(candidate), str(replacement)], 'stage-initrd')
    with replacement.open('rb') as stream:
        os.fsync(stream.fileno())
    if sha(target) != state['initrdBeforeSha']:
        raise RuntimeError('Initrd changed during build')
    replacement.replace(target)
    state.update(phase='boot_ready', initrdSha=sha(target), bootReadyAt=time.time())
    save(state)
    print('Validated dracut image installed atomically; kernel 142 fallback unchanged')


def verify():
    state = load()
    rebooted = boot_id() != state['bootBefore']
    unchanged(state, pids=not rebooted)
    expected = dict(state['inventory'])
    expected.update({r['name']: r['new'] for r in state['rows']})
    if inventory() != expected:
        raise RuntimeError('Unreviewed package changes')
    if run(['dpkg', '--audit'], 'audit').strip():
        raise RuntimeError('Dpkg reports incomplete packages')
    run(['apt-get', '-o', 'DPkg::Lock::Timeout=60', 'check'], 'dependencies')
    run(['nginx', '-t'], 'nginx-syntax')
    run(['/usr/sbin/sshd', '-t'], 'sshd-syntax')
    if POLICY.exists() or POLICY.is_symlink():
        raise RuntimeError('Transient service policy remains installed')
    if any(unit(n)['ActiveState'] != v for n, v in state['timers'].items()):
        raise RuntimeError('APT timers not restored')
    if sha('/boot/initrd.img-' + KERNEL) != state.get('initrdSha'):
        raise RuntimeError('Validated boot image changed')
    if rebooted and run(['uname', '-r'], 'running-kernel').strip() != KERNEL:
        raise RuntimeError('Unexpected kernel after reboot')
    reports = []
    for path in ['/api/health/ready', '/api/health/notifications']:
        with urllib.request.urlopen('https://xn---24-3edf.xn--p1ai' + path, timeout=10) as response:
            value = json.load(response)
            if response.status != 200 or value['status'] != 'ok' or response.headers.get('Cache-Control') != 'no-store':
                raise RuntimeError('Public health not healthy/fresh')
            reports.append(value)
    with urllib.request.urlopen('http://127.0.0.1:4000/api/health/ready', timeout=10) as response:
        direct = json.load(response)
    if direct['instanceId'] != reports[0]['instanceId']:
        raise RuntimeError('Public readiness does not reach the local instance')
    n = reports[1]
    if n['worker']['status'] != 'ok' or any(b['status'] != 'ok' for b in n['bots']) or any(n['invariants'].values()) or n['outbox']['dead']:
        raise RuntimeError('Notification/business health not healthy')
    return {'verifiedAt': time.time(), 'rebooted': rebooted, 'bootId': boot_id(),
            'kernel': run(['uname', '-r'], 'kernel-report').strip(),
            'apiPID': unit('karcher-api')['MainPID'], 'readyInstance': direct['instanceId'],
            'bots': len(n['bots']), 'outbox': n['outbox']}


def request_reboot():
    state = load()
    if state['phase'] != 'boot_ready' or boot_id() != state['bootBefore']:
        raise RuntimeError('Not in validated pre-reboot state')
    verify()
    fresh_backup(after=state['bootReadyAt'])
    state.update(phase='reboot_requested', rebootRequestedAt=time.time())
    save(state)
    run(['shutdown', '-r', '+1', 'Karcher: approved Ubuntu maintenance'], 'reboot-request')
    print('Approved graceful reboot scheduled in one minute; monitor independent SSH/HTTP')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'apply', 'cleanup', 'recover-packages', 'build-initrd', 'verify', 'request-reboot', 'accept'))
    parser.add_argument('--console-confirmed', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('root required')
    os.umask(0o077)
    import fcntl
    fd = os.open('/run/lock/karcher-boot-maintenance.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    if args.action in ('apply', 'request-reboot') and not args.console_confirmed:
        raise RuntimeError('Operator must confirm working provider console')
    if args.action == 'prepare':
        prepare()
    elif args.action == 'apply':
        apply()
    elif args.action == 'cleanup':
        cleanup()
    elif args.action == 'recover-packages':
        recover_packages()
    elif args.action == 'build-initrd':
        build_initrd()
    elif args.action == 'verify':
        print(json.dumps(verify()))
    elif args.action == 'request-reboot':
        request_reboot()
    else:
        result = verify()
        state = load()
        if not result['rebooted'] or state['phase'] != 'reboot_requested':
            raise RuntimeError('Acceptance requires the requested reboot on a fresh boot')
        state.update(phase='accepted', acceptedAt=time.time(), acceptance=result)
        save(state)
        print('Reboot accepted: new kernel, fresh shop process, protected configuration preserved')


if __name__ == '__main__':
    main()
