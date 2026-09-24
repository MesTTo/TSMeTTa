/**
 * Purpose: a stack ceiling named in METTA_STACK_LIMIT, above the one boot
 *   would derive from the host's memory, is the one every ask runs under.
 * Assumes:
 *   - `node --test` gives this file its own process, so the variable it sets
 *     before the package loads is read by that process's config and by nothing
 *     else in the suite
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import type { MeTTa } from "../src/index.ts";

/** Above any ceiling a 4 GiB memory leaves boot, which is under 2 GiB. */
const ABOVE = 3 * 1024 ** 3;

let m: MeTTa;

before(async () => {
  process.env["METTA_STACK_LIMIT"] = String(ABOVE);
  const { config, metta } = await import("../src/index.ts");
  assert.equal(config.stackLimit, ABOVE, "the variable is read as the other seats read it");
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("a stack ceiling named in METTA_STACK_LIMIT", () => {
  it("takes a configured ceiling above the derived one", () => {
    assert.equal(m.engine.stackLimit, ABOVE);
    const made = m.engine.once(
      "engine_create(L, current_prolog_flag(stack_limit, L), E), engine_next(E, Limit), engine_destroy(E)",
    )["Limit"];
    assert.equal(Number(made), ABOVE, "an engine made after boot, as an ask's is, takes it too");
  });
});
