"""Purpose: drive this seat's benchmark cases and hold every one of them to a
committed baseline.

A THIN driver, deliberately. Every comparison rule below belongs to
metta.testing's BenchmarkBaseline and nothing here reimplements one: the
minimum of three samples, the two-sided band that fails a stale-high pin as
loudly as a regression, the declared instruction band that survives a re-pin,
the configuration stamp that refuses across configurations, and the atomic
replacement of the file. DEVELOPING.md's rule is the reason, and one baseline
format across every component is the point.

What this file adds is the part the shared harness cannot know: how to reach a
Node workload, which of the two counters decides each case, and the V8 flags an
instruction measurement on this seat needs to be worth reading at all.
Guarantees:
  - a regression in one case never hides another: every selected case is
    measured and every failure is reported before the nonzero exit, the shape
    benchmarks/check_instructions.py settled after a stop-at-first-failure
    form masked four stale pins [source: extensions/python/benchmarks/
    check_instructions.py, observe_all]
  - a pinned row nothing measures fails the compare and is pruned aloud by an
    update, so a renamed case cannot leave a dead receipt reading as coverage
    [source: extensions/python/benchmarks/extension_cost.py, compare]
  - the instruction rows are measured under V8_FLAGS and the stamp records
    them, so a run without them refuses rather than reporting the 16 percent
    difference between the two as movement in the code
Fails when:
  - node is absent, swipl-wasm is not installed, or the TypeScript build has
    not been made. Each names the command that supplies it and exits nonzero,
    because a benchmark that quietly measured nothing is worse than one that
    did not run. bench.sh answers those three before this file is reached and
    treats them as SKIPS instead, which is the gate's protocol rather than a
    developer's.
  - the configuration stamp differs from the one the pins were measured under.
    Exit 2, and distinct from a band failure's 1: nothing was compared, so
    there is no number to look at.
Open Obligations:
  To Do: None
  Hacks: None
  Future Enhancements: None
"""  # noqa: D205  -- the driver's contract is one continuous statement, not summary-and-body prose

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from collections.abc import Sequence
from pathlib import Path
from typing import TypedDict

HERE = Path(__file__).resolve().parent
SEAT = HERE.parent
ROOT = SEAT.parents[1]
# The Python seat carries the shared harness, and this seat's stamp sits beside
# this file. Both entries are needed and the ORDER is: the two seats each have a
# directory called `benchmarks`, and the Python one is a package, so a
# `benchmarks.configuration` written here would resolve to the Python seat's
# stamp and pin these rows against the C artifacts none of them can reach. This
# seat's stamp is reached as a top-level module out of its own directory
# instead, which no other tree defines.
sys.path.insert(0, str(ROOT / "extensions" / "python"))
sys.path.insert(0, str(HERE))

from configuration import V8_FLAGS, counter_configuration  # noqa: E402

from metta.testing import BenchmarkBaseline, measure_instructions  # noqa: E402

BASELINE = HERE / "baseline.json"
RUNNER = SEAT / "build" / "benchmarks" / "run.js"
SAMPLES = 3


def _node() -> str:
    """The node these workloads run on, named in full rather than looked up.

    measure_instructions BUILDS its child's environment instead of inheriting
    it, so a bare `node` handed to perf would be resolved against that rebuilt
    PATH and not against the one this process searched. Naming the executable
    settles which binary every row was measured on.
    """
    found = shutil.which("node")
    if found is None:
        message = "node is not on PATH; the Node benchmarks cannot run"
        raise SystemExit(message)
    return found


def _require_runner() -> None:
    if not (SEAT / "node_modules" / "swipl-wasm").is_dir():
        message = f"run 'npm ci --prefix {SEAT}': the benchmarks need swipl-wasm"
        raise SystemExit(message)
    if not RUNNER.is_file():
        message = (
            f"run 'npm run build --prefix {SEAT}': {RUNNER.relative_to(ROOT)} is not built"
        )
        raise SystemExit(message)


def _run(arguments: Sequence[str]) -> str:
    finished = subprocess.run(
        [_node(), str(RUNNER), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )
    if finished.returncode != 0:
        detail = finished.stderr.strip() or finished.stdout.strip()
        msg = f"node run.js {' '.join(arguments)} exited {finished.returncode}: {detail}"
        raise RuntimeError(msg)
    return finished.stdout


class Declared(TypedDict):
    """One case as benchmarks/cases.ts declares it, through `run.js --list`.

    The case table lives on the TypeScript side and this is the only shape of
    it here, so a case cannot be described one way there and another way in a
    second list kept beside this driver.
    """

    name: str
    unit: str
    operations: int
    counters: list[str]
    decidedBecause: str


class Measured(TypedDict):
    """What `run.js <case> --samples N` reports.

    `inferences` and `crossings` are null for a host-side case, which is the
    engine-free shape observe_counter takes a None for.
    """

    name: str
    unit: str
    operations: int
    counters: list[str]
    inferences: list[int] | None
    crossings: list[int] | None
    seconds: list[float]


def declared() -> list[Declared]:
    """Every case the TypeScript side declares, as it declares it."""
    return [json.loads(line) for line in _run(["--list"]).splitlines() if line.strip()]


def counters(name: str) -> Measured:
    """Three engine-counter samples, each on state built and released around it."""
    measured: Measured = json.loads(_run([name, "--samples", str(SAMPLES)]))
    return measured


def instructions(name: str) -> tuple[int, ...]:
    """Retired instructions for three runs, perf's window around the work alone."""
    return measure_instructions(
        [_node(), *V8_FLAGS, str(RUNNER), name, "--controlled"],
        rounds=SAMPLES,
        controlled=True,
        timeout=180.0,
    )


def observe(baseline: BenchmarkBaseline, case: Declared, *, wall: bool) -> list[str]:
    """Measure one case against its pins, answering one message per failure."""
    name, unit, operations = case["name"], case["unit"], case["operations"]
    wanted = case["counters"]
    failures: list[str] = []

    measured = counters(name)
    engine_samples = measured["inferences"]
    # The case table and the run have to agree about whether an engine was
    # opened at all. They cannot disagree by construction, so a disagreement is
    # a defect in one of them rather than a number worth comparing.
    if ("inferences" in wanted) != (engine_samples is not None):
        failures.append(
            f"{name} declares counters {wanted} but the run reported "
            f"{'no' if engine_samples is None else 'an'} inference sample"
        )
        return failures
    try:
        observed = baseline.observe_counter(
            name, unit=unit, operations=operations, samples=engine_samples
        )
        print(f"{name}: inferences={engine_samples} min={observed}")
    except AssertionError as error:
        failures.append(str(error))
        print(f"{name}: inferences={engine_samples} OUTSIDE BAND")
    if wall:
        baseline.observe_wall(name, min(measured["seconds"]) / operations)

    if "instructions" not in wanted:
        return failures
    retired = instructions(name)
    try:
        least = baseline.observe_instructions(name, retired)
        print(f"{name}: instructions={list(retired)} min={least}")
    except AssertionError as error:
        failures.append(str(error))
        print(f"{name}: instructions={list(retired)} OUTSIDE BAND")
    return failures


def prune(baseline: BenchmarkBaseline, measured: set[str], *, update: bool) -> None:
    """A pinned row nothing measured can never fail, so it is not coverage."""
    stale = sorted(name for name in baseline.cases if name not in measured)
    if not stale:
        return
    if not update:
        msg = (
            f"baseline rows nothing measured: {', '.join(stale)}; restore the "
            f"case or re-pin with --update to prune them"
        )
        raise AssertionError(msg)
    for name in stale:
        baseline.remove_case(name)
    print(f"pruned unmeasured baseline row(s): {', '.join(stale)}")


def main(argv: Sequence[str] | None = None) -> int:
    """Measure the selected cases and update or compare their counters."""
    _require_runner()
    known = {case["name"]: case for case in declared()}
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("cases", nargs="*", choices=sorted(known), default=sorted(known))
    parser.add_argument(
        "--update", action="store_true", help="re-pin every selected case"
    )
    parser.add_argument(
        "--counter-only",
        action="store_true",
        help="skip the perf rows, for a machine with no perf",
    )
    arguments = parser.parse_args(argv)
    selected = list(arguments.cases)

    baseline = BenchmarkBaseline(BASELINE, update=arguments.update)
    # A subset run must not restamp the fingerprint the rows it is NOT
    # measuring were pinned under, which is the rule check_instructions.py
    # follows for the same reason. A --counter-only run is a subset too: it
    # reaches no instruction row, so it cannot speak for the V8 flags those
    # rows were measured under.
    whole = set(selected) == set(known) and not arguments.counter_only
    try:
        baseline.observe_configuration(counter_configuration(), stamp=whole)
    except AssertionError as drift:
        # A refusal is not a regression and reads differently: nothing was
        # compared, so there is no number to look at. Exit 2 rather than 1 says
        # so, and the message already names both configurations, which a
        # traceback around it would only bury.
        #
        # The remedy it names is another seat's flag, because the message comes
        # from the shared harness. Only a WHOLE run restamps here -- a subset
        # cannot speak for the rows it did not measure -- so this seat's remedy
        # is the whole-suite re-pin, said in this seat's own words.
        print(f"cannot compare: {drift}", file=sys.stderr)
        if not whole:
            print(
                "in this seat the stamp is written by a whole-suite re-pin: run "
                "`sh extensions/node/bench.sh --update` with no case names and "
                "without --counter-only",
                file=sys.stderr,
            )
        return 2

    failures: list[str] = []
    measured: set[str] = set()
    for name in selected:
        case: Declared = {**known[name]}
        if arguments.counter_only:
            case["counters"] = [c for c in case["counters"] if c != "instructions"]
            if not case["counters"]:
                print(f"{name}: skipped, it has no counter besides instructions")
                continue
        measured.add(name)
        failures += observe(baseline, case, wall=arguments.update)
    # Only a run that measured EVERY case can say a pinned row is unmeasured. A
    # subset run, and a --counter-only run that skipped the instruction-only
    # rows, would read a live pin as a dead receipt and prune real coverage.
    if measured == set(known):
        prune(baseline, measured, update=arguments.update)
    baseline.finish()

    if failures:
        for message in failures:
            print(message, file=sys.stderr)
        print(f"{len(failures)} case(s) outside the band", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
