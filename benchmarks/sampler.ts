/**
 * Purpose: take one sample of one case, either plainly or inside perf's
 *   measurement window, with everything but the work outside it.
 * Assumes:
 *   - `controlled` runs under `perf stat --control=fd:...`, which passes two
 *     pipe descriptors and their numbers in METTA_PERF_CONTROL_FD,
 *     METTA_PERF_ACK_FD and METTA_PERF_CLOSE_FDS. That is the same protocol
 *     extensions/python/benchmarks/pure.py speaks on the Python side, and
 *     metta.testing's measure_instructions is what sets it up for both
 *     [source: perf-stat(1), --control=fd:ctl-fd[,ack-fd]]
 * Guarantees:
 *   - explicit collection settles Prolog and then V8 before opening any
 *     measured counter; collector failures still release the engine
 *     [tested: "the sampler"; commit=32650f9ff4d1c4aa0749d8eb8b153e5bb448ee5c]
 *   - setup and teardown stay outside the measured window, so a count is the
 *     workload and not the engine boot in front of it [tested: "measures the
 *     workload rather than the boot in front of it"]
 *   - every sample gets FRESH state, because a space that kept its atoms would
 *     make the second sample a different workload from the first [tested:
 *     "gives every sample fresh state"]
 *   - a run whose operation count is not what the case declares, or whose
 *     crossings exceed a declared bound, throws before any number is reported
 *     [tested: "each case completes exactly the operations it declares",
 *     "the lazy case abandons the ask instead of draining it"]
 * Owns: the engine each sample boots. Every path releases it, the failing one
 *   included, through the finally in {@link sample}.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { closeSync, readSync, writeSync } from "node:fs";

import type { Bench, Case } from "./cases.ts";

/** What one sample of a case cost. */
export interface Sample {
  /** The engine's own counter over the window, or null for a host-side case. */
  readonly inferences: number | null;
  /** Host-to-engine round trips over the window, or null for a host-side case. */
  readonly crossings: number | null;
  /** Advisory. Wall clock decides nothing here; see benchmarks/baseline.json. */
  readonly seconds: number;
}

/** How a sample's measured window is opened and closed. */
export type Window = (work: () => Promise<number>) => Promise<number>;

/** No window at all: the engine counters need none. */
export const directly: Window = (work) => work();

/**
 * Read perf's acknowledgement of a control command.
 *
 * perf answers `ack\n` and pads the rest of a sixteen byte packet with NULs,
 * so the read is bounded by the packet and terminated by the newline inside
 * it, never by a count of bytes.
 */
function acknowledge(descriptor: number): void {
  const packet = Buffer.alloc(16);
  let filled = 0;
  for (;;) {
    const read = readSync(descriptor, packet, filled, packet.length - filled, null);
    if (read === 0) throw new Error("perf control acknowledgement pipe closed");
    filled += read;
    const seen = packet.subarray(0, filled);
    if (seen.includes(0x0a)) {
      const text = seen.toString("latin1").replace(/\0+$/, "");
      if (text !== "ack\n") throw new Error(`invalid perf control acknowledgement: ${text}`);
      return;
    }
    if (filled === packet.length) {
      throw new Error("invalid perf control acknowledgement: no newline in sixteen bytes");
    }
  }
}

function descriptorOf(name: string): number {
  const raw = process.env[name];
  const value = Number(raw);
  if (raw === undefined || !Number.isInteger(value) || value < 0) {
    throw new Error(`controlled perf descriptor ${name} is missing or invalid`);
  }
  return value;
}

/** perf's window: it starts counting at `enable` and stops at `disable`. */
export const controlled: Window = async (work) => {
  const control = descriptorOf("METTA_PERF_CONTROL_FD");
  const ack = descriptorOf("METTA_PERF_ACK_FD");
  for (const raw of String(process.env["METTA_PERF_CLOSE_FDS"]).split(",")) {
    closeSync(Number(raw));
  }
  writeSync(control, "enable\n");
  acknowledge(ack);
  try {
    return await work();
  } finally {
    writeSync(control, "disable\n");
    acknowledge(ack);
  }
};

/**
 * One measured window over prepared state.
 *
 * The stats scope, the wall reading and both checks sit OUTSIDE `around`, so
 * the two window kinds cannot drift into measuring different things.
 */
async function measure(one: Case, bench: Bench, around: Window): Promise<Sample> {
  const engine = bench.engine;
  const stats = engine === null ? null : engine.stats();
  const started = process.hrtime.bigint();
  const done = await around(() => bench.run());
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  stats?.[Symbol.dispose]();
  if (done !== one.operations) {
    throw new Error(
      `${one.name} completed ${String(done)} ${one.unit}, expected ${String(one.operations)}`,
    );
  }
  const crossings = stats === null ? null : stats.crossings;
  if (one.crossingBound !== undefined && crossings !== null && crossings > one.crossingBound) {
    throw new Error(
      `${one.name} took ${String(crossings)} host-to-engine crossings for ` +
        `${String(one.operations)} ${one.unit}, above its bound of ` +
        `${String(one.crossingBound)}: the ask was drained rather than abandoned`,
    );
  }
  return { inferences: stats === null ? null : stats.inferences, crossings, seconds };
}

/**
 * Settle both managed heaps before measuring prepared work.
 *
 * `--predictable-gc-schedule` makes collection deterministic given the same
 * allocation sequence, and the startup heap is part of that sequence: growing
 * any module the benchmark imports shifts where a collection lands INSIDE the
 * window, and four kilobytes of comments moved a row 3.7 percent. Collecting
 * to a fixed point here, outside the window, is what removes that.
 *
 * Prolog setup leaves garbage on its own stacks, independently of V8. Collect
 * it first, then collect V8 twice because finalizers can resurrect references.
 * SWI garbage_collect/0 collects the global and trail stacks and trims them
 * [source: https://github.com/SWI-Prolog/swipl-devel/blob/fc7ef84b949378b729052c3ade79c90ce5416abb/boot/syspred.pl#L1324;
 * commit=32650f9ff4d1c4aa0749d8eb8b153e5bb448ee5c].
 */
function settle(bench: Bench): void {
  const collect = (globalThis as { gc?: () => void }).gc;
  if (collect === undefined) return;
  bench.engine?.engine.once("garbage_collect");
  collect();
  collect();
}

/** One sample, on state built and released around it. */
export async function sample(one: Case, around: Window = directly): Promise<Sample> {
  const bench = await one.setup();
  try {
    settle(bench);
    return await measure(one, bench, around);
  } finally {
    bench.close();
  }
}
