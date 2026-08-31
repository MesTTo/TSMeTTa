/**
 * Purpose: what the seat does at the far end of a term's depth, which is the
 *   ENGINE's own stack and nothing on this side.
 * Assumes:
 *   - `node --test` gives this file its own process, which is what lets it set
 *     a startup setting the rest of the suite must not see: `stackLimit` is
 *     frozen once an engine exists, and 64 MiB reaches the refusal at 50,000
 *     levels instead of the 2,000,000 the build's own 1 GiB ceiling needs
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
    const source = `${"(f ".repeat(50_000)}1${")".repeat(50_000)}`;
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
