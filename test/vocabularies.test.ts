/**
 * Purpose: the sync gate between this package's vocabulary tables and the
 *   engine's own catalog.
 * Assumes: the engine publishes one `(vocabulary Name Value...)` atom per
 *   vocabulary in `&metta`.
 * Guarantees:
 *   - the tables are checked against a BOOTED engine rather than against a
 *     copy of the catalog kept here, so the two cannot drift silently
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { Expression, type MeTTa, Sym, metta } from "../src/index.ts";
import {
  EffectClass,
  OpKind,
  SpaceCapability,
  VOCABULARIES,
  type VocabularyName,
  effectRank,
  isValueOf,
  joinEffects,
  valuesOf,
} from "../src/vocabularies.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("the engine's vocabularies", () => {
  it("every vocabulary here matches the engine's own", async () => {
    const engineRows = new Map<string, string[]>();
    for await (const atom of m.catalog.atoms()) {
      if (!(atom instanceof Expression)) continue;
      const head = atom.items[0];
      if (!(head instanceof Sym) || head.name !== "vocabulary") continue;
      const name = String(atom.items[1]);
      engineRows.set(name, atom.items.slice(2).map(String));
    }
    assert.ok(engineRows.size > 0, "the engine publishes its vocabularies");

    const declared = Object.keys(VOCABULARIES) as VocabularyName[];
    assert.deepEqual(
      declared.slice().sort(),
      [...engineRows.keys()].sort(),
      "the same vocabularies, no more and no fewer",
    );
    for (const name of declared) {
      assert.deepEqual(
        valuesOf(name),
        engineRows.get(name),
        `${name} carries the catalog's own values, in the catalog's own order`,
      );
    }
  });

  it("images a hyphenated word through this package's own casing map", () => {
    // `S.bestFirst` is the symbol `best-first`, and so is this key.
    assert.equal(VOCABULARIES["answer-policy"].bestFirst, "best-first");
    assert.equal(VOCABULARIES["delivery"].perWriteExactly, "per-write-exactly");
    // A word the map leaves alone keeps its exact spelling, underscore and all.
    assert.equal(OpKind.raw_det, "raw_det");
    assert.equal(VOCABULARIES["visibility"].PUBLIC, "PUBLIC");
  });

  it("ranks and joins the effect lattice by the catalog's own order", () => {
    assert.equal(effectRank(EffectClass.pureStructural), 0);
    assert.equal(effectRank(EffectClass.oracleIO), 4);
    assert.equal(joinEffects(), EffectClass.pureStructural);
    assert.equal(
      joinEffects(EffectClass.readOnlyLookup, EffectClass.writesState, EffectClass.pureStructural),
      EffectClass.writesState,
    );
    // The join is idempotent, commutative and associative, which is what makes
    // it a lattice join rather than a sum.
    const a = EffectClass.readOnlyLookup;
    const b = EffectClass.oracleIO;
    assert.equal(joinEffects(a, a), a);
    assert.equal(joinEffects(a, b), joinEffects(b, a));
    assert.equal(joinEffects(joinEffects(a, b), a), joinEffects(a, joinEffects(b, a)));
  });

  it("answers whether a bare word is one of a vocabulary's values", () => {
    assert.ok(isValueOf("space-capability", SpaceCapability.file));
    assert.ok(!isValueOf("space-capability", "telepathy"));
  });
});
