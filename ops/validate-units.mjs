#!/usr/bin/env node

import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const opsDir = dirname(fileURLToPath(import.meta.url));
const unitDir = join(opsDir, 'systemd');

const allowedDirectives = {
  Unit: new Set([
    'Description',
    'Documentation',
    'Wants',
    'After',
    'StartLimitIntervalSec',
    'StartLimitBurst'
  ]),
  Service: new Set([
    'Type',
    'User',
    'Group',
    'Environment',
    'EnvironmentFile',
    'WorkingDirectory',
    'StateDirectory',
    'StateDirectoryMode',
    'LogsDirectory',
    'LogsDirectoryMode',
    'ReadWritePaths',
    'ExecStartPre',
    'ExecStart',
    'Restart',
    'RestartSec',
    'TimeoutStartSec',
    'TimeoutStopSec',
    'KillSignal',
    'StandardOutput',
    'StandardError',
    'UMask',
    'NoNewPrivileges',
    'PrivateDevices',
    'PrivateTmp',
    'ProtectSystem',
    'ProtectHome',
    'ProtectClock',
    'ProtectControlGroups',
    'ProtectHostname',
    'ProtectKernelLogs',
    'ProtectKernelModules',
    'ProtectKernelTunables',
    'ProtectProc',
    'ProcSubset',
    'RestrictAddressFamilies',
    'RestrictNamespaces',
    'RestrictRealtime',
    'RestrictSUIDSGID',
    'LockPersonality',
    'CapabilityBoundingSet',
    'AmbientCapabilities',
    'SystemCallArchitectures'
  ]),
  Timer: new Set([
    'OnCalendar',
    'Persistent',
    'AccuracySec',
    'RandomizedDelaySec',
    'Unit'
  ]),
  Install: new Set(['WantedBy'])
};

const hardening = new Map([
  ['NoNewPrivileges', 'yes'],
  ['PrivateDevices', 'yes'],
  ['PrivateTmp', 'yes'],
  ['ProtectSystem', 'strict'],
  ['ProtectHome', 'yes'],
  ['ProtectKernelTunables', 'yes'],
  ['RestrictNamespaces', 'yes'],
  ['RestrictRealtime', 'yes'],
  ['RestrictSUIDSGID', 'yes'],
  ['LockPersonality', 'yes'],
  ['CapabilityBoundingSet', ''],
  ['AmbientCapabilities', ''],
  ['RestrictAddressFamilies', 'AF_UNIX AF_INET AF_INET6']
]);

const parseUnit = (name, contents) => {
  const values = new Map();
  let section;
  for (const [index, rawLine] of contents.split('\n').entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = line.match(/^\[([A-Za-z]+)]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      assert.ok(allowedDirectives[section], `${name}:${index + 1}: unsupported section`);
      continue;
    }
    assert.ok(section, `${name}:${index + 1}: directive outside a section`);
    const separator = line.indexOf('=');
    assert.ok(separator > 0, `${name}:${index + 1}: invalid assignment`);
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    assert.ok(
      allowedDirectives[section].has(key),
      `${name}:${index + 1}: ${key} is not allowed in [${section}]`
    );
    const qualifiedKey = `${section}.${key}`;
    const existing = values.get(qualifiedKey) ?? [];
    existing.push(value);
    values.set(qualifiedKey, existing);
  }
  return values;
};

const one = (unit, key) => {
  const values = unit.get(key);
  assert.equal(values?.length, 1, `${key} must occur exactly once`);
  return values[0];
};

const unitNames = (await readdir(unitDir)).sort();
assert.deepEqual(unitNames, [
  'karcher-api.service',
  'karcher-monitor-check.service',
  'karcher-monitor-check.timer',
  'karcher-monitor-summary.service',
  'karcher-monitor-summary.timer'
]);

const units = new Map();
for (const name of unitNames) {
  const contents = await readFile(join(unitDir, name), 'utf8');
  assert.ok(!contents.includes('\r'), `${name}: use LF line endings`);
  assert.ok(
    !/(?:token|secret|password)\s*=\s*\S+/i.test(contents),
    `${name}: possible embedded secret`
  );
  units.set(name, parseUnit(name, contents));
}

for (const name of unitNames.filter((value) => value.endsWith('.service'))) {
  const unit = units.get(name);
  assert.match(one(unit, 'Service.User'), /^karcher-(?:api|monitor)$/);
  assert.match(one(unit, 'Service.Group'), /^karcher-(?:api|monitor)$/);
  assert.match(one(unit, 'Service.WorkingDirectory'), /^\/var\/www\/st24\/(?:server|monitor)$/);
  assert.match(one(unit, 'Service.EnvironmentFile'), /^\/etc\/(?:karcher\/api|karcher-monitor\/monitor)\.env$/);
  for (const execKey of ['Service.ExecStartPre', 'Service.ExecStart']) {
    const commands = unit.get(execKey);
    assert.ok(commands?.length, `${name}: ${execKey} is missing`);
    for (const command of commands) {
      assert.match(command, /^\/usr\/bin\/(?:env|flock|test)(?:\s|$)/);
    }
  }
  for (const [key, expected] of hardening) {
    assert.equal(one(unit, `Service.${key}`), expected, `${name}: unsafe ${key}`);
  }
}

const api = units.get('karcher-api.service');
assert.ok(
  api.get('Service.ExecStartPre').includes(
    '/usr/bin/env NODE_ENV=production DOTENV_CONFIG_PATH=/etc/karcher/api.env DOTENV_CONFIG_QUIET=true /usr/bin/node /var/www/st24/server/dist/configCheck.js'
  )
);
assert.equal(
  one(api, 'Service.ExecStart'),
  '/usr/bin/env NODE_ENV=production DOTENV_CONFIG_PATH=/etc/karcher/api.env DOTENV_CONFIG_QUIET=true /usr/bin/node /var/www/st24/server/dist/index.js'
);
assert.equal(
  one(api, 'Service.ReadWritePaths'),
  '/var/www/st24/server/uploads /var/www/st24/server/tmp'
);

for (const name of ['karcher-monitor-check.service', 'karcher-monitor-summary.service']) {
  const unit = units.get(name);
  const mode = name.includes('summary') ? 'summary' : 'check';
  assert.ok(
    unit.get('Service.ExecStartPre').includes(
      `/usr/bin/env MONITOR_ENV_FILE=/etc/karcher-monitor/monitor.env MONITOR_STATE_FILE=/var/lib/karcher-monitor/state.json /usr/bin/node /var/www/st24/monitor/dist/configCheck.js ${mode}`
    )
  );
  assert.match(
    one(unit, 'Service.ExecStart'),
    /^\/usr\/bin\/flock --exclusive --wait 210 --conflict-exit-code 75 \/var\/lib\/karcher-monitor\/schedule\.lock \/usr\/bin\/env MONITOR_ENV_FILE=\/etc\/karcher-monitor\/monitor\.env MONITOR_STATE_FILE=\/var\/lib\/karcher-monitor\/state\.json \/usr\/bin\/node \/var\/www\/st24\/monitor\/dist\/cli\.js (?:check|summary)$/
  );
  assert.equal(one(unit, 'Service.StateDirectory'), 'karcher-monitor');
}

const expectedTimers = new Map([
  [
    'karcher-monitor-check.timer',
    ['*-*-* *:0/5:00', 'karcher-monitor-check.service']
  ],
  [
    'karcher-monitor-summary.timer',
    ['*-*-* 09:02:00', 'karcher-monitor-summary.service']
  ]
]);
for (const [name, [calendar, target]] of expectedTimers) {
  const unit = units.get(name);
  assert.equal(one(unit, 'Timer.OnCalendar'), calendar);
  assert.equal(one(unit, 'Timer.Persistent'), 'yes');
  assert.equal(one(unit, 'Timer.Unit'), target);
  assert.ok(units.has(target), `${name}: target service is missing`);
}

// This root-only watchdog reads backup metadata, not the application environment.
// Its systemd sandbox does not grant write access to either backup filesystem.
const backupService = parseUnit(
  'karcher-backup-health.service',
  await readFile(join(opsDir, 'backup', 'karcher-backup-health.service'), 'utf8')
);
assert.equal(one(backupService, 'Service.User'), 'root');
assert.equal(one(backupService, 'Service.Group'), 'root');
assert.equal(one(backupService, 'Service.Type'), 'oneshot');
assert.equal(one(backupService, 'Service.WorkingDirectory'), '/usr/local/lib/karcher-backup');
assert.equal(
  one(backupService, 'Service.ExecStart'),
  '/usr/bin/python3 /usr/local/lib/karcher-backup/backup_health.py send'
);
assert.equal(one(backupService, 'Service.TimeoutStartSec'), '60s');
assert.equal(one(backupService, 'Service.UMask'), '0077');
assert.ok(!backupService.has('Service.ReadWritePaths'));
assert.ok(!backupService.has('Service.EnvironmentFile'));
for (const [key, expected] of hardening) {
  assert.equal(one(backupService, `Service.${key}`), expected, `backup watchdog: unsafe ${key}`);
}
const backupTimer = parseUnit(
  'karcher-backup-health.timer',
  await readFile(join(opsDir, 'backup', 'karcher-backup-health.timer'), 'utf8')
);
assert.equal(one(backupTimer, 'Timer.OnCalendar'), '*-*-* *:0/5:00');
assert.equal(one(backupTimer, 'Timer.Persistent'), 'yes');
assert.equal(one(backupTimer, 'Timer.Unit'), 'karcher-backup-health.service');

const retentionService = parseUnit(
  'karcher-backup-retention.service',
  await readFile(join(opsDir, 'backup', 'karcher-backup-retention.service'), 'utf8')
);
assert.equal(one(retentionService, 'Service.User'), 'root');
assert.equal(one(retentionService, 'Service.Type'), 'oneshot');
assert.equal(one(retentionService, 'Service.WorkingDirectory'), '/usr/local/lib/karcher-backup');
assert.equal(one(retentionService, 'Service.ExecStart'), '/usr/bin/python3 -B /usr/local/lib/karcher-backup/retention.py run');
assert.equal(one(retentionService, 'Service.TimeoutStartSec'), '20min');
assert.equal(one(retentionService, 'Service.StateDirectory'), 'karcher-retention');
assert.equal(one(retentionService, 'Service.StateDirectoryMode'), '0700');
assert.equal(one(retentionService, 'Service.UMask'), '0077');
assert.equal(one(retentionService, 'Service.ReadWritePaths'), '/var/backups/st24 /var/backups/karcher-encrypted /root/.config/rclone');
for (const [key, expected] of hardening) {
  assert.equal(one(retentionService, `Service.${key}`), key === 'ProtectHome' ? 'read-only' : expected);
}
const retentionTimer = parseUnit(
  'karcher-backup-retention.timer',
  await readFile(join(opsDir, 'backup', 'karcher-backup-retention.timer'), 'utf8')
);
assert.equal(one(retentionTimer, 'Timer.OnCalendar'), '*-*-* 01:15:00 UTC');
assert.equal(one(retentionTimer, 'Timer.Persistent'), 'yes');
assert.equal(one(retentionTimer, 'Timer.Unit'), 'karcher-backup-retention.service');

const apiTmpfiles = await readFile(join(opsDir, 'tmpfiles', 'karcher-api.conf'), 'utf8');
const apiTmpfileRules = apiTmpfiles
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
assert.deepEqual(apiTmpfileRules, [
  'd /var/www/st24/server/uploads 0750 karcher-api karcher-api -',
  'd /var/www/st24/server/tmp 0750 karcher-api karcher-api -',
  'd /var/www/st24/server/tmp/b2b-requests 0750 karcher-api karcher-api -',
  'd /var/www/st24/server/tmp/need-part-requests 0750 karcher-api karcher-api -',
  'd /var/log/karcher-api 0750 karcher-api karcher-api -',
  'f /var/log/karcher-api/api.log 0640 karcher-api karcher-api -'
]);

const monitorTmpfiles = await readFile(
  join(opsDir, 'tmpfiles', 'karcher-monitor.conf'),
  'utf8'
);
const monitorTmpfileRules = monitorTmpfiles
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));
assert.deepEqual(monitorTmpfileRules, [
  'd /var/log/karcher-monitor 0750 karcher-monitor karcher-monitor -',
  'f /var/log/karcher-monitor/monitor.log 0600 karcher-monitor karcher-monitor -'
]);

for (const [name, expectedPath, expectedIdentity, expectedMode] of [
  ['karcher-api', '/var/log/karcher-api/api.log', 'karcher-api karcher-api', '0640'],
  ['karcher-monitor', '/var/log/karcher-monitor/monitor.log', 'karcher-monitor karcher-monitor', '0600']
]) {
  const contents = await readFile(join(opsDir, 'logrotate', name), 'utf8');
  assert.match(contents, new RegExp(`^${expectedPath.replaceAll('/', '\\/')} \\{`));
  for (const directive of [
    'daily',
    'rotate',
    'maxsize',
    'missingok',
    'notifempty',
    'compress',
    'delaycompress',
    'dateext',
    'copytruncate'
  ]) {
    assert.match(contents, new RegExp(`^\\s*${directive}(?:\\s|$)`, 'm'));
  }
  assert.match(contents, new RegExp(`^\\s*su ${expectedIdentity}$`, 'm'));
  assert.match(
    contents,
    new RegExp(`^\\s*create ${expectedMode} ${expectedIdentity}$`, 'm')
  );
}

process.stdout.write('ops unit validation passed\n');
