#!/usr/bin/env bash
set -Eeuo pipefail

readonly config=/etc/karcher-security/inbound.nft
[[ $EUID -eq 0 && -f "$config" && ! -L "$config" ]]
exec 9> /run/lock/karcher-firewall.lock
flock -x 9

present=0
if /usr/sbin/nft list table inet karcher_ingress >/dev/null 2>&1; then
  present=1
fi

emit_batch() {
  if (( present )); then
    printf '%s\n' 'delete table inet karcher_ingress'
  fi
  /bin/cat -- "$config"
}

# Validation and replacement are limited to the table owned by this service.
# The real replacement is one transaction: no live delete/add gap.
emit_batch | /usr/sbin/nft --check --file -
emit_batch | /usr/sbin/nft --file -
