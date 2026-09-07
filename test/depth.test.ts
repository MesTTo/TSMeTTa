/**
 * Purpose: what the seat does at the far end of a term's depth, which is the
 *   ENGINE's own stack and nothing on this side.
 * Assumes:
 *   - `node --test` gives this file its own process, which is what lets it set
 *     a startup setting the rest of the suite must not see: `stackLimit` is
 *     frozen once an engine exists, and 64 MiB reaches the refusal in tens of
 *     thousands of levels instead of the 2,000,000 the build's own 1 GiB
 *     ceiling needs
 *   - the refused depth is FAR past the boundary, not just past it. The
 *     boundary is where the engine's boot footprint shows: measured by
 *     bisection after the same 10,000-level warm-up, 64 MiB accepts 45,038 and
 *     refuses 45,800 levels, and whether one particular depth lands on either
 *     side of that also depends on how the stacks grew getting there. The
 *     refusal case used to ask for 50,000, one warm-up away from the boundary,
 *     and one prelude equation was enough to flip it: measured 2026-09-07 in
 *     this file's own sequence, 50,000 refused before the one-sided assertion
 *     door landed and was ACCEPTED after, while 60,000 and up refused on both
 *     trees. 200,000 is four times the boundary, and it is also the faster
 *     case, refusing in 6.0 s where 50,000 spent 17.7 s building the term it
 *     then accepted
 * Guarantees:
 *   - the refusal is this package's own `StackLimitError` carrying the ceiling
 *     in bytes and naming its remedy, not a `RangeError` out of a library
 *   - the session is usable afterwards, which it was not before 2026-08-31:
 *     the stack used to run out INSIDE the WebAssembly call and left the
 *     engine answering `Unknown procedure: system:metta_node_do/2` for good
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type MeTTa, MettaError, StackLimitError, config, metta } from "../src/index.ts";

const CEILING = 64 * 1024 * 1024;

let m: MeTTa;

before(async () => {
  config.configure({ stackLimit: CEILING });
  m = await metta();
});

after(() => {
  assert.deepEqual(m.drainStderr(), [], "the engine wrote to standard error");
  m.dispose();
});

describe("the far end of a term's depth", () => {
  it("takes a term as deep as the engine's own stack allows", () => {
    const source = `${"(f ".repeat(10_000)}1${")".repeat(10_000)}`;
    assert.equal(m.parse(source).text, source);
  });

  it("refuses a deeper one by name, with the ceiling and the remedy", () => {
    const source = `${"(f ".repeat(200_000)}1${")".repeat(200_000)}`;
    assert.throws(
      () => m.parse(source),
      (error: unknown) => {
        assert.ok(error instanceof StackLimitError, String(error));
        assert.equal(error.code, "ERR_METTA_STACK");
        assert.equal(error.limit, CEILING, "the ceiling the engine reported, in bytes");
        assert.match(error.message, /METTA_STACK_LIMIT/, "the refusal names its remedy");
        return true;
      },
    );
  });

  it("leaves the session usable after that refusal", () => {
    assert.equal(m.parse("(f 1)").text, "(f 1)");
    assert.deepEqual(m.run("!(+ 1 2)")[0]?.texts, ["3"]);
    assert.ok(MettaError.is(new StackLimitError("x", 1), "ERR_METTA_STACK"));
  });
});
