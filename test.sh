#!/bin/sh
# Purpose: this seat's own tests, as one entry point a developer and the gate
#   both call. `sh extensions/node/test.sh` is exactly what check.sh's
#   node-binding lane runs, so the two cannot drift apart.
# Assumes: npm and a node satisfying package.json's engines field.
# Guarantees:
#   - it does not FETCH. The compiler and the test tooling are npm
#     devDependencies, and a gate that reaches the network is a gate that
#     fails for a reason that is not the tree, so an absent install is
#     announced on a line starting SKIPPED: with the command that makes it,
#     and this exits 125. The WebAssembly SWI-Prolog the suite boots is not
#     among them: it is committed in _host/. Nothing else exits 125: a failed
#     step exits with its own status, and a suite with no test file, or whose
#     run node --test reports as zero tests, exits 1 naming what it expected
#     [tested 2026-09-28T18:35:41+10:00: tests/checks/check_skip_channel_selftest.py].
#   - it COMPILES the TypeScript and runs the build rather than running the
#     sources. Node's own type stripping would be shorter, but a distro build
#     is often compiled without it (`node -p
#     process.config.variables.node_use_amaro` answers false on Debian and
#     Ubuntu) and a suite that only ran on the official build would not run at
#     all on the machine that most needs it. The build also downlevels
#     `using`, which Node 22's V8 does not carry.
#   - a run of at least one lane's share of test files at once holds the
#     machine's full-width lock from before its build to its end, and one
#     refused exits 1 having built and run nothing, the refusal naming the
#     holder (tools/full_width.sh, metta_full_width_runner_refused)
#     [tested 2026-09-28T18:35:41+10:00: tests/checks/check_full_width_selftest.py].
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
# the install found six cases outside the band. These checks are this runner's
# only road to 125, and each says SKIPPED with what is absent: anything that
# ends a run after them, a crash or a refused claim, is a failure, since a
# skip there is how a crashed claim once read as a missing prerequisite and let
# every gate pass without this suite [the record, i-jc-node-binding-refused].
unmeasured() {
    echo "SKIPPED: $*" >&2
    exit 125
}

if ! command -v node >/dev/null 2>&1; then
    unmeasured "node not found, the Node binding suite will not run"
fi
if [ ! -d "$HERE/node_modules/typescript" ]; then
    unmeasured "extensions/node/node_modules has no typescript, the compiler the \
Node binding suite builds with; 'npm ci --prefix extensions/node' installs it"
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
if [ "$files" -eq 0 ]; then
    echo "node-binding: $HERE/test holds no *.test.ts, so the suite has nothing to run" >&2
    exit 1
fi
concurrency=$(bounded node -e 'console.log(Math.max(1, require("node:os").availableParallelism() - 1))')
metta_full_width_invocation "$(( files < concurrency ? files : concurrency ))" || exit $?

# Each step on a line of its own, so errexit ends the run at the first that
# fails with that step's status: in an AND-list only the last command's
# failure ends the shell, and a failed typecheck would have run on into the
# count below.
cd "$HERE"
bounded npm run --silent typecheck 6>&-
bounded npm run --silent test 6>&-

# node --test exits 0 over a glob that matches no file, reporting `# tests 0`
# [measured 2026-09-28T01:47:34+10:00: node 22.22.1 over an empty glob], so the
# suite's own count decides, read from the TAP report package.json's test
# script writes beside the spec output, build/ being made fresh by each build.
tests=$(sed -n 's/^# tests \([0-9][0-9]*\)$/\1/p' build/test-report.tap 2>/dev/null | tail -n 1)
if [ "${tests:-0}" -eq 0 ]; then
    echo "node-binding: node --test reported ${tests:-no} tests over build/test/*.test.js," \
         "where test/ holds $files *.test.ts, so the suite ran none of them" >&2
    exit 1
fi
