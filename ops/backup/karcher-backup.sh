#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

[[ "$EUID" == 0 ]] || { printf 'backup: root is required\n' >&2; exit 1; }
TOOLS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly TOOLS_DIR
readonly APP_ROOT=/var/www/st24
readonly BACKUP_ROOT=/var/backups/st24
readonly ENCRYPTED_ROOT=/var/backups/karcher-encrypted
readonly RECIPIENTS_FILE=/etc/karcher-backup/recipients.txt
ENV_FILE=""
readonly REMOTE=yadisk:karcher-backups-encrypted/v1
readonly LOG_ROOT=/var/log/karcher-backup
readonly COMMAND_TIMEOUT_SECONDS=600
STAGE=initialization
DST=""
OFFSITE_SOURCE=""
STARTED_AT=""
SECURITY_BACKUP_PATHS=()
API_BACKUP_PATHS=()

collect_api_paths() {
  # Do not silently fall back to stale checkout secrets after managed adoption.
  local root="${1%/}"
  local path
  API_BACKUP_PATHS=()
  ENV_FILE="$root$APP_ROOT/server/.env"
  if [[ ! -e "$root/etc/her" && ! -L "$root/etc/her" &&
        ! -e "$root/etc/tmpfiles.d/her-api.conf" &&
        ! -e "$root/etc/logrotate.d/her-api" ]] &&
     ! grep -Fq 'EnvironmentFile=/etc/her/api.env' \
       "$root/etc/systemd/system/her-api.service" 2>/dev/null; then
    return 0
  fi
  [[ -d "$root/etc/her" && ! -L "$root/etc/her" ]] || {
    printf 'backup: MANAGED_API_DIRECTORY_INVALID\n' >&2; return 1;
  }
  for path in etc/her/api.env etc/her/client.env \
    etc/tmpfiles.d/her-api.conf etc/logrotate.d/her-api; do
    [[ -f "$root/$path" && ! -L "$root/$path" ]] || {
      printf 'backup: MANAGED_API_FILE_MISSING_OR_SYMLINKED: %s\n' "$path" >&2; return 1;
    }
    API_BACKUP_PATHS+=("$path")
  done
  path=etc/systemd/system/multi-user.target.wants/her-api.service
  if [[ -e "$root/$path" || -L "$root/$path" ]]; then
    [[ -L "$root/$path" &&
       "$(readlink -- "$root/$path")" == /etc/systemd/system/her-api.service ]] || {
      printf 'backup: MANAGED_API_BOOT_LINK_INVALID\n' >&2; return 1;
    }
    API_BACKUP_PATHS+=("$path")
  fi
  ENV_FILE="$root/etc/her/api.env"
  printf 'backup: managed API recovery inputs verified: %s entries\n' "${#API_BACKUP_PATHS[@]}"
}

collect_security_paths() {
  # The explicit root is for isolated tests; production always passes literal /.
  local root="${1%/}"
  local marker="$root/etc/karcher-backup/security-required"
  local configured=0
  local path directory dropin expected
  SECURITY_BACKUP_PATHS=()
  for path in etc/karcher-backup/security-required \
    etc/ssh/sshd_config.d/00-karcher-access.conf etc/karcher-security \
    usr/local/lib/karcher-security etc/systemd/system/karcher-firewall.service \
    etc/systemd/system/multi-user.target.wants/karcher-firewall.service; do
    if [[ -e "$root/$path" || -L "$root/$path" ]]; then configured=1; fi
  done
  if (( ! configured )); then
    printf 'backup: optional host security configuration not installed\n'
    return 0
  fi
  if [[ -e "$marker" || -L "$marker" ]]; then
    [[ -f "$marker" && ! -L "$marker" ]] || {
      printf 'backup: SECURITY_REQUIRED_MARKER_INVALID\n' >&2; return 1;
    }
  fi
  for directory in etc/ssh etc/ssh/sshd_config.d root root/.ssh \
    etc/karcher-security usr/local/lib/karcher-security \
    etc/systemd/system etc/systemd/system/multi-user.target.wants; do
    [[ -d "$root/$directory" && ! -L "$root/$directory" ]] || {
      printf 'backup: SECURITY_DIRECTORY_INVALID: %s\n' "$directory" >&2; return 1;
    }
  done
  [[ -f "$root/etc/ssh/sshd_config.d/00-karcher-access.conf" && \
    ! -L "$root/etc/ssh/sshd_config.d/00-karcher-access.conf" ]] || {
    printf 'backup: SSH_ACCESS_POLICY_MISSING_OR_SYMLINKED\n' >&2; return 1;
  }
  for path in etc/ssh/sshd_config root/.ssh/authorized_keys \
    etc/karcher-security/inbound.nft usr/local/lib/karcher-security/load-firewall.sh \
    etc/systemd/system/karcher-firewall.service; do
    [[ -f "$root/$path" && ! -L "$root/$path" ]] || {
      printf 'backup: SECURITY_FILE_MISSING_OR_SYMLINKED: %s\n' "$path" >&2; return 1;
    }
    SECURITY_BACKUP_PATHS+=("$path")
  done
  for dropin in "$root/etc/ssh/sshd_config.d/"*.conf; do
    [[ -e "$dropin" || -L "$dropin" ]] || continue
    [[ -f "$dropin" && ! -L "$dropin" ]] || {
      printf 'backup: SSH_DROPIN_INVALID\n' >&2; return 1;
    }
    SECURITY_BACKUP_PATHS+=("${dropin#"$root/"}")
  done
  directory="$root/etc/systemd/system/karcher-firewall.service.d"
  if [[ -e "$directory" || -L "$directory" ]]; then
    [[ -d "$directory" && ! -L "$directory" ]] || {
      printf 'backup: FIREWALL_DROPIN_DIRECTORY_INVALID\n' >&2; return 1;
    }
    for dropin in "$directory/"*.conf; do
      [[ -e "$dropin" || -L "$dropin" ]] || continue
      [[ -f "$dropin" && ! -L "$dropin" ]] || {
        printf 'backup: FIREWALL_DROPIN_INVALID\n' >&2; return 1;
      }
      SECURITY_BACKUP_PATHS+=("${dropin#"$root/"}")
    done
  fi
  for path in etc/systemd/system/multi-user.target.wants/karcher-firewall.service \
    etc/systemd/system/nftables.service; do
    expected=/etc/systemd/system/karcher-firewall.service
    if [[ "$path" == etc/systemd/system/nftables.service ]]; then expected=/dev/null; fi
    [[ -L "$root/$path" && "$(readlink -- "$root/$path")" == "$expected" ]] || {
      printf 'backup: FIREWALL_BOOT_STATE_INVALID: %s\n' "$path" >&2; return 1;
    }
    SECURITY_BACKUP_PATHS+=("$path")
  done
  printf 'backup: host security recovery inputs verified: %s entries\n' "${#SECURITY_BACKUP_PATHS[@]}"
}

write_status() {
  local status="$1"
  local temporary
  temporary="$(mktemp "$BACKUP_ROOT/.status.XXXXXXXX")"
  printf '{"checkedAt":"%s","startedAt":"%s","status":"%s","stage":"%s","backupSet":"%s","encryption":"age-x25519-v1"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$STARTED_AT" "$status" "$STAGE" "${DST##*/}" >"$temporary"
  chmod 0600 "$temporary"
  if [[ "$status" == verified ]]; then
    local success_temporary
    success_temporary="$(mktemp "$BACKUP_ROOT/.success.XXXXXXXX")"
    cp -- "$temporary" "$success_temporary"
    chmod 0600 "$success_temporary"
    mv -f -- "$success_temporary" "$BACKUP_ROOT/.last-success.json"
  fi
  mv -f -- "$temporary" "$BACKUP_ROOT/.last-run.json"
}

on_error() {
  local code="$1"
  trap - ERR
  write_status failed || true
  printf 'backup: FAILED stage=%s exit=%s; existing copies retained\n' "$STAGE" "$code" >&2
  exit "$code"
}

verify_offsite() {
  local attempt
  # A read can fail transiently after a successful upload. Every successful run
  # still requires a complete downloaded-content comparison, not ignored errors.
  for attempt in 1 2 3; do
    printf 'download verification attempt=%s\n' "$attempt" >>"$LOG_ROOT/$SET_NAME.check.log"
    if timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" \
      rclone check "$OFFSITE_SOURCE" "$REMOTE/$SET_NAME" --download --one-way \
      --retries 2 --low-level-retries 2 --contimeout 15s --timeout 60s \
      >>"$LOG_ROOT/$SET_NAME.check.log" 2>&1; then
      return 0
    fi
    if [[ "$attempt" != 3 ]]; then
      sleep 5
    fi
  done
  return 1
}

# Never follow a replacement symlink when protecting the backup storage.
[[ ! -L "$BACKUP_ROOT" ]] || { printf 'backup: unexpected backup symlink\n' >&2; exit 1; }
[[ ! -L "$ENCRYPTED_ROOT" ]] || { printf 'backup: unexpected encrypted storage symlink\n' >&2; exit 1; }
install -d -o root -g root -m 0700 "$BACKUP_ROOT" "$ENCRYPTED_ROOT" "$LOG_ROOT"
exec 9>/var/lock/st24-backup.lock
chmod 0600 /var/lock/st24-backup.lock
flock -n 9 || { printf 'backup: another run is active\n' >&2; exit 75; }
trap 'on_error $?' ERR

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SET_NAME="$(date -u +%Y-%m-%d_%H-%M-%S)_UTC"
readonly SET_NAME
readonly STAGING="$BACKUP_ROOT/.${SET_NAME}.partial.$$"
readonly ENCRYPTED_STAGING="$ENCRYPTED_ROOT/.${SET_NAME}.partial.$$"
DST="$BACKUP_ROOT/$SET_NAME"
OFFSITE_SOURCE="$ENCRYPTED_ROOT/$SET_NAME"
write_status running

STAGE=encryption_configuration
[[ ! -L "$RECIPIENTS_FILE" && -f "$RECIPIENTS_FILE" ]]
[[ "$(stat -c %u "$RECIPIENTS_FILE")" == 0 && "$(stat -c %a "$RECIPIENTS_FILE")" == 600 ]]
timeout --kill-after=10s 60s python3 "$TOOLS_DIR/encrypted_backup.py" check-recipient \
  --recipients "$RECIPIENTS_FILE" --age /usr/bin/age >/dev/null

STAGE=security_configuration
collect_security_paths /
readonly -a SECURITY_BACKUP_PATHS

STAGE=configuration
collect_api_paths /
readonly ENV_FILE
readonly -a API_BACKUP_PATHS
DATABASE_URL_VALUE="$(/usr/bin/node "$TOOLS_DIR/read-database-url.mjs" "$ENV_FILE")"
run_pg() {
  DEPLOY_DATABASE_URL="$DATABASE_URL_VALUE" \
    timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" \
    /usr/bin/node "$TOOLS_DIR/postgres-command.mjs" "$@"
}

[[ ! -e "$DST" && ! -e "$STAGING" && ! -e "$OFFSITE_SOURCE" && ! -e "$ENCRYPTED_STAGING" ]]
mkdir -m 0700 "$STAGING"

STAGE=database_dump
run_pg pg_dump --no-password --format=custom --file="$STAGING/st24_db.dump"
timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" \
  pg_restore --list "$STAGING/st24_db.dump" >/dev/null

STAGE=files_archive
# Include source/build artifacts and recovery configuration. Application temp,
# dependencies and Git internals are excluded. Archive errors are fatal.
timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" tar \
  --acls --xattrs \
  --exclude='*/node_modules' --exclude='*/.git' --exclude='*/tmp' \
  --exclude='*/.monitor-state.json*' --exclude='*/.health-*.tmp' \
  -czf "$STAGING/st24_files.tar.gz" -C / \
  var/www/st24 etc/nginx etc/letsencrypt \
  etc/systemd/system/her-api.service \
  etc/karcher-backup \
  usr/local/lib/karcher-backup usr/local/bin/st24-backup.sh \
  "${API_BACKUP_PATHS[@]}" \
  "${SECURITY_BACKUP_PATHS[@]}" \
  2>"$LOG_ROOT/$SET_NAME.tar.log"
timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" \
  tar -tzf "$STAGING/st24_files.tar.gz" >/dev/null

STAGE=checksums
(cd "$STAGING" && sha256sum st24_db.dump st24_files.tar.gz >SHA256SUMS.txt && \
  sha256sum --check --status SHA256SUMS.txt)
chmod 0600 "$STAGING/"*
mv -- "$STAGING" "$DST"
write_status local_verified
printf 'backup: local copy verified: %s\n' "$SET_NAME"

STAGE=encryption
timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" python3 "$TOOLS_DIR/encrypted_backup.py" seal \
  --source "$DST" --output "$ENCRYPTED_STAGING" --recipients "$RECIPIENTS_FILE" --age /usr/bin/age \
  >"$LOG_ROOT/$SET_NAME.encryption.log" 2>&1
mv -- "$ENCRYPTED_STAGING" "$OFFSITE_SOURCE"

STAGE=offsite_copy
timeout --kill-after=10s "${COMMAND_TIMEOUT_SECONDS}s" rclone copy "$OFFSITE_SOURCE" "$REMOTE/$SET_NAME" \
  --retries 2 --low-level-retries 2 --contimeout 15s --timeout 60s \
  >"$LOG_ROOT/$SET_NAME.offsite.log" 2>&1

STAGE=offsite_verification
verify_offsite
STAGE=complete
write_status verified
printf 'backup: local and encrypted offsite contents verified\n'

# Existing copies are intentionally not pruned while cloud access is being
# repaired. Add retention only with a verified recovery path and explicit scope.
