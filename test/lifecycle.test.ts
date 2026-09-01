/**
 * Purpose: verify that canonical spaces, disposable draft spaces, and
 *   concurrent coordination keep one coherent host-side lifecycle.
 * Guarantees:
 *   - every space resolves the surface's canonical reflection space
 *   - settling a world evicts its released draft from both host caches
 *   - concurrent takes arbitrate through deletion and consume distinct atoms
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
