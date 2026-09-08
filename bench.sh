#!/bin/sh
# Purpose: measure this seat's surface against its committed baselines, as one
#   entry point a developer and the gate both call. `sh extensions/node/bench.sh`
#   is exactly what check.sh's node-bench lane runs.
# Assumes:
#   - a Python that can import metta_benchmarking, because the comparison, the
#     bands, the configuration stamp and the atomic re-pin all belong to the
#     shared harness in extensions/python/ext/metta-benchmarking/metta_benchmarking.py. One baseline
#     format and one regression protocol across every component is the point,
#     and DEVELOPING.md says not to copy the harness into another seat.
#   - node, swipl-wasm, and a made TypeScript build, because the workloads run
#     the compiled build.
# Guarantees:
#   - it does not FETCH and it does not BUILD. Each missing step is announced
#     with the command that supplies it and this exits 0, the same protocol
#     node-binding takes, because a gate that reaches the network fails for a
#     reason that is not the tree [tested: sh check.sh node-bench].
#   - without perf it measures the inference rows anyway and says which rows it
#     could not reach, rather than skipping the whole seat: an engine counter
#     needs no privileges and is the counter that decides most of these cases.
# Open Obligations:
#   To Do: None
#   Hacks: None
#   Future Enhancements: None

set -eu
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(cd -- "$HERE/../.." && pwd)

# One spelling of the bound, implemented in bounded.sh, which every runner in
# this tree and a command typed by hand all reach.
bounded() { sh "$ROOT/bounded.sh" "$@"; }

if ! command -v node >/dev/null 2>&1; then
    echo "note: node not found, the Node benchmarks will not run" >&2
    exit 0
fi
if [ ! -d "$HERE/node_modules/swipl-wasm" ]; then
    echo "note: run 'npm ci --prefix extensions/node', the Node benchmarks \
will not run without swipl-wasm" >&2
    exit 0
fi
if [ ! -f "$HERE/build/benchmarks/run.js" ]; then
    echo "note: run 'npm run build --prefix extensions/node', the Node \
benchmarks run the compiled build" >&2
    exit 0
fi

# The same interpreter search check.sh makes, and then the same question asked
# of it: not whether a python exists but whether THIS one carries the harness.
# A python that imports nothing useful would fail inside the driver with a
# traceback, which reads as a broken benchmark rather than a missing step.
PY=${CHECK_PY:-}
if [ -z "$PY" ]; then
    for candidate in "$HOME/Dev/.venv-pypetta/bin/python" "$ROOT/.venv/bin/python" python3; do
        if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
    done
fi
if ! command -v "$PY" >/dev/null 2>&1; then
    echo "note: no python found (set CHECK_PY), the Node benchmarks will not run" >&2
    exit 0
fi
# The guard asks for the module benchmarks/bench.py actually imports. It used
# to ask for metta.testing, which still imports and no longer carries the
# harness, so this lane died on an ImportError past a green guard.
if ! PYTHONPATH="$ROOT/extensions/python" bounded "$PY" -c \
        'import _workspace
_workspace.on_path()
import metta_benchmarking' \
        >/dev/null 2>&1; then
    echo "note: $PY cannot import metta_benchmarking; run 'uv sync --extra checks' in \
extensions/python or set CHECK_PY, the Node benchmarks will not run" >&2
    exit 0
fi

# perf and setarch are what metta_benchmarking.measure_instructions needs, and the
# rows they decide are the host-side ones. Without them the engine-counter rows
# still run, which is most of the suite.
COUNTER_ONLY=''
if ! command -v perf >/dev/null 2>&1 || [ ! -x /usr/bin/setarch ]; then
    echo "note: perf or setarch is absent, so the instruction rows \
(atom-intern, wire-roundtrip, and the host halves of query-rows, answers-lazy \
and host-op) will not be measured" >&2
    COUNTER_ONLY='--counter-only'
fi

exec sh "$ROOT/bounded.sh" "$PY" "$HERE/benchmarks/bench.py" $COUNTER_ONLY "$@"
