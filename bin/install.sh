#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
PROJECT_ROOT=$(CDPATH= cd -P "$SCRIPT_DIR/.." && pwd)
CLI_PATH=$PROJECT_ROOT/dist/cli.js
NODE_COMMAND=${NODE:-node}

if [ ! -f "$CLI_PATH" ]; then
  printf '%s\n' "taskfence: built CLI not found at $CLI_PATH" >&2
  printf '%s\n' "Build TaskFence before running bin/install.sh." >&2
  exit 1
fi

exec "$NODE_COMMAND" "$CLI_PATH" install "$@"
