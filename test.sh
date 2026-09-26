#!/bin/sh
# Purpose: this seat's own tests, as one entry point a developer and the gate
#   both call. `sh extensions/node/test.sh` is exactly what check.sh's
#   node-binding lane runs, so the two cannot drift apart.
# Assumes: npm and a node satisfying package.json's engines field.
# Guarantees:
#   - it does not FETCH. The compiler and the test tooling are npm
#     devDependencies, and a gate that reaches the network is a gate that
#     fails for a reason that is not the tree, so an absent install is
#     announced with the command that makes it and this exits 125. The
#     WebAssembly SWI-Prolog the suite boots is not among them: it is
#     committed in _host/. Everything that is a real failure exits nonzero
#     [tested: sh check.sh node-binding].
#   - it COMPILES the TypeScript and runs the build rather than running the
#     sources. Node's own type stripping would be shorter, but a distro build
#     is often compiled without it (`node -p
#     process.config.variables.node_use_amaro` answers false on Debian and
#     Ubuntu) and a suite that only ran on the official build would not run at
#     all on the machine that most needs it. The build also downlevels
#     `using`, which Node 22's V8 does not carry.
#   - a run of at least one lane's share of test files at once holds the
#     machine's full-width lock from before its build to its end, and one
#     refused exits 125 having built and run nothing (tools/full_width.sh)
#     [tested 2026-09-27T02:16:38+10:00: tests/checks/check_full_width_selftest.py].
# Owns resources: descriptor 6, the machine's full-width lock while this run
#   holds it; npm starts with it closed.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

set -eu
HERE=$(cd -- "$(dirname -- "$0")" && pwd)

# A missing prerequisite means this run says nothing about the tree, and 125 is
# the one word for that here: check.sh's run() turns it into `skipped` and names
# the lane under MEASURED NOTHING, where exiting 0 reports `ok` for a suite that
# ran no test. Measured 2026-09-20: node-bench answered `ok` in a battery whose
# node_modules had never been installed, and the same lane on a battery carrying
# the install found six cases outside the band.
unmeasured() {
    echo "note: $*" >&2
    exit 125
}

if ! command -v node >/dev/null 2>&1; then
    unmeasured "node not found, the Node binding suite will not run"
fi
if [ ! -d "$HERE/node_modules/typescript" ]; then
    unmeasured "run 'npm ci --prefix extensions/node', the Node binding suite \
will not run without the TypeScript compiler it builds with"
fi

# One spelling of the bound, implemented in bounded.sh, which every runner in
# this tree and a command typed by hand all reach.
bounded() { sh "$HERE/../../tools/bounded.sh" "$@"; }

# `npm test` runs every compiled test file through node --test, which runs
# os.availableParallelism() - 1 files at once [source
# 2026-09-27T01:39:36+10:00: https://nodejs.org/api/cli.html#--test-concurrency],
# so this run's width is that or the number of test files, whichever is
# smaller (tools/full_width.sh, metta_full_width_decide).
. "$HERE/../../tools/full_width.sh"
files=$(find "$HERE/test" -maxdepth 1 -name '*.test.ts' | wc -l)
concurrency=$(bounded node -e 'console.log(Math.max(1, require("node:os").availableParallelism() - 1))')
metta_full_width_invocation "$(( files < concurrency ? files : concurrency ))" || exit $?

cd "$HERE" && bounded npm run --silent typecheck 6>&- &&
    bounded npm run --silent test 6>&-
