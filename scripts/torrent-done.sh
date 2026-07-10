#!/bin/sh
# Installed wherever Transmission actually runs (its container/host), and
# pointed to by Transmission's settings.json:
#   "script-torrent-done-enabled": true,
#   "script-torrent-done-filename": "/path/to/torrent-done.sh"
#
# Transmission invokes this script (no args) and sets TR_TORRENT_DIR /
# TR_TORRENT_NAME / TR_TORRENT_ID / TR_TORRENT_HASH in its environment.
# This just relays that as JSON to the archiver's webhook; all the real
# parsing/matching/copying logic lives there.
#
# ARCHIVER_URL lives in torrent-done.env, next to this script (copy
# torrent-done.env.example to torrent-done.env and fill it in - see that
# file for why a plain env var on Transmission's own container usually
# doesn't work here).

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f "$SCRIPT_DIR/torrent-done.env" ]; then
  . "$SCRIPT_DIR/torrent-done.env"
fi

ARCHIVER_URL="${ARCHIVER_URL:-http://domestique:8420/webhook/torrent-done}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

DIR_ESCAPED=$(json_escape "$TR_TORRENT_DIR")
NAME_ESCAPED=$(json_escape "$TR_TORRENT_NAME")
ID_ESCAPED=$(json_escape "$TR_TORRENT_ID")
HASH_ESCAPED=$(json_escape "$TR_TORRENT_HASH")

PAYLOAD=$(printf '{"dir":"%s","name":"%s","id":"%s","hash":"%s"}' \
  "$DIR_ESCAPED" "$NAME_ESCAPED" "$ID_ESCAPED" "$HASH_ESCAPED")

curl -sS -m 300 -X POST "$ARCHIVER_URL" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  >> "$SCRIPT_DIR/torrent-done.log" 2>&1 || true
