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
# ARCHIVER_URL defaults to the bike-race-archiver container's default port;
# override it (e.g. via Transmission's own environment) if you changed PORT
# or are reaching it through a different hostname.

ARCHIVER_URL="${ARCHIVER_URL:-http://bike-race-archiver:8420/webhook/torrent-done}"

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
  >> /var/log/bike-race-archiver-hook.log 2>&1 || true
