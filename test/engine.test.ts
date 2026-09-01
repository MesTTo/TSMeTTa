/**
 * Purpose: the public floor of the engine coroutine and its job cursor.
 * Guarantees:
 *   - `Job` exposes exhaustion and collection, but no dead uniqueness helper
 *     that can return before proving uniqueness and leak its engine
 *     [tested: "does not expose the partial Job.only helper";
 *     commit=d6342cff24b7c087b464d9cdb13b71a3d9a115a2]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { Job } from "../src/engine.ts";

describe("the engine job cursor", () => {
  it("does not expose the partial Job.only helper", () => {
    assert.ok(!("only" in Job.prototype));
  });
});
