/**
 * Purpose: keep the benchmark case table honest about itself, since a
 *   benchmark's own defects are exactly the kind nothing else notices: a case
 *   that stopped doing its work still prints a number, and a pin nobody
 *   measures still reads as coverage.
 * Assumes:
 *   - the committed baseline sits at benchmarks/baseline.json and is the
 *     document benchmarks/bench.py compares against
 * Guarantees:
 *   - a case's declared counters match what it can produce, so a case cannot
 *     claim an engine counter it never opens an engine for
 *   - the committed baseline and the case table name exactly the same rows, in
 *     both directions
 *   - the lazy case really abandons its ask, which is the whole content of its
 *     inference pin of zero
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../src/index.ts";
import { CASES, NAMES } from "../benchmarks/cases.ts";
import { sample } from "../benchmarks/sampler.ts";

// From packageRoot rather than from this file, because this suite runs both
// from `test/` under type stripping and from `build/test/` under the compiled
// build, and only one of those has the baseline two directories away. tsc emits
// no JSON, so `build/benchmarks/` holds none.
const BASELINE = join(packageRoot, "benchmarks", "baseline.json");

interface Pinned {
  readonly unit?: string;
  readonly operations?: number;
  readonly inferences?: number | null;
  readonly instructions?: number;
}

const pinned = JSON.parse(readFileSync(BASELINE, "utf8")) as {
  benchmarks: Record<string, Pinned>;
};

describe("the benchmark case table", () => {
  it("declares at least one deciding counter per case", () => {
    for (const name of NAMES) {
      assert.ok(CASES[name]!.counters.length > 0, `${name} decides on nothing`);
    }
  });

  it("every case that pins inferences holds an engine, and every engine-free case does not", async () => {
    for (const name of NAMES) {
      const one = CASES[name]!;
      const bench = await one.setup();
      try {
        assert.equal(
          bench.engine !== null,
          one.counters.includes("inferences"),
          `${name} declares ${one.counters.join(",")} but ` +
            `${bench.engine === null ? "opens no engine" : "opens an engine"}`,
        );
      } finally {
        bench.close();
      }
    }
  });

  it("each case completes exactly the operations it declares", async () => {
    for (const name of NAMES) {
      const one = CASES[name]!;
      const bench = await one.setup();
      try {
        assert.equal(await bench.run(), one.operations, `${name} did not do its work`);
      } finally {
        bench.close();
      }
    }
  });

  it("the lazy case abandons the ask instead of draining it", async () => {
    const one = CASES["answers-lazy"]!;
    const bench = await one.setup();
    try {
      const engine = bench.engine;
      assert.ok(engine !== null);
      // A stats scope, not the raw counters: those are cumulative for the whole
      // engine and the setup's two thousand adds are already in them, 340,003
      // inferences and 8,000 crossings worth.
      const spent = engine.stats();
      await bench.run();
      spent[Symbol.dispose]();
      // Twenty of two thousand rows, fifty times. A drain costs one crossing a
      // row for the whole source, so this separates the two by two orders of
      // magnitude.
      assert.ok(
        spent.crossings <= one.crossingBound!,
        `the lazy ask took ${String(spent.crossings)} crossings, above ${String(one.crossingBound)}`,
      );
      // And the engine counter says nothing at all about it, which is why the
      // case pins zero there and lets instructions:u carry the size.
      assert.equal(spent.inferences, 0);
    } finally {
      bench.close();
    }
  });
});

describe("the sampler", () => {
  it("gives every sample fresh state", async () => {
    // Two samples of a case whose workload GROWS with what the space already
    // holds. Equal counts is the whole claim: state that survived a sample
    // would put two thousand more atoms in front of the second query and move
    // its count, the way one engine reused across rounds reads 62,072 then
    // 89,846 [measured 2026-08-28].
    const one = CASES["query-rows"]!;
    const first = await sample(one);
    const second = await sample(one);
    assert.equal(first.inferences, second.inferences);
    assert.equal(first.crossings, second.crossings);
  });

  it("measures the workload rather than the boot in front of it", async () => {
    // query-rows adds two thousand atoms in its SETUP and then asks one
    // question. Each add is a crossing, so a window that had swallowed the
    // setup would report thousands; the window that holds the query alone
    // reports one per row plus the job's own start and end.
    const one = CASES["query-rows"]!;
    const measured = await sample(one);
    assert.ok(
      measured.crossings !== null && measured.crossings < one.operations + 10,
      `the window swallowed the setup: ${String(measured.crossings)} crossings`,
    );
  });
});

describe("the committed baseline", () => {
  it("pins exactly the cases the table declares, in both directions", () => {
    assert.deepEqual(Object.keys(pinned.benchmarks).sort(), [...NAMES].sort());
  });

  it("agrees with each case on its unit and its operation count", () => {
    for (const name of NAMES) {
      const one = CASES[name]!;
      const row = pinned.benchmarks[name]!;
      assert.equal(row.unit, one.unit, `${name} unit`);
      assert.equal(row.operations, one.operations, `${name} operations`);
    }
  });

  it("pins an inference count exactly for the cases that decide on one, and null for the rest", () => {
    for (const name of NAMES) {
      const one = CASES[name]!;
      const row = pinned.benchmarks[name]!;
      if (one.counters.includes("inferences")) {
        assert.equal(typeof row.inferences, "number", `${name} has no inference pin`);
      } else {
        assert.equal(row.inferences, null, `${name} pins inferences it cannot measure`);
      }
    }
  });

  it("pins retired instructions for every case that decides on them", () => {
    for (const name of NAMES) {
      if (!CASES[name]!.counters.includes("instructions")) continue;
      assert.equal(typeof pinned.benchmarks[name]!.instructions, "number", `${name}`);
    }
  });
});
