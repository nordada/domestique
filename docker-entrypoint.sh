#!/bin/sh
# Container entrypoint: optionally drop root before starting the app.
#
# PUID/PGID follow the linuxserver.io convention Unraid users already know:
# set both to run the app as that user/group instead of root, so a
# compromised app process can't touch anything the bind-mounted shares
# don't already grant that user. Left unset (or set to an empty string,
# which is what docker-compose's "${PUID:-}" expands to when .env doesn't
# define it - same empty-vs-unset gotcha documented in server.ts), the
# container runs as root exactly as it always has, so existing deployments
# don't change behavior on upgrade.
#
# What gets chowned automatically: only the config dir(s) holding
# events.json/settings.json - tiny, so doing it every boot is cheap, and
# settings.json MUST be owned by the app user (the app enforces owner-only
# 0600 on it). The library and downloads mounts are deliberately never
# touched: they can be terabytes, and ownership there is the host's
# business - see the README's "Running as a non-root user" section for the
# one-time chown an existing install needs before switching PUID on.
set -e

if [ "$(id -u)" = "0" ] && [ -n "${PUID:-}" ]; then
  PGID="${PGID:-$PUID}"
  for f in "${CONFIG_PATH:-/app/config/events.json}" "${SETTINGS_PATH:-/app/config/settings.json}"; do
    chown -R "$PUID:$PGID" "$(dirname "$f")" 2>/dev/null || true
  done
  exec su-exec "$PUID:$PGID" "$@"
fi

exec "$@"
