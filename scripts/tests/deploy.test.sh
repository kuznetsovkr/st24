#!/usr/bin/env bash
# Literal regexes and dynamically sourced overrides in isolated fixtures are intentional.
# shellcheck disable=SC2016,SC1090,SC2034,SC2329,SC2030,SC2031
set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
DEPLOY_SCRIPT="${REPOSITORY_ROOT}/deploy.sh"

fail() {
  printf 'deploy.test.sh: %s\n' "$*" >&2
  exit 1
}

assert_contains() {
  local pattern="$1"
  grep -Eq -- "$pattern" "$DEPLOY_SCRIPT" ||
    fail "expected pattern is missing: ${pattern}"
}

assert_absent() {
  local pattern="$1"
  if grep -Eq -- "$pattern" "$DEPLOY_SCRIPT"; then
    fail "unsafe pattern is present: ${pattern}"
  fi
}

bash -n "$DEPLOY_SCRIPT"

assert_contains 'set -Eeuo pipefail'
assert_contains 'flock -n'
assert_contains 'git rev-parse --git-path deploy.lock'
assert_contains 'git merge --ff-only'
assert_contains 'git reset --keep'
assert_contains 'SERVICE_RESTART_ATTEMPTED=1'
assert_contains 'SERVICE_WAS_ACTIVE=1'
assert_contains 'DEPLOY_ALLOW_INACTIVE_SERVICE'
assert_contains 'run_systemctl stop "\$SERVICE_NAME"'
assert_contains 'run_systemctl start "\$SERVICE_NAME"'
assert_contains 'npm ci'
assert_contains '/usr/bin/node server/dist/configCheck.js'
assert_contains 'check_supported_node node'
assert_contains 'check_supported_node /usr/bin/node'
assert_contains 'CLIENT_ENV_FILE'
assert_contains 'EXPECTED_VITE_API_URL="\$API_URL"'
assert_contains 'run_client_config build'
assert_contains 'snapshot_api_ops'
assert_contains 'restore_api_ops'
assert_contains 'OPS_INSTALL_ATTEMPTED=1'
assert_contains 'run_systemctl daemon-reload'
assert_contains 'pg_dump'
assert_contains 'pg_restore'
assert_contains 'createdb'
assert_contains 'createdb --no-password --owner='
assert_contains 'database_user_from_url'
assert_contains 'initDb'
assert_contains 'LOCAL_API_URL="\$LOCAL_API_URL" PUBLIC_API_URL="\$API_URL"'
assert_contains 'RESTART_STARTED_AT_MS='
assert_contains 'deploy-readiness.mjs'
assert_contains 'assert_remote_url_has_no_inline_credentials'
assert_contains "trap 'on_signal TERM 143' TERM"
assert_contains '^umask 0022$'
assert_contains 'umask 0077; run_postgres'
assert_contains 'chmod 0600 -- "\$BACKUP_FILE"'

assert_absent 'git[[:space:]]+pull'
assert_absent 'git[[:space:]]+reset[[:space:]]+--hard'
assert_absent 'npm[[:space:]]+install'
assert_absent 'set[[:space:]]+-x'
assert_absent 'sudo[[:space:]]+-n[[:space:]]+true'
assert_absent '^umask 077$'
assert_absent 'deploy-\$\{SERVICE_NAME\}\.lock'

# Argument rejection is exercised without entering the repository/update path.
output="$(bash "$DEPLOY_SCRIPT" /tmp https://example.test 'invalid service name' 2>&1 || true)"
[[ "$output" == *'SERVICE_NAME contains unsupported characters'* ]] ||
  fail 'invalid service name was not rejected before deployment'

output="$(bash "$DEPLOY_SCRIPT" /tmp https://example.test '-her-api' 2>&1 || true)"
[[ "$output" == *'SERVICE_NAME contains unsupported characters'* ]] ||
  fail 'leading-dash service name was not rejected before deployment'

output="$(DEPLOY_ALLOW_INACTIVE_SERVICE=maybe bash "$DEPLOY_SCRIPT" /tmp https://example.test her-api 2>&1 || true)"
[[ "$output" == *'DEPLOY_ALLOW_INACTIVE_SERVICE must be 0 or 1'* ]] ||
  fail 'invalid inactive-service override was not rejected before deployment'

output="$(SERVER_ENV_FILE=/tmp/wrong.env bash "$DEPLOY_SCRIPT" /tmp https://example.test her-api 2>&1 || true)"
[[ "$output" == *'SERVER_ENV_FILE cannot override the production path /etc/her/api.env'* ]] ||
  fail 'server environment path override was not rejected before deployment'

output="$(DEPLOY_LOCK_FILE=relative.lock bash "$DEPLOY_SCRIPT" /tmp https://example.test her-api 2>&1 || true)"
[[ "$output" == *'DEPLOY_LOCK_FILE must be an absolute path'* ]] ||
  fail 'relative deployment lock path was not rejected before deployment'

output="$(bash "$DEPLOY_SCRIPT" /tmp https://example.test/nested her-api 2>&1 || true)"
[[ "$output" == *'API_URL must be a canonical HTTPS origin'* ]] ||
  fail 'API URL with a path was not rejected before deployment'

output="$(bash "$DEPLOY_SCRIPT" /tmp https://example.test/ her-api 2>&1 || true)"
[[ "$output" == *'API_URL must be a canonical HTTPS origin'* ]] ||
  fail 'API URL with a trailing slash was not rejected before deployment'

# Exercise real snapshot/partial-install/restore filesystem behavior, including
# a first installation where no log policy existed. No production path is used.
(
  source "$DEPLOY_SCRIPT"
  fixture="$(mktemp -d)"
  trap 'rm -rf -- "$fixture"' EXIT
  mkdir "$fixture/installed" "$fixture/target"
  printf 'previous unit\n' >"$fixture/installed/unit"
  chmod 0640 "$fixture/installed/unit"
  printf 'target unit\n' >"$fixture/target/unit"
  printf 'target log policy\n' >"$fixture/target/logrotate"
  BACKUP_FILE="$fixture/backup.dump"
  ops_file_paths() {
    printf '%s|%s|%s\n' \
      "$fixture/target/unit" "$fixture/installed/unit" unit \
      "$fixture/target/logrotate" "$fixture/installed/logrotate" logrotate
  }
  run_systemctl() { return 0; }
  snapshot_api_ops
  OPS_INSTALL_ATTEMPTED=1
  cp "$fixture/target/unit" "$fixture/installed/unit"
  cp "$fixture/target/logrotate" "$fixture/installed/logrotate"
  restore_api_ops
  [[ "$(<"$fixture/installed/unit")" == 'previous unit' ]] || fail 'ops rollback lost old unit'
  [[ ! -e "$fixture/installed/logrotate" ]] || fail 'ops rollback retained newly installed file'
  cmp "$OPS_BACKUP_DIR/unit" "$fixture/installed/unit" || fail 'ops rollback bytes differ'
  if [[ "$(uname -s)" == Linux ]]; then
    [[ "$(stat -c %a "$fixture/installed/unit")" == 640 ]] || fail 'ops rollback lost file mode'
  fi
)

# A failed target must stop before code/ops rollback. An active old service is
# restarted only after both restorations succeed; an inactive one stays stopped.
for initial_active in 0 1; do
  (
    source "$DEPLOY_SCRIPT"
    fixture="$(mktemp -d)"
    trap 'rm -rf -- "$fixture"' EXIT
    CODE_SWITCHED=1
    SERVICE_RESTART_ATTEMPTED=1
    SERVICE_WAS_ACTIVE="$initial_active"
    PREVIOUS_REVISION=0123456789012345678901234567890123456789
    git() { printf 'code\n' >>"$fixture/actions"; }
    npm() { return 0; }
    run_client_config() { return 0; }
    restore_api_ops() { printf 'ops\n' >>"$fixture/actions"; }
    wait_until_ready() { printf 'ready\n' >>"$fixture/actions"; }
    # The fixture uses the real Bash rollback coordinator, not systemd.
    run_systemctl() {
      case "$1" in
        stop|start) printf '%s\n' "$1" >>"$fixture/actions" ;;
        is-active) return 1 ;;
        *) fail 'unexpected systemctl call' ;;
      esac
    }
    # Rollback timestamps use the system service runtime on Linux.
    if [[ ! -x /usr/bin/node ]]; then
      # Windows Git Bash lacks that path; timestamp behavior has Node unit tests.
      SERVICE_RESTART_ATTEMPTED=0
    fi
    restore_previous_release
    actions="$(<"$fixture/actions")"
    if (( SERVICE_RESTART_ATTEMPTED == 1 && initial_active == 1 )); then
      [[ "$actions" == $'stop\ncode\nops\nstart\nready' ]] || fail 'active rollback order is wrong'
    elif (( SERVICE_RESTART_ATTEMPTED == 1 )); then
      [[ "$actions" == $'stop\ncode\nops' ]] || fail 'inactive rollback started a service'
    else
      [[ "$actions" == $'code\nops' ]] || fail 'pre-restart failure disturbed the service'
    fi
  )
done

# systemctl may return nonzero together with LoadState=not-found on bootstrap.
(
  export DEPLOY_ALLOW_INACTIVE_SERVICE=1
  source "$DEPLOY_SCRIPT"
  run_systemctl() { printf 'not-found\n'; return 1; }
  capture_service_initial_state
  [[ "$SERVICE_WAS_ACTIVE" == 0 ]] || fail 'missing-unit bootstrap is not inactive'
)

printf 'deploy.test.sh: ok\n'
