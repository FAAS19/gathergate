#!/bin/sh
set -eu

if [ "$(id -u)" = "0" ]; then
  DATA_PATH="${DATA_DIR:-/data}"
  if [ ! -d "$DATA_PATH" ]; then
    mkdir -p "$DATA_PATH"
  fi
  if [ "$(stat -c %u "$DATA_PATH")" != "$(id -u node)" ] || ! su-exec node test -w "$DATA_PATH"; then
    chown -R node:node "$DATA_PATH"
  fi
  exec su-exec node "$@"
fi

exec "$@"
