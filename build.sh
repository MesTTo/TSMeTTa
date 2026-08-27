#!/bin/sh
# Purpose: build this binding through its own package scripts.
# Assumes: npm and a node satisfying package.json's engines field. The seat
#   fetches swipl-wasm from the registry, so a tree with no node_modules and no
#   network cannot build and says so rather than failing inside tsc.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

set -eu
HERE=$(cd -- "$(dirname -- "$0")" && pwd)

if ! command -v npm >/dev/null 2>&1; then
    echo "bindings/node/build.sh: npm not found; the Node binding will not build" >&2
    exit 0
fi
if [ ! -d "$HERE/node_modules" ]; then
    echo "bindings/node/build.sh: node_modules is absent; run 'npm install' in $HERE" >&2
    exit 0
fi
cd "$HERE" && npm run build --silent
