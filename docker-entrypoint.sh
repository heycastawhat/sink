#!/bin/sh
# Starts as root only to make the data and notes folders usable, then runs Sink as PUID:PGID (default 1000:1000).
# Docker creates missing bind-mount folders as root, which the unprivileged server couldn't write to.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
if [ "$(id -u)" = "0" ]; then
  for dir in "$SINK_DATA_DIR" "$SINK_NOTES_DIR"; do
    mkdir -p "$dir"
    # Only the folder itself, never recursively; shares that force their own owner (CIFS, NFS root_squash) refuse
    # chown, and that's fine.
    [ "$(stat -c %u "$dir")" = "$PUID" ] || chown "$PUID:$PGID" "$dir" 2>/dev/null || true
  done
  exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
