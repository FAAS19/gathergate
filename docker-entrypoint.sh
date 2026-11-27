#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  DATA_PATH="${DATA_DIR:-/data}"
  if [ ! -d "$DATA_PATH" ]; then
    mkdir -p "$DATA_PATH"
  fi
  NEEDS_CHOWN=0
  NODE_UID="$(id -u node)"
  if [ "$(stat -c %u "$DATA_PATH")" != "$NODE_UID" ] || ! su-exec node test -w "$DATA_PATH"; then
    NEEDS_CHOWN=1
  else
    for f in "$DATA_PATH/.master.key" "$DATA_PATH/.dev-master.key" "$DATA_PATH/gathergate.sqlite" "$DATA_PATH/gathergate.sqlite-wal" "$DATA_PATH/gathergate.sqlite-shm" "$DATA_PATH/blobs"; do
      if [ -e "$f" ] && { [ "$(stat -c %u "$f")" != "$NODE_UID" ] || ! su-exec node test -r "$f" || ! su-exec node test -w "$f"; }; then
        NEEDS_CHOWN=1
        break
      fi
    done
  fi
  if [ "$NEEDS_CHOWN" = "1" ]; then
    chown -R node:node "$DATA_PATH"
  fi
  exec su-exec node "$@"
fi

exec "$@"
