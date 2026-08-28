"""Purpose: the measurement configuration this seat's counter baselines
depend on, so a pin measured in one of them REFUSES to compare against
another instead of reporting a phantom regression.
Assumes:
  - the five keys below are the ones that move a number here. The
    Python seat's own stamp names C artifacts instead, and correctly: none of
    engine/reader.so, writer.so or json_codec.so can load in a WebAssembly
    SWI, which has no dynamic linking, so their presence cannot reach these
    pins [source: extensions/node/src/engine.ts, mountControlFiles's comment
    on entry(engine, _) files in a wasm build]
Guarantees:
  - v8_flags is the flag set the instruction rows were measured under, and it
    is load bearing rather than descriptive: a host-side workload of
    atom-intern's shape retires 3,379,578,381 instructions on a bare node and
    3,773,450,276 under these flags, 11.7 percent apart, so a pin read across
    that line reports movement that is entirely the flags' [measured
    2026-08-28: four rounds each through metta.testing.measure_instructions,
    minimum of each]
  - swipl_wasm and v8 name the two compiled artifacts the numbers are made of,
    the engine's own bytes and the machine that runs this side of the wire
  - runtime says which of the seat's two execution routes ran: the compiled
    build, which is what check.sh drives, or Node's own type stripping, which
    compiles the TypeScript at run time and is different code doing the job
Decides:
  - that the seat census is stamped. boot mounts extensions/*/extension.pl one
    file at a time and the engine READS them to record which seats are present,
    so a checkout carrying a different set boots a differently configured
    engine [source: extensions/node/src/engine.ts, mountControlFiles]. Whether
    that reaches any pin in this file is NOT measured; it is stamped because an
    isolated worktree missing a seat is exactly the shape that has quietly
    measured a different configuration before, and the cost of the stamp is one
    honest refusal when somebody adds a seat [assumed 2026-08-28]
Open Obligations:
  To Do: None
  Hacks: None
  Future Enhancements: None
"""  # noqa: D205, D415  -- the stamp's contract is one continuous statement, not summary-and-body prose

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

SEAT = Path(__file__).resolve().parents[1]
ROOT = SEAT.parents[1]

#: The V8 flags every instruction row is measured under, and why each is here.
#:
#: A Node process is not deterministic enough to gate on retired instructions
#: without them. Measured 2026-08-28 over four rounds of one engine workload:
#: bare node spreads 29.48 percent, which is unusable against any band worth
#: having. `--liftoff-only` alone takes it to 2.55 percent, which names the
#: mechanism: the swing was TurboFan tiering swipl-wasm's module up on
#: background threads part way through the measured window, so the count
#: depended on when tier-up happened to fire rather than on the work.
#: `--predictable` removes the residual background-task scheduling and takes it
#: to 0.041 percent, and `--predictable-gc-schedule` fixes the heap growth
#: behind the last of it, 0.027 percent. The pure host-side workload lands at
#: 0.0006 percent under the same set.
#:
#: The cost is stated rather than hidden: these rows measure Liftoff-compiled
#: WebAssembly and single-threaded V8, which is not the tier a user's process
#: settles into. A gate reads the CHANGE, so that is the right trade, and it is
#: V8's own answer to the same question [source:
#: https://v8.dev/docs/  --predictable is V8's documented predictable mode].
V8_FLAGS = ("--predictable", "--predictable-gc-schedule", "--liftoff-only")


def _swipl_wasm_version() -> str | None:
    """The engine bytes this seat runs on, or None when nothing is installed."""
    manifest = SEAT / "node_modules" / "swipl-wasm" / "package.json"
    if not manifest.is_file():
        return None
    version = json.loads(manifest.read_text(encoding="utf-8")).get("version")
    return version if isinstance(version, str) else None


def _v8_version() -> str:
    """V8's own version, which is what decides an instruction count."""
    node = shutil.which("node")
    if node is None:
        return "absent"
    return subprocess.run(  # noqa: S603  -- the executable is resolved by shutil.which and both arguments are this line's own literals
        [node, "-p", "process.versions.v8"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def _seats() -> str:
    """The control-file census boot mounts, in the order readdir gives it."""
    controls = ROOT / "extensions"
    if not controls.is_dir():
        return ""
    return ",".join(
        sorted(seat.name for seat in controls.iterdir() if (seat / "extension.pl").is_file())
    )


def counter_configuration() -> dict[str, str]:
    """The live configuration a measurement on this seat runs in.

    A Node upgrade moves v8 and refuses every row, including the inference
    rows a V8 change cannot reach. That coarseness is the shared harness's:
    the stamp is one document-level fingerprint. It is worth having rather
    than working around, because re-pinning after such a refusal re-measures
    both kinds at once, and the inference rows coming back IDENTICAL is the
    check that the upgrade changed nothing on the engine's side of the wire.
    """
    return {
        "swipl_wasm": _swipl_wasm_version() or "absent",
        "v8": _v8_version(),
        "v8_flags": " ".join(V8_FLAGS),
        # Which of the seat's two execution routes the workload took. The
        # compiled build is what check.sh runs, because a distro node is often
        # built without type stripping; `npm run test:source` is the other
        # route and compiles the TypeScript at run time, which is different
        # code doing the same job and so a different instruction count.
        "runtime": "build",
        "seats": _seats(),
    }
