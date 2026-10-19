#!/usr/bin/env bash

# Production deployment is deliberately fail-closed. The script never removes
# untracked files and refuses to deploy over tracked local changes.
set -Eeuo pipefail
set +x
# Release artifacts must remain readable by the service account and nginx.
# Sensitive backup/temp files set a restrictive mode at their creation site.
umask 0022
readonly DEPLOY_MAIN_PID="$BASHPID"

readonly ROOT_ARGUMENT="${1:-/var/www/st24}"
readonly API_URL="${2:-https://xn---24-3edf.xn--p1ai}"
readonly SERVICE_NAME="${3:-karcher-api}"
readonly READINESS_TIMEOUT_SECONDS="${READINESS_TIMEOUT_SECONDS:-90}"
readonly READINESS_INTERVAL_SECONDS="${READINESS_INTERVAL_SECONDS:-2}"
readonly REQUESTED_SERVER_ENV_FILE="${SERVER_ENV_FILE-}"
readonly SERVER_ENV_FILE="/etc/karcher/api.env"
readonly CLIENT_ENV_FILE="${CLIENT_ENV_FILE:-/etc/karcher/client.env}"
readonly DEPLOY_ALLOW_INACTIVE_SERVICE="${DEPLOY_ALLOW_INACTIVE_SERVICE:-0}"
readonly REQUESTED_DEPLOY_API_UNIT_FILE="${DEPLOY_API_UNIT_FILE-}"
readonly DEPLOY_API_UNIT_FILE="/etc/systemd/system/karcher-api.service"
readonly DEPLOY_API_TMPFILES_FILE="/etc/tmpfiles.d/karcher-api.conf"
readonly DEPLOY_API_LOGROTATE_FILE="/etc/logrotate.d/karcher-api"
readonly REQUESTED_DEPLOY_LOCK_FILE="${DEPLOY_LOCK_FILE:-}"
readonly DATABASE_COMMAND_TIMEOUT_SECONDS="${DATABASE_COMMAND_TIMEOUT_SECONDS:-900}"

ROOT=""
PREVIOUS_REVISION=""
TARGET_REVISION=""
CURRENT_BRANCH=""
UPSTREAM=""
BACKUP_FILE=""
PARTIAL_BACKUP_FILE=""
SMOKE_DATABASE_NAME=""
SMOKE_DATABASE_URL=""
SMOKE_DATABASE_CREATED=0
CODE_SWITCHED=0
DEPLOY_SUCCEEDED=0
ROLLBACK_IN_PROGRESS=0
SERVICE_RESTART_ATTEMPTED=0
DATABASE_URL_VALUE=""
CLIENT_CONFIG_RUNNER=""
SERVICE_WAS_ACTIVE=0
OPS_BACKUP_DIR=""
OPS_INSTALL_ATTEMPTED=0
READINESS_RUNNER=""
POSTGRES_RUNNER=""
LOCAL_API_URL=""
RESTART_STARTED_AT_MS=0
READINESS_REQUIRE_INSTANCE_ID=1

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  log "ERROR: $*" >&2
  return 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is missing: $1"
}

run_systemctl() {
  if (( EUID == 0 )); then
    systemctl "$@"
  else
    sudo -n systemctl "$@"
  fi
}

check_integer_setting() {
  local name="$1"
  local value="$2"
  local minimum="$3"
  local maximum="$4"

  [[ "$value" =~ ^[0-9]+$ ]] || fail "${name} must be an integer"
  (( value >= minimum && value <= maximum )) ||
    fail "${name} must be between ${minimum} and ${maximum}"
}

check_arguments() {
  [[ "$ROOT_ARGUMENT" != *$'\n'* && "$ROOT_ARGUMENT" != *$'\r'* ]] ||
    fail "ROOT must not contain a newline"
  [[ "$SERVICE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9_.@-]*$ ]] ||
    fail "SERVICE_NAME contains unsupported characters"
  [[ "$API_URL" != *$'\n'* && "$API_URL" != *$'\r'* ]] ||
    fail "API_URL must not contain a newline"
  [[ "$API_URL" =~ ^https://[^[:space:]/]+$ &&
     "$API_URL" != *"?"* && "$API_URL" != *"#"* ]] ||
    fail "API_URL must be a canonical HTTPS origin without a path, query or fragment"
  [[ "$API_URL" != *"@"* ]] ||
    fail "API_URL must not contain credentials"
  [[ "$SERVICE_NAME" == "karcher-api" || "$SERVICE_NAME" == "karcher-api.service" ]] ||
    fail "the packaged deployment manages only karcher-api.service"
  [[ -z "$REQUESTED_DEPLOY_API_UNIT_FILE" ||
     "$REQUESTED_DEPLOY_API_UNIT_FILE" == "$DEPLOY_API_UNIT_FILE" ]] ||
    fail "DEPLOY_API_UNIT_FILE cannot override the packaged service path"
  [[ "$SERVER_ENV_FILE" = /* ]] ||
    fail "SERVER_ENV_FILE must be an absolute path"
  [[ -z "$REQUESTED_SERVER_ENV_FILE" ||
     "$REQUESTED_SERVER_ENV_FILE" == "$SERVER_ENV_FILE" ]] ||
    fail "SERVER_ENV_FILE cannot override the production path ${SERVER_ENV_FILE}"
  [[ "$SERVER_ENV_FILE" != *$'\n'* && "$SERVER_ENV_FILE" != *$'\r'* ]] ||
    fail "SERVER_ENV_FILE must not contain a newline"
  [[ "$CLIENT_ENV_FILE" = /* ]] ||
    fail "CLIENT_ENV_FILE must be an absolute path"
  [[ "$CLIENT_ENV_FILE" != *$'\n'* && "$CLIENT_ENV_FILE" != *$'\r'* ]] ||
    fail "CLIENT_ENV_FILE must not contain a newline"
  [[ "$DEPLOY_ALLOW_INACTIVE_SERVICE" == "0" ||
     "$DEPLOY_ALLOW_INACTIVE_SERVICE" == "1" ]] ||
    fail "DEPLOY_ALLOW_INACTIVE_SERVICE must be 0 or 1"
  [[ "$DEPLOY_API_UNIT_FILE" = /* ]] ||
    fail "DEPLOY_API_UNIT_FILE must be an absolute path"
  [[ "$DEPLOY_API_UNIT_FILE" != *$'\n'* && "$DEPLOY_API_UNIT_FILE" != *$'\r'* ]] ||
    fail "DEPLOY_API_UNIT_FILE must not contain a newline"
  [[ -z "$REQUESTED_DEPLOY_LOCK_FILE" || "$REQUESTED_DEPLOY_LOCK_FILE" = /* ]] ||
    fail "DEPLOY_LOCK_FILE must be an absolute path"
  [[ "$REQUESTED_DEPLOY_LOCK_FILE" != *$'\n'* &&
     "$REQUESTED_DEPLOY_LOCK_FILE" != *$'\r'* ]] ||
    fail "DEPLOY_LOCK_FILE must not contain a newline"
  check_integer_setting READINESS_TIMEOUT_SECONDS "$READINESS_TIMEOUT_SECONDS" 10 900
  check_integer_setting READINESS_INTERVAL_SECONDS "$READINESS_INTERVAL_SECONDS" 1 30
  check_integer_setting DATABASE_COMMAND_TIMEOUT_SECONDS "$DATABASE_COMMAND_TIMEOUT_SECONDS" 30 7200
}

check_supported_node() {
  local executable="$1"

  "$executable" -e '
    if (process.versions.node.includes("-")) process.exit(1);
    const [major, minor] = process.versions.node.split(".").map(Number);
    const supported =
      (major === 22 && minor >= 13) ||
      major === 24;
    if (!supported) process.exit(1);
  ' || fail "unsupported Node.js runtime: ${executable}"
}

ops_file_paths() {
  printf '%s|%s|%s\n' \
    ops/systemd/karcher-api.service "$DEPLOY_API_UNIT_FILE" unit \
    ops/tmpfiles/karcher-api.conf "$DEPLOY_API_TMPFILES_FILE" tmpfiles \
    ops/logrotate/karcher-api "$DEPLOY_API_LOGROTATE_FILE" logrotate
}

check_unit_identity() {
  local fragment
  local drop_ins
  fragment="$(run_systemctl show --property=FragmentPath --value "$SERVICE_NAME")"
  drop_ins="$(run_systemctl show --property=DropInPaths --value "$SERVICE_NAME")"
  [[ "$fragment" == "$DEPLOY_API_UNIT_FILE" && -z "$drop_ins" ]] ||
    fail "karcher-api must use the packaged unit path without systemd drop-ins"
}

snapshot_api_ops() {
  local repository_path installed_path name
  OPS_BACKUP_DIR="$(mktemp -d "${BACKUP_FILE}.ops.XXXXXXXX")"
  chmod 0700 "$OPS_BACKUP_DIR"
  while IFS='|' read -r repository_path installed_path name; do
    [[ ! -L "$installed_path" ]] || fail "managed ops file must not be a symlink: ${installed_path}"
    if [[ -e "$installed_path" ]]; then
      [[ -f "$installed_path" ]] || fail "managed ops path is not a regular file: ${installed_path}"
      cp -p -- "$installed_path" "$OPS_BACKUP_DIR/$name"
    else
      touch "$OPS_BACKUP_DIR/$name.absent"
    fi
  done < <(ops_file_paths)
}

write_ops_file() {
  install -o root -g root -m 0644 -- "$1" "$2"
}

install_target_ops() {
  local repository_path installed_path name
  log "backing up and installing target API operations files"
  snapshot_api_ops
  # Set before the first write so a partial installation is also restored.
  OPS_INSTALL_ATTEMPTED=1
  while IFS='|' read -r repository_path installed_path name; do
    [[ -f "$repository_path" ]] || fail "target release is missing ${repository_path}"
    write_ops_file "$repository_path" "$installed_path"
  done < <(ops_file_paths)
  systemd-analyze verify "$DEPLOY_API_UNIT_FILE"
  systemd-tmpfiles --create "$DEPLOY_API_TMPFILES_FILE"
  logrotate --debug "$DEPLOY_API_LOGROTATE_FILE"
  run_systemctl daemon-reload
  check_unit_identity
}

restore_api_ops() {
  local repository_path installed_path name
  local failed=0
  (( OPS_INSTALL_ATTEMPTED == 1 )) || return 0
  log "restoring previous API operations files"
  while IFS='|' read -r repository_path installed_path name; do
    if [[ -f "$OPS_BACKUP_DIR/$name.absent" ]]; then
      rm -f -- "$installed_path" || failed=1
    elif [[ -f "$OPS_BACKUP_DIR/$name" ]]; then
      cp -p -- "$OPS_BACKUP_DIR/$name" "$installed_path" || failed=1
    else
      failed=1
    fi
  done < <(ops_file_paths)
  run_systemctl daemon-reload || failed=1
  return "$failed"
}

capture_service_initial_state() {
  local active_state
  local load_state

  load_state="$(run_systemctl show --property=LoadState --value "$SERVICE_NAME")" || {
    [[ "$load_state" == "not-found" && "$DEPLOY_ALLOW_INACTIVE_SERVICE" == "1" ]] ||
      fail "could not inspect service ${SERVICE_NAME}"
  }
  if [[ "$load_state" == "not-found" && "$DEPLOY_ALLOW_INACTIVE_SERVICE" == "1" ]]; then
    SERVICE_WAS_ACTIVE=0
    log "service is not installed; explicit bootstrap mode will install it after validation"
    return 0
  fi
  [[ "$load_state" == "loaded" ]] || fail "service must be loaded or explicitly bootstrapped"
  check_unit_identity
  active_state="$(run_systemctl show --property=ActiveState --value "$SERVICE_NAME")" ||
    fail "could not inspect service ${SERVICE_NAME}"

  if [[ "$active_state" == "active" ]]; then
    SERVICE_WAS_ACTIVE=1
    return 0
  fi
  if [[ ( "$active_state" == "inactive" || "$active_state" == "failed" ) &&
        "$DEPLOY_ALLOW_INACTIVE_SERVICE" == "1" ]]; then
    SERVICE_WAS_ACTIVE=0
    log "service is inactive; explicit bootstrap mode will start it after validation"
    return 0
  fi
  if [[ "$active_state" == "inactive" ]]; then
    fail "service ${SERVICE_NAME} is inactive; set DEPLOY_ALLOW_INACTIVE_SERVICE=1 only for bootstrap"
  fi
  fail "service ${SERVICE_NAME} has unsupported initial state: ${active_state}"
}

prepare_client_config_runner() {
  [[ -r scripts/client-config.mjs ]] ||
    fail "client configuration tool is missing from the target release"
  CLIENT_CONFIG_RUNNER="$(mktemp --suffix=.mjs "${TMPDIR:-/tmp}/karcher-client-config.XXXXXXXX")" ||
    fail "could not create a temporary client configuration runner"
  cp -- scripts/client-config.mjs "$CLIENT_CONFIG_RUNNER" ||
    fail "could not preserve the client configuration runner for rollback"
  READINESS_RUNNER="$(mktemp --suffix=.mjs "${TMPDIR:-/tmp}/karcher-deploy-readiness.XXXXXXXX")"
  cp -- scripts/deploy-readiness.mjs "$READINESS_RUNNER"
  POSTGRES_RUNNER="$(mktemp --suffix=.mjs "${TMPDIR:-/tmp}/karcher-postgres-command.XXXXXXXX")"
  cp -- scripts/postgres-command.mjs "$POSTGRES_RUNNER"
}

run_postgres() {
  local database_url="$1"
  shift
  DEPLOY_DATABASE_URL="$database_url" \
    timeout --kill-after=10s "${DATABASE_COMMAND_TIMEOUT_SECONDS}s" \
    /usr/bin/node "$POSTGRES_RUNNER" "$@"
}

run_client_config() {
  local command="$1"
  env CLIENT_CONFIG_ROOT="$ROOT" \
    CLIENT_ENV_FILE="$CLIENT_ENV_FILE" \
    EXPECTED_VITE_API_URL="$API_URL" \
    node "$CLIENT_CONFIG_RUNNER" "$command"
}

assert_clean_tracked_worktree() {
  if ! git diff --quiet --ignore-submodules -- ||
     ! git diff --cached --quiet --ignore-submodules --; then
    fail "tracked local changes detected; commit or stash them before deploying"
  fi
}

load_database_url() {
  # Parse the exact EnvironmentFile used by systemd without evaluating it as
  # shell code. The captured value is never written to deployment logs.
  SERVER_ENV_FILE_TO_READ="$SERVER_ENV_FILE" node <<'NODE'
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFromServer = createRequire(path.resolve('server/package.json'));
const dotenv = requireFromServer('dotenv');
const result = dotenv.config({
  path: process.env.SERVER_ENV_FILE_TO_READ,
  quiet: true,
  processEnv: {}
});
const databaseUrl = result.parsed?.DATABASE_URL;
if (!databaseUrl) process.exit(1);
process.stdout.write(databaseUrl);
NODE
}

database_name_from_url() {
  DATABASE_URL_TO_PARSE="$1" node <<'NODE'
const value = process.env.DATABASE_URL_TO_PARSE;
try {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    process.exit(1);
  }
  const name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!name || name.includes('/')) process.exit(1);
  process.stdout.write(name);
} catch {
  process.exit(1);
}
NODE
}

database_user_from_url() {
  DATABASE_URL_TO_PARSE="$1" node <<'NODE'
const value = process.env.DATABASE_URL_TO_PARSE;
try {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    process.exit(1);
  }
  const username = decodeURIComponent(parsed.username);
  if (!username || /[\0\r\n]/.test(username)) process.exit(1);
  process.stdout.write(username);
} catch {
  process.exit(1);
}
NODE
}

database_url_for_name() {
  DATABASE_URL_TO_PARSE="$1" DATABASE_NAME_TO_USE="$2" node <<'NODE'
const value = process.env.DATABASE_URL_TO_PARSE;
const databaseName = process.env.DATABASE_NAME_TO_USE;
try {
  const parsed = new URL(value);
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    process.exit(1);
  }
  parsed.pathname = `/${encodeURIComponent(databaseName)}`;
  process.stdout.write(parsed.toString());
} catch {
  process.exit(1);
}
NODE
}

assert_remote_url_has_no_inline_credentials() {
  GIT_REMOTE_URL_TO_CHECK="$1" node <<'NODE'
const value = process.env.GIT_REMOTE_URL_TO_CHECK ?? '';
if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) process.exit(0);
try {
  const parsed = new URL(value);
  // Authentication belongs in a credential helper, never in process output.
  const httpUserInfo = /^https?:$/i.test(parsed.protocol) && parsed.username;
  if (httpUserInfo || parsed.password || parsed.search || parsed.hash) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
NODE
}

drop_smoke_database() {
  if (( SMOKE_DATABASE_CREATED == 0 )); then
    return 0
  fi

  log "removing temporary migration-smoke database"
  if run_postgres "${MIGRATION_SMOKE_ADMIN_URL:-$DATABASE_URL_VALUE}" \
      dropdb --no-password --if-exists "$SMOKE_DATABASE_NAME" >/dev/null 2>&1; then
    SMOKE_DATABASE_CREATED=0
  else
    log "WARNING: could not remove temporary database ${SMOKE_DATABASE_NAME}" >&2
    return 1
  fi
}

wait_until_ready() {
  local deadline=$((SECONDS + READINESS_TIMEOUT_SECONDS))

  log "waiting for direct loopback and public readiness (timeout ${READINESS_TIMEOUT_SECONDS}s)"
  while (( SECONDS < deadline )); do
    if run_systemctl is-active --quiet "$SERVICE_NAME" &&
       LOCAL_API_URL="$LOCAL_API_URL" PUBLIC_API_URL="$API_URL" \
       RESTART_STARTED_AT_MS="$RESTART_STARTED_AT_MS" \
       READINESS_REQUIRE_INSTANCE_ID="$READINESS_REQUIRE_INSTANCE_ID" \
       /usr/bin/node "$READINESS_RUNNER" >/dev/null 2>&1
    then
      log "readiness check passed"
      return 0
    fi
    sleep "$READINESS_INTERVAL_SECONDS"
  done

  fail "readiness endpoint did not become healthy in time"
}

build_release() {
  log "installing locked dependencies"
  npm ci --include=dev --no-audit --no-fund

  # The preflight is compiled TypeScript, so build the server before invoking it.
  log "building server configuration preflight"
  npm run build --workspace server

  log "running production configuration preflight"
  env -i PATH="$PATH" NODE_ENV=production \
    DOTENV_CONFIG_PATH="$SERVER_ENV_FILE" \
    DOTENV_CONFIG_QUIET=true \
    /usr/bin/node server/dist/configCheck.js

  log "running production client configuration preflight"
  run_client_config check

  log "running tests"
  env NODE_ENV=test DOTENV_CONFIG_PATH=/dev/null DOTENV_CONFIG_QUIET=true npm test

  log "running linters"
  npm run lint

  log "building client, server and monitor"
  run_client_config build
  npm run build --workspace server
  npm run build --workspace monitor
}

create_backup_and_smoke_migrations() {
  local timestamp
  local backup_dir
  local application_database_user
  local production_database_name
  local smoke_admin_url
  local partial_backup_candidate
  local database_size available_kib required_kib

  DATABASE_URL_VALUE="$(load_database_url)" ||
    fail "DATABASE_URL is unavailable in ${SERVER_ENV_FILE}"
  [[ "$DATABASE_URL_VALUE" != *$'\n'* && "$DATABASE_URL_VALUE" != *$'\r'* ]] ||
    fail "DATABASE_URL contains a newline"

  production_database_name="$(database_name_from_url "$DATABASE_URL_VALUE")" ||
    fail "DATABASE_URL must be a PostgreSQL URL for safe backup validation"
  application_database_user="$(database_user_from_url "$DATABASE_URL_VALUE")" ||
    fail "DATABASE_URL must contain an explicit PostgreSQL username"
  smoke_admin_url="${MIGRATION_SMOKE_ADMIN_URL:-$DATABASE_URL_VALUE}"
  database_name_from_url "$smoke_admin_url" >/dev/null ||
    fail "MIGRATION_SMOKE_ADMIN_URL must be a PostgreSQL URL"

  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${DEPLOY_BACKUP_DIR:-${ROOT}/../backups/${SERVICE_NAME}}"
  [[ "$backup_dir" = /* ]] ||
    fail "DEPLOY_BACKUP_DIR must be an absolute path"
  [[ "$backup_dir" != *$'\n'* && "$backup_dir" != *$'\r'* ]] ||
    fail "DEPLOY_BACKUP_DIR must not contain a newline"
  (umask 0077; mkdir -p -- "$backup_dir")
  database_size="$(run_postgres "$DATABASE_URL_VALUE" \
    psql --no-password --no-psqlrc --tuples-only --no-align \
    --command='SELECT pg_database_size(current_database())')"
  [[ "$database_size" =~ ^[0-9]+$ ]] || fail "could not determine database size"
  available_kib="$(df -Pk -- "$backup_dir" | awk 'NR==2 {print $4}')"
  [[ "$available_kib" =~ ^[0-9]+$ ]] || fail "could not determine backup filesystem capacity"
  required_kib=$((database_size * 2 / 1024 + 1048576))
  (( available_kib >= required_kib )) || fail "backup filesystem needs twice the database size plus 1 GiB free"
  BACKUP_FILE="${backup_dir}/${SERVICE_NAME}_${timestamp}_${PREVIOUS_REVISION:0:12}.dump"
  partial_backup_candidate="${BACKUP_FILE}.partial.$$"
  [[ ! -e "$BACKUP_FILE" && ! -e "$partial_backup_candidate" ]] ||
    fail "backup target already exists; refusing to overwrite it"
  PARTIAL_BACKUP_FILE="$partial_backup_candidate"

  log "creating PostgreSQL backup at ${BACKUP_FILE}"
  (umask 0077; run_postgres "$DATABASE_URL_VALUE" pg_dump \
    --no-password --format=custom --file="$PARTIAL_BACKUP_FILE")
  timeout --kill-after=10s "${DATABASE_COMMAND_TIMEOUT_SECONDS}s" \
    pg_restore --list "$PARTIAL_BACKUP_FILE" >/dev/null
  [[ -s "$PARTIAL_BACKUP_FILE" ]] || fail "PostgreSQL backup is empty"
  mv -- "$PARTIAL_BACKUP_FILE" "$BACKUP_FILE"
  chmod 0600 -- "$BACKUP_FILE"
  PARTIAL_BACKUP_FILE=""
  log "backup verified"

  SMOKE_DATABASE_NAME="karcher_deploy_smoke_${timestamp//[^0-9]/}_$$"
  [[ "$SMOKE_DATABASE_NAME" != "$production_database_name" ]] ||
    fail "refusing to use the production database for migration smoke"
  # The admin connection only creates/drops the database. Restore and init use
  # the production application role so the smoke catches missing DDL grants.
  SMOKE_DATABASE_URL="$(database_url_for_name "$DATABASE_URL_VALUE" "$SMOKE_DATABASE_NAME")" ||
    fail "could not construct the temporary database URL"

  log "creating isolated database for migration smoke"
  run_postgres "$smoke_admin_url" \
    createdb --no-password --owner="$application_database_user" \
    "$SMOKE_DATABASE_NAME"
  SMOKE_DATABASE_CREATED=1
  run_postgres "$SMOKE_DATABASE_URL" pg_restore \
    --no-password --exit-on-error --no-owner --no-privileges \
    "$BACKUP_FILE" >/dev/null

  log "running database initialization twice to verify migration idempotency"
  env -i PATH="$PATH" NODE_ENV=production \
    DATABASE_URL="$SMOKE_DATABASE_URL" \
    SERVER_ENV_FILE_TO_READ="$SERVER_ENV_FILE" \
    timeout --kill-after=10s "${DATABASE_COMMAND_TIMEOUT_SECONDS}s" /usr/bin/node <<'NODE'
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFromServer = createRequire(path.resolve('server/package.json'));
requireFromServer('dotenv').config({
  path: process.env.SERVER_ENV_FILE_TO_READ,
  quiet: true
});
const { initDb } = require('./server/dist/db/init');
const { closeDatabasePools } = require('./server/dist/db');

(async () => {
  try {
    await initDb();
    await initDb();
  } finally {
    await closeDatabasePools();
  }
})().catch(() => {
  console.error('[deploy] migration smoke failed; inspect the isolated database');
  process.exit(1);
});
NODE
  drop_smoke_database
  log "migration smoke passed"
}

restore_previous_release() {
  local code_ready=1
  local rollback_failed=0
  local target_stopped=1

  (( CODE_SWITCHED == 1 )) || return 0
  (( ROLLBACK_IN_PROGRESS == 0 )) || return 1
  ROLLBACK_IN_PROGRESS=1
  trap - ERR
  set +e

  if (( SERVICE_RESTART_ATTEMPTED == 1 )); then
    log "stopping the target service before restoring previous code"
    run_systemctl stop "$SERVICE_NAME" >/dev/null 2>&1 || true
    if run_systemctl is-active --quiet "$SERVICE_NAME"; then
      target_stopped=0
      rollback_failed=1
      log "CRITICAL: target service could not be stopped" >&2
    fi
  fi

  if (( target_stopped == 0 )); then
    log "CRITICAL: leaving code and operations files intact until the target process is stopped" >&2
    set -e
    return 1
  fi

  log "rolling code back to ${PREVIOUS_REVISION:0:12}"
  if ! git reset --keep "$PREVIOUS_REVISION" >/dev/null; then
    code_ready=0
    rollback_failed=1
  fi

  if (( code_ready == 1 )); then
    npm ci --include=dev --no-audit --no-fund >/dev/null || code_ready=0
    if (( code_ready == 1 )); then
      run_client_config build >/dev/null || code_ready=0
      npm run build --workspace server >/dev/null || code_ready=0
      npm run build --workspace monitor >/dev/null || code_ready=0
    fi
    if (( code_ready == 0 )); then
      rollback_failed=1
    fi
  fi

  restore_api_ops || rollback_failed=1

  if (( SERVICE_RESTART_ATTEMPTED == 1 && SERVICE_WAS_ACTIVE == 1 )); then
    if (( code_ready == 1 && target_stopped == 1 && rollback_failed == 0 )); then
      RESTART_STARTED_AT_MS="$(/usr/bin/node -p 'Date.now()')"
      READINESS_REQUIRE_INSTANCE_ID=0
      run_systemctl start "$SERVICE_NAME" || rollback_failed=1
      if (( rollback_failed == 0 )); then
        # The previous process must produce a readiness report after this start.
        wait_until_ready || rollback_failed=1
      fi
    else
      rollback_failed=1
    fi
  elif (( SERVICE_RESTART_ATTEMPTED == 1 && SERVICE_WAS_ACTIVE == 0 )); then
    if run_systemctl is-active --quiet "$SERVICE_NAME"; then
      rollback_failed=1
      log "CRITICAL: service was initially inactive but remains active after rollback" >&2
    fi
  fi

  if (( rollback_failed == 0 )); then
    if (( SERVICE_RESTART_ATTEMPTED == 1 && SERVICE_WAS_ACTIVE == 1 )); then
      log "previous code and service were restored"
      log "WARNING: database migrations are not rolled back; inspect them before retrying"
    elif (( SERVICE_RESTART_ATTEMPTED == 1 )); then
      log "previous code was restored; the initially inactive service remains stopped"
    else
      log "previous code was restored; the service was left in its original state"
    fi
  else
    log "CRITICAL: automatic rollback was incomplete; manual recovery is required" >&2
  fi

  set -e
  return "$rollback_failed"
}

on_signal() {
  local signal="$1"
  local status="$2"

  trap - ERR INT TERM HUP
  set +e
  log "deployment interrupted by ${signal}" >&2
  drop_smoke_database || true
  restore_previous_release || true
  exit "$status"
}

on_error() {
  local status="$1"
  local line="$2"

  # ERR is inherited by command substitutions. Only the parent coordinator may
  # roll back shared files; the parent handles this child's nonzero exit next.
  if [[ "$BASHPID" != "$DEPLOY_MAIN_PID" ]]; then
    exit "$status"
  fi
  trap - ERR
  set +e
  log "deployment failed at line ${line} (exit ${status})" >&2
  drop_smoke_database || true
  restore_previous_release || true
  exit "$status"
}

on_exit() {
  local status="$1"

  trap - EXIT ERR
  set +e
  if [[ -n "$PARTIAL_BACKUP_FILE" ]]; then
    rm -f -- "$PARTIAL_BACKUP_FILE" ||
      log "WARNING: could not remove partial backup ${PARTIAL_BACKUP_FILE}" >&2
  fi
  if [[ -n "$CLIENT_CONFIG_RUNNER" ]]; then
    rm -f -- "$CLIENT_CONFIG_RUNNER" ||
      log "WARNING: could not remove temporary client configuration runner" >&2
  fi
  if [[ -n "$READINESS_RUNNER" ]]; then
    rm -f -- "$READINESS_RUNNER" || true
  fi
  if [[ -n "$POSTGRES_RUNNER" ]]; then
    rm -f -- "$POSTGRES_RUNNER" || true
  fi
  if (( SMOKE_DATABASE_CREATED == 1 )); then
    drop_smoke_database || true
  fi
  if (( status == 0 && DEPLOY_SUCCEEDED == 1 )); then
    log "deployment completed: ${PREVIOUS_REVISION:0:12} -> ${TARGET_REVISION:0:12}"
    log "backup retained at ${BACKUP_FILE}"
  fi
  exit "$status"
}

main() {
  local remote
  local remote_url
  local lock_file

  check_arguments
  (( EUID == 0 )) || fail "run the reviewed deployment script as root (it installs and restores systemd files)"
  require_command flock
  require_command git
  require_command npm
  require_command node
  require_command env
  require_command pg_dump
  require_command pg_restore
  require_command createdb
  require_command dropdb
  require_command psql
  require_command timeout
  require_command df
  require_command awk
  require_command install
  require_command touch
  require_command systemd-analyze
  require_command systemd-tmpfiles
  require_command logrotate
  require_command systemctl
  require_command cmp
  require_command chmod
  require_command cp
  require_command date
  require_command mktemp
  require_command mkdir
  require_command mv
  require_command rm
  require_command sleep
  [[ -x /usr/bin/node ]] || fail "required executable is missing: /usr/bin/node"
  check_supported_node node
  check_supported_node /usr/bin/node
  if (( EUID != 0 )); then
    require_command sudo
  fi

  [[ -d "$ROOT_ARGUMENT" ]] || fail "deployment root does not exist: ${ROOT_ARGUMENT}"
  ROOT="$(cd -- "$ROOT_ARGUMENT" && pwd -P)" ||
    fail "could not resolve deployment root"
  [[ "$ROOT" == "/var/www/st24" ]] ||
    fail "the packaged unit requires the deployment root /var/www/st24"
  [[ -r "$SERVER_ENV_FILE" ]] ||
    fail "server environment file is not readable: ${SERVER_ENV_FILE}"
  [[ -r "$CLIENT_ENV_FILE" ]] ||
    fail "client environment file is not readable: ${CLIENT_ENV_FILE}"
  cd "$ROOT"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
    fail "deployment root is not a Git working tree"

  if [[ -n "$REQUESTED_DEPLOY_LOCK_FILE" ]]; then
    lock_file="$REQUESTED_DEPLOY_LOCK_FILE"
  else
    lock_file="$(git rev-parse --git-path deploy.lock)" ||
      fail "could not resolve the deployment lock path"
  fi
  [[ -z "$REQUESTED_DEPLOY_LOCK_FILE" ||
     "$REQUESTED_DEPLOY_LOCK_FILE" == "${ROOT}/$(git rev-parse --git-path deploy.lock)" ]] ||
    fail "DEPLOY_LOCK_FILE cannot replace the repository-wide lock"
  [[ "$lock_file" != *$'\n'* && "$lock_file" != *$'\r'* ]] ||
    fail "DEPLOY_LOCK_FILE must not contain a newline"
  exec 9>"$lock_file"
  flock -n 9 || fail "another deployment for ${SERVICE_NAME} is already running"

  assert_clean_tracked_worktree
  CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD)" ||
    fail "detached HEAD is not supported"
  UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')" ||
    fail "branch ${CURRENT_BRANCH} has no upstream"
  PREVIOUS_REVISION="$(git rev-parse 'HEAD^{commit}')" ||
    fail "could not resolve the current revision"
  remote="$(git config --get "branch.${CURRENT_BRANCH}.remote")" ||
    fail "could not determine the upstream remote"
  [[ -n "$remote" && "$remote" != "." ]] ||
    fail "deployment upstream must use a named Git remote"
  remote_url="$(git remote get-url "$remote")" ||
    fail "could not resolve the upstream remote URL"
  assert_remote_url_has_no_inline_credentials "$remote_url" ||
    fail "HTTP(S) Git remotes must use a credential helper, not inline credentials"
  unset remote_url

  log "root: ${ROOT}"
  log "service: ${SERVICE_NAME}"
  log "current revision: ${PREVIOUS_REVISION:0:12} (${CURRENT_BRANCH})"
  log "fetching ${UPSTREAM}"
  GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=Never git fetch --prune "$remote"
  TARGET_REVISION="$(git rev-parse "${UPSTREAM}^{commit}")" ||
    fail "could not resolve the fetched upstream revision"
  git merge-base --is-ancestor "$PREVIOUS_REVISION" "$TARGET_REVISION" ||
    fail "upstream is not a fast-forward; resolve the branch manually"

  run_systemctl daemon-reload
  capture_service_initial_state

  log "updating to ${TARGET_REVISION:0:12} with fast-forward only"
  git merge --ff-only "$TARGET_REVISION"
  CODE_SWITCHED=1
  assert_clean_tracked_worktree
  prepare_client_config_runner

  build_release
  LOCAL_API_URL="$(SERVER_ENV_FILE_TO_READ="$SERVER_ENV_FILE" /usr/bin/node <<'NODE'
const path = require('node:path');
const { createRequire } = require('node:module');
const requireFromServer = createRequire(path.resolve('server/package.json'));
const parsed = requireFromServer('dotenv').config({
  path: process.env.SERVER_ENV_FILE_TO_READ, quiet: true, processEnv: {}
}).parsed;
const port = Number(parsed?.PORT);
if (parsed?.API_BIND_HOST !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('[deploy] packaged deployment requires API_BIND_HOST=127.0.0.1 and a valid PORT');
  process.exit(1);
}
process.stdout.write(`http://127.0.0.1:${port}`);
NODE
  )"
  assert_clean_tracked_worktree
  create_backup_and_smoke_migrations
  install_target_ops

  RESTART_STARTED_AT_MS="$(/usr/bin/node -p 'Date.now()')"
  SERVICE_RESTART_ATTEMPTED=1
  run_systemctl reset-failed "$SERVICE_NAME"
  if (( SERVICE_WAS_ACTIVE == 1 )); then
    log "restarting ${SERVICE_NAME}; startup may apply database migrations"
    run_systemctl restart "$SERVICE_NAME"
  else
    log "starting ${SERVICE_NAME}; startup may apply database migrations"
    run_systemctl start "$SERVICE_NAME"
  fi
  run_systemctl is-active --quiet "$SERVICE_NAME"
  wait_until_ready

  DEPLOY_SUCCEEDED=1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  trap 'on_error $? $LINENO' ERR
  trap 'on_exit $?' EXIT
  trap 'on_signal INT 130' INT
  trap 'on_signal TERM 143' TERM
  trap 'on_signal HUP 129' HUP
  main "$@"
fi
