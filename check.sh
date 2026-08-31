# Purpose: this component's own gate lanes, in the root gate's vocabulary.
# Assumes: it is SOURCED by check.sh, not executed. That is what lets it use
#   `run`, `$HERE` and the shared summary table, so one component's lanes cannot
#   report their own status differently from another's, and a child's exit code
#   cannot be lost on the way back up -- the hazard a driver that EXECUTES its
#   children has to solve and this one does not have.
# Guarantees: every path a lane runs is written literally. tests/checks/
#   evidence_runners.py models which files a lane covers by READING this text
#   and resolving $HERE/, so a path reached through a local variable is a path
#   the evidence gate cannot see. Each lane below names the component script it
#   runs, and that script's own text carries the rest.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

# The Node binding, which is the seam's second consumer. It runs the engine in
# a WebAssembly SWI inside a Node process, so it needs neither the SWI on this
# machine nor janus. It is a TypeScript library, and its own suite covers the
# atom algebra, the codec, the boot inventory, the lazy answer surface, the
# three definition doors, the scopes, the extension tier and the benchmark
# case table. The conformance corpus is compared against the Python host by
# extensions/python/tests/ch21_another_language_at_the_seam/test_node_binding.py,
# in the pytest lane above.
#
# The lane runs extensions/node/test.sh, which is the same command a developer
# runs by hand, so the gate and the developer cannot drift apart. That script
# owns the skip protocol: swipl-wasm is an npm dependency and nothing here
# fetches it, because a gate that reaches the network is a gate that fails for
# a reason that is not the tree. It names the missing step instead, the same
# shape the C extension example takes when swipl-ld is absent.
check_node_binding() {
    [ -d "$HERE/extensions/node" ] || return 0
    sh "$HERE/extensions/node/test.sh"
}
run GATE node-binding check_node_binding

# What this seat's surface costs, against committed baselines.
#
# The same skip protocol, with two more steps it can name: this one also needs
# a made TypeScript build and a Python carrying metta.testing, because the
# comparison, the two-sided bands, the configuration stamp and the atomic
# re-pin are the shared harness's rather than this seat's.
#
# Six cases, and the counter that decides each is a property of the case rather
# than a policy: inferences where the engine does the work, because they are
# deterministic under load where wall clock is not, and perf's instructions:u
# where the work is on the TypeScript side of the wire, where the engine's
# counter cannot move at all. extensions/node/benchmarks/cases.ts says which
# and why, per case.
check_node_bench() {
    [ -d "$HERE/extensions/node" ] || return 0
    sh "$HERE/extensions/node/bench.sh"
}
# The BUILT package, which no other lane loads. `npm test` compiles source into
# build/ and runs that; the benchmarks do the same; the conformance comparison
# drives the source too. dist/ is what the package's own `exports` map points a
# consumer at, it is produced only by `npm run build:dist` or by npm's prepare
# hook, and nothing checked it was current. On 2026-08-31 it held the previous
# wire codec while the engine's bridge held the new one: a consumer got
# `WireError: not a transport atom` and then an engine that answered nothing,
# which read as a decode fix having broken the seat when the fix was fine and
# the artifact was old.
#
# It BUILDS first and then runs a consumer through the result, so what it
# guarantees is that the build product works and that anyone who has run the
# gate has a current one -- not that a stale one is detected. Detecting is not
# available and not the point: dist/ is gitignored, so a fresh checkout has
# none at all and there is no committed state to compare against. The hazard
# is a working tree whose dist/ predates its src/, and rebuilding is what ends
# it. The C seat's install lane is the same shape for the same reason.
check_node_dist() {
    [ -d "$HERE/extensions/node" ] || return 0
    [ -d "$HERE/extensions/node/node_modules" ] || {
        echo "note: extensions/node/node_modules is absent, the built-package \
check will not run; npm ci fetches swipl-wasm and a gate does not reach the \
network" >&2
        return 0
    }
    ( cd "$HERE/extensions/node" && npm run --silent build:dist &&
      node tools/dist-consumer.mjs )
}
run GATE node-dist check_node_dist

run GATE node-bench check_node_bench
