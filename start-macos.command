#!/bin/zsh
set -u
cd "$(dirname "$0")"
source "scripts/ensure-node-macos.zsh"
if ! ensure_superspalt_node; then
    read -r "?Press Return to close..."
    exit 1
fi

"$SUPERSPLAT_NODE_EXE" scripts/start-local.mjs "$@"
status=$?
if (( status != 0 )); then
    echo
    echo "SuperSpalt failed to start. Review the error above."
    read -r "?Press Return to close..."
fi
exit $status
