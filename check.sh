# Purpose: this component's own gate lanes, in the root gate's vocabulary.
# Assumes: it is SOURCED by check.sh, not executed. That is what lets it use
#   `run`, `$HERE` and the shared summary table, so one component's lanes cannot
#   report their own status differently from another's, and a child's exit code
#   cannot be lost on the way back up -- the hazard a driver that EXECUTES its
#   children has to solve and this one does not have.
# Guarantees: every path a lane runs is written literally. tests/checks/
#   evidence_runners.py models which files a lane covers by READING this text
#   and resolving $HERE/, so a path reached through a local variable is a path
#   the evidence gate cannot see.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

# The Node binding, which is the seam's second consumer. It runs the engine in
# a WebAssembly SWI inside a Node process, so it needs neither the SWI on this
# machine nor janus. It is a TypeScript library, and its own suite covers the
# atom algebra, the codec, the boot inventory, the lazy answer surface, the
# three definition doors, the scopes and the extension tier. The conformance
# corpus is compared against the Python host by
# bindings/python/tests/ch21_another_language_at_the_seam/test_node_binding.py,
# in the pytest lane above.
#
# swipl-wasm is an npm dependency and this does not fetch it: a gate that
# reaches the network is a gate that fails for a reason that is not the tree.
# It says which step is missing instead, the same shape the C extension example
# above takes when swipl-ld is absent.
check_node_binding() {
    binding="$HERE/bindings/node"
    [ -d "$binding" ] || return 0
    if ! command -v node >/dev/null 2>&1; then
        echo "note: node not found, the Node binding suite will not run" >&2
        return 0
    fi
    if [ ! -d "$binding/node_modules/swipl-wasm" ]; then
        echo "note: run 'npm ci' in bindings/node, the Node binding suite will \
not run without swipl-wasm" >&2
        return 0
    fi
    # The binding is TypeScript, and this COMPILES it and runs the build rather
    # than running the sources. Node's own type stripping would be the shorter
    # route, but a distro build is often compiled without it
    # (`node -p process.config.variables.node_use_amaro` answers false on
    # Debian and Ubuntu), and a gate that only ran on the official build would
    # not run at all on the machine that most needs it. The build also
    # downlevels `using`, which Node 22's V8 does not carry.
    # The path is spelled out rather than reached through $binding because the
    # evidence gate models which files a lane runs by reading this text, and it
    # resolves $HERE/ and not a local variable. Without the literal it cannot
    # see bindings/node/test/*.test.ts at all, and every evidence claim naming
    # one of those tests reads as unbacked.
    ( cd "$HERE/bindings/node" && npm run --silent typecheck && npm run --silent test )
}
run GATE node-binding check_node_binding
