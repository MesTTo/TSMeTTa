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
run GATE node-bench check_node_bench
