#!/bin/zsh
set -u
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
    echo "[ERROR] Node.js 20.19 or newer is required."
    echo "Download: https://nodejs.org/"
    read -r "?Press Return to close..."
    exit 1
fi
node scripts/start-local.mjs "$@"
status=$?
if (( status != 0 )); then
    echo
    echo "SuperSpalt failed to start. Review the error above."
    read -r "?Press Return to close..."
fi
exit $status
