#!/usr/bin/env bash
# Run on the Pi, in your own terminal: asks for the vault's E2E passphrase and its ID key (the plugin's
# "Show current recovery code") without showing them, and writes secrets/bridge.env (only you can read it).
set -euo pipefail
cd "$(dirname "$0")/.."

read -rsp "LiveSync E2E passphrase: " passphrase; echo
read -rsp "LiveSync recovery code (sls-id-v1:...): " idkey; echo
[[ -n "$passphrase" && -n "$idkey" ]] || { echo "Both are needed; nothing written." >&2; exit 1; }

umask 077
printf 'LIVESYNC_PASSPHRASE_B64=%s\nLIVESYNC_ID_KEY_B64=%s\n' \
  "$(printf '%s' "$passphrase" | base64 -w0)" "$(printf '%s' "$idkey" | base64 -w0)" > secrets/bridge.env
unset passphrase idkey
echo "Wrote secrets/bridge.env."
