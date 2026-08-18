#!/bin/zsh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
    echo "Node.js 20.19 or newer is required."
    read -r "?Press Return to close..."
    exit 1
fi
node scripts/package-source.mjs
read -r "?Press Return to close..."
