# Production services

These files package the HER API and the independent monitor as `systemd`
services. The API and monitor are normally installed on different hosts. Install
only the units and logrotate file that belong to that host.

The examples assume:

- a supported Node.js binary at `/usr/bin/node` (Node.js 22 LTS is recommended);
- `flock` from `util-linux` on the independent monitor host;
- systemd 247 or newer (required by the process-visibility sandbox options);
- the existing in-place deployment root at `/var/www/st24`;
- API configuration at `/etc/her/api.env`;
- controlled public frontend build configuration at `/etc/her/client.env`;
- monitor configuration at `/etc/her-monitor/monitor.env`;
- dedicated, non-login users `her-api` and `her-monitor`.

The unit files and guarded deploy pin `/var/www/st24`, the production mode and the
state/config paths directly in `ExecStart`. Values with the same names in an
`EnvironmentFile` cannot weaken those guarantees. If the release layout or
Node path differs, adapt and review the units and deployment script together.
The packaged deploy rejects a different root, service name, environment path
or systemd drop-ins. `nvm` paths are not suitable for a system service.

Each service runs its compiled `configCheck.js` as `ExecStartPre`; an invalid
or incomplete environment therefore prevents the actual API/check from
starting and leaves an explicit failed unit result.

Do not put secrets in this directory or in Git. The environment files below
must be excluded from Git and readable only by root and the relevant service
group (`0640`).

Before the first production rollout, rotate the Telegram bot tokens and webhook
secrets that were present in the local development environment during the
implementation audit. Never copy their old values into the new `/etc` files.

The repository-side structural check is cross-platform:

```sh
node ops/validate-units.mjs
```

It complements, but does not replace, `systemd-analyze verify` and logrotate
validation on the target Linux distribution.

## API host

Build the in-place release before restarting the service. The resulting file
`/var/www/st24/server/dist/index.js` must exist. Create the service identity and
configuration from the deployment root:

```sh
sudo groupadd --system her-api
sudo useradd --system --gid her-api --home-dir /nonexistent \
  --shell /usr/sbin/nologin her-api
sudo install -d -o root -g root -m 0755 /etc/her
if [ ! -e /etc/her/api.env ]; then
  sudo install -o root -g her-api -m 0640 server/.env.example /etc/her/api.env
fi
sudo chown root:her-api /etc/her/api.env
sudo chmod 0640 /etc/her/api.env
sudoedit /etc/her/api.env
if [ ! -e /etc/her/client.env ]; then
  sudo install -o root -g her-api -m 0640 client/.env.example /etc/her/client.env
fi
sudo chown root:her-api /etc/her/client.env
sudo chmod 0640 /etc/her/client.env
sudoedit /etc/her/client.env
```

Set `NODE_ENV=production`, the production database URL, secrets, explicit
`TRUST_PROXY`, public HTTPS return origin and Telegram configuration in that
file. Keep `API_BIND_HOST=127.0.0.1` when nginx on the same host is the only
public entry point. The service runs in `/var/www/st24/server`, matching
`deploy.sh`. Only `uploads/` and `tmp/` are writable inside that tree. The
in-place deploy does not remove untracked files, but uploads still need an
independent backup together with PostgreSQL.

`deploy.sh` and the service share `/etc/her/api.env`. Run the reviewed script as
root: it installs and rolls back the three managed API operations files as well
as restarting the service. Keep the checkout, remote and build scripts under
trusted administrative control; application processes still run as `her-api`.
`DOTENV_CONFIG_PATH` also prevents the Node process from accidentally loading a
stale `server/.env`.

The server environment path is intentionally fixed and cannot be overridden:
using one database for backup/migration smoke and another one in the systemd
service would make rollback unsafe. Both the deployer's `node` from `PATH` and
the service runtime at `/usr/bin/node` must satisfy the repository Node.js
engine range; the production preflight itself runs with `/usr/bin/node`.

Before the first service start, build and validate the exact release:

```sh
npm ci
npm test
CLIENT_ENV_FILE=/etc/her/client.env \
  EXPECTED_VITE_API_URL=https://xn---24-3edf.xn--p1ai \
  npm run client:config:check
CLIENT_ENV_FILE=/etc/her/client.env \
  EXPECTED_VITE_API_URL=https://xn---24-3edf.xn--p1ai \
  npm run client:build
npm run build --workspace server
npm run build --workspace monitor
DOTENV_CONFIG_PATH=/etc/her/api.env NODE_ENV=production npm run config:check
```

Before the first start, provision writable paths. Do not start the API yet:

```sh
sudo systemd-tmpfiles --create ops/tmpfiles/her-api.conf
# One-time adoption if uploads existed before the her-api user:
sudo chown -R her-api:her-api /var/www/st24/server/uploads \
  /var/www/st24/server/tmp
# Continue with guarded bootstrap below: backup and migration smoke run before
# the target operations files are installed or the API starts.
```

The tmpfiles policy provisions the two application-writable paths and creates
the output file before systemd connects stdout to it. `LogsDirectory` also
enforces ownership of `/var/log/her-api`. The sandbox keeps the rest of the
release and operating system read-only. API output is stored in
`/var/log/her-api/api.log` and rotated without restarting the process.

## Independent monitor host

Use a host and provider independent from the shop server. It needs the built
`monitor/dist/cli.js`, production dependencies and outbound DNS/HTTPS access; it
does not need PostgreSQL, nginx, uploads or a second API instance.

Create its identity and restricted environment file on the independent host:

```sh
sudo groupadd --system her-monitor
sudo useradd --system --gid her-monitor --home-dir /var/lib/her-monitor \
  --shell /usr/sbin/nologin her-monitor
sudo install -d -o root -g root -m 0755 /etc/her-monitor
if [ ! -e /etc/her-monitor/monitor.env ]; then
  sudo install -o root -g her-monitor -m 0640 monitor/.env.example \
    /etc/her-monitor/monitor.env
fi
sudo chown root:her-monitor /etc/her-monitor/monitor.env
sudo chmod 0640 /etc/her-monitor/monitor.env
sudoedit /etc/her-monitor/monitor.env
```

Use a separate alert bot and, preferably, a separate alert network path. Set
`MONITOR_STATE_FILE=/var/lib/her-monitor/state.json`; the systemd sandbox does
not allow state outside `/var/lib/her-monitor`. Configure a real external
dead-man URL and leave `MONITOR_ALLOW_NO_HEARTBEAT=false`. Whenever a production
bot token is configured, preflight also requires
`MONITOR_TELEGRAM_CANARY_CHAT_ID`.

Install the two oneshot services, their timers, and only the monitor log policy:

```sh
for unit in her-monitor-check.service her-monitor-check.timer \
  her-monitor-summary.service her-monitor-summary.timer; do
  sudo install -o root -g root -m 0644 "ops/systemd/$unit" \
    "/etc/systemd/system/$unit"
done
sudo install -o root -g root -m 0644 ops/logrotate/her-monitor \
  /etc/logrotate.d/her-monitor
sudo install -o root -g root -m 0644 ops/tmpfiles/her-monitor.conf \
  /etc/tmpfiles.d/her-monitor.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/her-monitor.conf
sudo systemd-analyze verify /etc/systemd/system/her-monitor-*.service \
  /etc/systemd/system/her-monitor-*.timer
sudo logrotate --debug /etc/logrotate.d/her-monitor
sudo systemctl daemon-reload
```

The monitor tmpfiles policy creates its restricted output file before either
oneshot service starts. Persistent monitor state remains managed separately by
`StateDirectory=her-monitor`.

Run both modes manually before enabling the schedule. A check intentionally
returns a non-zero status when a critical dependency is down; that failed unit
state is useful evidence and does not stop future timer activations.

```sh
sudo systemctl start her-monitor-check.service
sudo systemctl status her-monitor-check.service
sudo systemctl start her-monitor-summary.service
sudo systemctl status her-monitor-summary.service
sudo systemctl enable --now her-monitor-check.timer her-monitor-summary.timer
systemctl list-timers 'her-monitor-*'
```

The check runs every five minutes with up to 15 seconds of jitter. The summary
runs daily at 09:02 in the monitor host's local timezone. `Persistent=yes`
causes one missed activation to run after a reboot. Both modes run from
`/var/www/st24/monitor` and use the same atomic state file and application-level
lock in `/var/lib/her-monitor`. An outer `flock` also serializes timer catch-up
after reboot: a summary waits for an active check instead of being silently
discarded by the application lock.

Before the first manual check, install and build the monitor on that host, then
run its no-network preflight under the service identity:

```sh
npm ci --workspace monitor --include-workspace-root=false
npm run build --workspace monitor
sudo -u her-monitor env MONITOR_ENV_FILE=/etc/her-monitor/monitor.env \
  MONITOR_STATE_FILE=/var/lib/her-monitor/state.json \
  /usr/bin/node /var/www/st24/monitor/dist/configCheck.js
```

`deploy.sh` updates the API host only. Update the independent monitor host from
the same reviewed revision (or a CI artifact), rebuild it, pass this preflight,
and only then restart its timers.

## Guarded deploy

For the separate root-owned daily database/files backup and Yandex authorization,
see [backup/README.md](backup/README.md). Its `/var/backups/st24` storage is not
the deployment account's `DEPLOY_BACKUP_DIR`; keep the daily copies root-only.

Provision a backup directory writable by the deployment account before using
the script, or set an absolute `DEPLOY_BACKUP_DIR`. The database role used by
the API often cannot create temporary databases; in that case provide a
separate protected `MIGRATION_SMOKE_ADMIN_URL` to the deploy process. Neither
connection string is printed.

Install PostgreSQL client utilities (`psql`, `pg_dump`, `pg_restore`, `createdb`,
`dropdb`), GNU coreutils (`timeout`, `df`) and logrotate on the API host.
Each database command has a 15-minute deadline, configurable through
`DATABASE_COMMAND_TIMEOUT_SECONDS` (30..7200). The script requires free backup
space of twice the database size plus 1 GiB. PostgreSQL also needs capacity for
a temporary full restore. Before production, configure external disk-space
alerts and a scheduled backup retention policy (for example 14 days plus an
off-host copy). Include `.dump` files and adjacent `.ops.*` directories. Deploy
retains successful backups and never deletes recovery history automatically.

The frontend build reads only `/etc/her/client.env`, injects only the documented
allowlist of public `VITE_*` values and requires `VITE_API_URL` to match the
deploy API origin exactly. It does not merge an ignored `client/.env` into the
production bundle.

Before every deploy, inspect changes under `ops/`. Review the exact fetched
revision; do not replace the live API unit with target files before deployment:

```sh
git fetch origin
git diff HEAD..origin/master -- ops/systemd/her-api.service \
  ops/tmpfiles/her-api.conf ops/logrotate/her-api
```

After successful build and database smoke, deploy saves the currently installed
API unit, tmpfiles and logrotate files (including absence and permissions) next
to the database dump, installs the target files and validates them before
`daemon-reload` and restart. Rollback restores that snapshot before starting the
previous code. Directory creation/ownership by tmpfiles is not undone; runtime
uploads and logs are preserved. Changes must remain backward compatible with
the previous database schema and writable paths.

```sh
sudo install -d -o root -g root -m 0700 \
  /var/www/backups/her-api
cd /var/www/st24
sudo bash ./deploy.sh /var/www/st24 https://xn---24-3edf.xn--p1ai her-api
```

The script accepts only a clean fast-forward update, runs config preflight,
tests, lint and builds, creates a verified custom-format PostgreSQL backup,
restores it into a temporary database, and runs schema initialization twice.
Only after that does it restart the API and check direct loopback readiness
(`API_BIND_HOST=127.0.0.1`, `PORT` from the service env) and the public route.
Both must return HTTP 200, `Cache-Control: no-store`, healthy PostgreSQL and
uploads, and a check timestamp after restart began. Unique probe URLs avoid
pre-restart cache entries. Both responses must identify the same new API process
through its random `instanceId`; a healthy response from another host fails.
A repository-wide lock protects the worktree.
A failed rollout restores previous code and operations files; database
migrations are intentionally not reversed automatically.

For the very first transition, do not execute the old unguarded `deploy.sh`
already present on the server. Fetch or copy the reviewed new script and units,
inspect them, complete the bootstrap above, and then invoke the new script. If
the unit is missing, inactive or failed, opt in for bootstrap/recovery:

```sh
sudo env DEPLOY_ALLOW_INACTIVE_SERVICE=1 bash ./deploy.sh \
  /var/www/st24 https://xn---24-3edf.xn--p1ai her-api
```

The flag accepts only `0` or `1` and is unnecessary once the service is active.
After the first successful guarded start, enable boot startup separately:

```sh
sudo systemctl enable her-api.service
```

On rollback the deploy stops a target it attempted to start; an originally
inactive service remains stopped, while an originally active service is rebuilt,
started and checked for readiness.
This is still an in-place deployment, not a zero-downtime blue/green layout.

## Inspection and rollback

Application logs are deliberately separate from the journal:

```sh
sudo tail -n 200 /var/log/her-api/api.log
sudo tail -n 200 /var/log/her-monitor/monitor.log
sudo systemctl show -p Result,ExecMainStatus her-api.service
sudo systemctl show -p Result,ExecMainStatus her-monitor-check.service
```

Use `deploy.sh` for the guarded fast-forward update, readiness check and its
code rollback path. Do not roll back PostgreSQL by restoring an old backup
while accepting traffic. Stop and investigate instead when a database migration
is not backward compatible.
