#!/bin/sh
# Purpose: this seat's own tests, as one entry point a developer and the gate
#   both call. `sh extensions/node/test.sh` is exactly what check.sh's
#   node-binding lane runs, so the two cannot drift apart.
# Assumes: npm and a node satisfying package.json's engines field.
# Guarantees:
#   - it does not FETCH. swipl-wasm is an npm dependency, and a gate that
#     reaches the network is a gate that fails for a reason that is not the
#     tree, so an absent one is announced with the command that installs it
#     and this exits 0. Everything that is a real failure exits nonzero
#     [tested: sh check.sh node-binding].
#   - it COMPILES the TypeScript and runs the build rather than running the
#     sources. Node's own type stripping would be shorter, but a distro build
#     is often compiled without it (`node -p
#     process.config.variables.node_use_amaro` answers false on Debian and
#     Ubuntu) and a suite that only ran on the official build would not run at
#     all on the machine that most needs it. The build also downlevels
#     `using`, which Node 22's V8 does not carry.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

set -eu
HERE=$(cd -- "$(dirname -- "$0")" && pwd)

if ! command -v node >/dev/null 2>&1; then
    echo "note: node not found, the Node binding suite will not run" >&2
    exit 0
fi
if [ ! -d "$HERE/node_modules/swipl-wasm" ]; then
    echo "note: run 'npm ci --prefix extensions/node', the Node binding suite \
will not run without swipl-wasm" >&2
    exit 0
fi

cd "$HERE" && npm run --silent typecheck && npm run --silent test
