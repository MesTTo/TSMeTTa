/**
 * Purpose: the generators, the property runner and the corpus checks — the
 *   tools this package offers a program that wants to test its own MeTTa.
 * Guarantees:
 *   - the same seed answers the same atoms, so a failing run is reproducible
 *   - a failing property is shrunk before it is reported
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type Atom, Expression, type MeTTa, S, V, metta } from "../src/index.ts";
import {
  Random,
  atoms,
  checkCodec,
  codecCorpus,
  countAtoms,
  expressions,
  forAll,
  fromPattern,
  integers,
  patterns,
  symbols,
} from "../src/testing.ts";
import { matchTerms } from "../src/matching.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("generating atoms", () => {
  it("generates the same atoms from the same seed", () => {
    const draw = (seed: number): string[] => {
      const random = new Random(seed);
      const source = atoms();
      return Array.from({ length: 20 }, () => source.generate(random, 3).text);
    };
    assert.deepEqual(draw(7), draw(7));
    assert.notDeepEqual(draw(7), draw(8));
  });

  it("fills a pattern's variables, so every instance matches it", () => {
    const pattern = S.edge(V.from, V.to);
    const outcome = forAll(
      fromPattern(pattern),
      (instance) => matchTerms(pattern, instance) !== undefined,
      { runs: 200, seed: 3 },
    );
    assert.ok(outcome.ok, `seed ${String(outcome.seed)}`);
  });

  it("shrinks a counterexample before reporting it", () => {
    // The property fails for any expression with more than one child, so the
    // shrinker should reach a two-child expression rather than report the
    // large one the generator produced.
    const outcome = forAll(
      expressions(symbols()),
      (atom) => !(atom instanceof Expression) || atom.items.length < 2,
      { runs: 200, seed: 11, size: 4 },
    );
    assert.ok(!outcome.ok);
    if (outcome.ok) return;
    const found = outcome.counterexample;
    assert.ok(found instanceof Expression);
    assert.equal(found.items.length, 2, `shrank to ${found.text}`);
  });

  it("shrinks a number toward zero", () => {
    const outcome = forAll(integers(-1000, 1000), (value) => value <= 10, {
      runs: 500,
      seed: 5,
    });
    assert.ok(!outcome.ok);
    if (outcome.ok) return;
    assert.equal(outcome.counterexample, 11, "the smallest failing integer");
  });

  it("reports a property that throws as a failure, with the error", () => {
    const outcome = forAll(symbols(), () => {
      throw new Error("always");
    }, { runs: 1 });
    assert.ok(!outcome.ok);
    if (outcome.ok) return;
    assert.match(String(outcome.error), /always/);
  });

  it("answers a pattern generator that always carries a variable", () => {
    const random = new Random(2);
    const source = patterns();
    let withVariables = 0;
    for (let at = 0; at < 30; at += 1) {
      const built = source.generate(random, 3);
      if (built.text.includes("$")) withVariables += 1;
    }
    assert.ok(withVariables > 0);
  });
});

describe("the corpus checks", () => {
  it("round-trips every shape the codec has a tag for", () => {
    const corpus = codecCorpus(4, 40);
    assert.ok(corpus.length > 40);
    const results = checkCodec((atom: Atom) => m.roundTrip(atom), corpus);
    const failed = results.filter((each) => !each.ok);
    assert.deepEqual(failed, [], failed.map((each) => `${each.name}: ${each.detail ?? ""}`).join("\n"));
  });

  it("counts distinct atoms up to variable spelling", () => {
    assert.equal(countAtoms([S.f(V.x), S.f(V.y), S.f(S.a)]), 2);
  });
});
