#!/usr/bin/env bash
# Keep the existing cron entry while using the root-owned backup tools.
set -Eeuo pipefail
umask 077
exec /usr/local/lib/karcher-backup/karcher-backup.sh "$@"
