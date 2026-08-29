/**
 * Purpose: run the gallery as a program and check what it printed, so the
 *   README's examples are executable rather than asserted.
 * Assumes:
 *   - the gallery is compiled beside this test when the compiled lane runs it,
 *     and sits at `example/gallery.ts` when the source lane does
 * Guarantees:
 *   - a gallery line that stops being true fails here, which is what keeps
 *     documentation from drifting away from the surface it documents
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { packageRoot } from "../src/index.ts";

/**
 * The gallery as it exists for whichever lane is running.
 *
 * The compiled lane runs `build/example/gallery.js` beside itself; the source
 * lane runs `example/gallery.ts`. Asking the filesystem is what keeps one test
 * honest in both.
 */
function examplePath(name: string): string {
  const beside = join(dirname(dirname(fileURLToPath(import.meta.url))), "example", `${name}.js`);
  return existsSync(beside) ? beside : join(packageRoot, "example", `${name}.ts`);
}

const galleryPath = (): string => examplePath("gallery");

describe("the gallery", () => {
  it("runs, and prints what the README says it prints", () => {
    const printed = execFileSync(process.execPath, [galleryPath()], {
      encoding: "utf-8",
      timeout: 120_000,
    });
    const lines = new Map(
      printed
        .split("\n")
        .filter((line) => line.includes(": "))
        .map((line) => {
          const at = line.indexOf(": ");
          return [line.slice(0, at), line.slice(at + 2)] as const;
        }),
    );

    assert.equal(lines.get("descendants of tom"), "bob ann eve");
    assert.equal(lines.get("heir of eve"), "none");
    assert.equal(
      lines.get("find-divisor, as one equation"),
      "(= (find-divisor $n $d) (if (> (* $d $d) $n) $n " +
        "(if (== (% $n $d) 0) $d (find-divisor $n (+ $d 1)))))",
    );
    assert.equal(lines.get("the same body, run in TypeScript"), "7");
    assert.equal(lines.get("four primes"), "True True True True");
    assert.equal(lines.get("a generator op is nondeterminism"), "(1 2 3 4)");
    assert.equal(lines.get("a plain op"), "HELLO");
    assert.equal(lines.get("an async op, awaited mid-reduction"), "40");
    assert.equal(lines.get("its declared effect"), "oracleIO");
    assert.equal(lines.get("the draft's view"), "0");
    assert.equal(lines.get("the parent, untouched"), "1");
    assert.equal(lines.get("after the commit"), '(todo 1 "write the guide" done)');
    assert.equal(lines.get("a case tower"), '"finished"');
    assert.equal(lines.get("a live Map, queried"), "2");
    assert.equal(lines.get("two spaces read as one"), "(kv ada 3) (kv bob 5) (kv cy 7)");
    assert.equal(lines.get("a union refuses writes"), "refused");
    assert.equal(lines.get("why it holds"), "12");
    assert.equal(lines.get("the rules it used"), "2");
    assert.equal(lines.get("a standing query saw"), "(alarm fire)");
  });

  it("keeps the repository README's own snippet running", () => {
    const printed = execFileSync(process.execPath, [examplePath("readme-snippet")], {
      encoding: "utf-8",
      timeout: 120_000,
    });
    assert.deepEqual(printed.trim().split("\n"), ["bob", "42", "ann", "oracleIO"]);
  });

  it("costs a constant number of crossings per ask, however deep the reduction", () => {
    const printed = execFileSync(process.execPath, [galleryPath()], {
      encoding: "utf-8",
      timeout: 120_000,
    });
    const cost = /Stats\(inferences=(\d+), crossings=(\d+)/.exec(printed);
    assert.ok(cost !== null, "the gallery printed no stats");
    const inferences = Number(cost[1]);
    const crossings = Number(cost[2]);
    assert.ok(inferences > 100_000, "the four primes did not cost real work");
    // Four asks. A lowered body leaves the engine only to start a job, pull its
    // answer and end it, so the crossing count is bounded by the number of ASKS
    // and not by the half a million inferences underneath them.
    assert.ok(crossings < 40, `four asks cost ${String(crossings)} crossings`);
  });
});
