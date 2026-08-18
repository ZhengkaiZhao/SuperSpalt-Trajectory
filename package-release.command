#!/bin/zsh
set -u
cd "$(dirname "$0")"
source "scripts/ensure-node-macos.zsh"
if ! ensure_superspalt_node; then
    read -r "?Press Return to close..."
    exit 1
fi
"$SUPERSPLAT_NODE_EXE" scripts/package-source.mjs
status=$?
read -r "?Press Return to close..."
exit $status
