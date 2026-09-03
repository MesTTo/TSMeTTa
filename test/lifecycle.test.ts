/**
 * Purpose: verify that canonical spaces, disposable draft spaces, and
 *   concurrent coordination keep one coherent host-side lifecycle.
 * Guarantees:
 *   - every space resolves the surface's canonical reflection space
 *     [tested: "resolves one canonical catalog from every space";
 *     commit=62369c406ca1afee026539a825fa2469c768d957]
 *   - settling a world evicts its released draft from both host caches
 *     [tested: "evicts committed and restored world drafts from both host caches";
 *     commit=62369c406ca1afee026539a825fa2469c768d957]
 *   - concurrent takes arbitrate through deletion and consume distinct atoms
 *     [tested: "lets concurrent takes consume distinct matching atoms";
 *     commit=62369c406ca1afee026539a825fa2469c768d957]
 *   - the engine-owned &self and &metta roots refuse clear and release without
 *     damaging catalog, typing, or arithmetic state, while named spaces keep
 *     both lifecycle operations
 *     [tested: "refuses destructive lifecycle operations on engine-owned base spaces";
 *     commit=6229e43cb68cc3685360810d462d992874992f6c]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type MeTTa, S, V, metta } from "../src/index.ts";

let m: MeTTa;
let counter = 0;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("space lifecycle", () => {
  it("resolves one canonical catalog from every space", () => {
    const kb = m.space(`&catalog-owner-${String(counter += 1)}`);

    assert.equal(kb.catalog, m.catalog);
    assert.equal(kb.catalog, kb.catalog);
  });

  it("evicts committed and restored world drafts from both host caches", () => {
    for (const settlement of ["commit", "restore"] as const) {
      const parent = m.space(`&world-parent-${String(counter += 1)}`);
      const world = m.world(parent);
      const draft = world.space;
      const name = draft.name;

      assert.equal(m.space(name), draft);
      assert.ok(m.engine.knownSpaces.has(name));
      world[settlement]();

      assert.ok(!m.engine.knownSpaces.has(name), `${settlement} kept the decoder name`);
      assert.ok(!m.spaces().some((identity) => identity.text === name));
      assert.notEqual(m.space(name), draft, `${settlement} kept the released Space object`);
    }
  });

  it("refuses destructive lifecycle operations on engine-owned base spaces", () => {
    const before = m.catalog.size;

    for (const space of [m.self, m.catalog]) {
      for (const [engineOperation, operation] of [
        ["clear", () => space.clear()],
        ["release", () => space.release()],
      ] as const) {
        assert.throws(operation, (error: unknown) => {
          const message = String(error);
          assert.ok(message.includes(space.name));
          assert.ok(message.includes(engineOperation));
          assert.match(message, /caller's own context space/);
          assert.match(message, /named space/);
          return true;
        });
      }
    }

    assert.equal(m.catalog.size, before);
    assert.deepEqual(m.run("!(get-type 1)\n!(+ 1 2)").map((group) => group.texts), [
      ["Number"],
      ["3"],
    ]);

    const clearable = m.space(`&base-clear-control-${String(counter += 1)}`);
    clearable.add(S.ordinary(S.clear));
    clearable.clear();
    assert.equal(clearable.size, 0);
    clearable.release();

    const releasable = m.space(`&base-release-control-${String(counter += 1)}`);
    releasable.add(S.ordinary(S.release));
    releasable.release();
    assert.ok(!m.spaces().some((identity) => identity.text === releasable.name));
  });
});

describe("coordination arbitration", () => {
  it("lets concurrent takes consume distinct matching atoms", async () => {
    const jobs = m.space(`&take-race-${String(counter += 1)}`);
    jobs.add(S.job(1), S.job(2));

    const rows = await Promise.all([
      jobs.take(S.job(V.n), { pollMs: 1 }),
      jobs.take(S.job(V.n), { pollMs: 1 }),
    ]);

    assert.deepEqual(rows.map((row) => String(row["n"])).sort(), ["1", "2"]);
    assert.equal(jobs.size, 0);
  });
});
