/**
 * Purpose: value algebras — the exact carriers, the law checks, the tagged
 *   program, and the retained derivation `under` reinterprets without asking
 *   again.
 * Guarantees:
 *   - a law is checked by exhaustion over the declared carrier before its
 *     declaration lands, so a false claim is refused with the counterexample
 *   - fusion happens only under a law the algebra actually has, and the
 *     decision is reported either way
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { G, type MeTTa, S, type Space, V, metta } from "../src/index.ts";
import {
  Algebra,
  AlgebraDeclarationError,
  AlgebraLawError,
  AlgebraRequirementError,
  Amplitude,
  LinearEvidenceError,
  PRESETS,
  Rational,
  annotate,
  counting,
  declare,
  evaluate,
  hasTaggedProgram,
  prov,
  requireAlgebra,
  sample,
  taggedFact,
  taggedRule,
  tropical,
} from "../src/algebra.ts";

let m: MeTTa;
let counter = 0;

const fresh = (): Space => {
  counter += 1;
  return m.space(`&tagged${String(counter)}`);
};

/** Two edges and one transitive rule, tagged with costs. */
const paths = (kb: Space): void => {
  kb.add(
    taggedFact(1, S.edge(S.a, S.b)),
    taggedFact(2, S.edge(S.b, S.c)),
    taggedFact(10, S.edge(S.a, S.c)),
    taggedRule(0, S.path(V.x, V.z), S.edge(V.x, V.y), S.edge(V.y, V.z)),
    taggedRule(0, S.path(V.x, V.y), S.edge(V.x, V.y)),
  );
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("exact carriers", () => {
  it("adds and multiplies rationals without rounding", () => {
    const sixteenth = new Rational(1n, 16n);
    assert.equal(sixteenth.plus(sixteenth).toString(), "1/8");
    assert.equal(new Rational(2n, 4n).toString(), "1/2", "normalised on construction");
    assert.equal(new Rational(1n, -2n).toString(), "-1/2", "the sign lives on top");
    assert.ok(new Rational(3n).equals(new Rational(6n, 2n)));
    assert.throws(() => new Rational(1n, 0n));
    // The reason this exists: the float would not be exact.
    assert.equal(new Rational(1n, 3n).plus(new Rational(2n, 3n)).toString(), "1");
  });

  it("interferes exactly, which is what an amplitude is for", () => {
    const one = new Amplitude(1n);
    const i = new Amplitude(0n, 1n);
    // i * i = -1, and nothing rounds on the way.
    assert.ok(i.times(i).equals(new Amplitude(-1n)));
    // A half plus a negative half cancels EXACTLY, which is interference.
    const half = new Amplitude(new Rational(1n, 2n));
    assert.ok(half.plus(new Amplitude(new Rational(-1n, 2n))).equals(new Amplitude(0n)));
    assert.equal(one.plus(i).toString(), "1+1i");
    assert.equal(one.plus(new Amplitude(0n, -1n)).toString(), "1-1i");
  });
});

describe("declaring an algebra", () => {
  it("ships the carriers a program reaches for", async () => {
    assert.deepEqual(Object.keys(PRESETS).sort(), [
      "amplitude",
      "bag",
      "bool",
      "budget",
      "counting",
      "prob",
      "prov",
      "ranked",
      "set",
      "tropical",
    ]);
    assert.equal((await requireAlgebra(m.catalog, "tropical")).combine, "min");
    assert.equal(tropical.extend, "+");
    assert.equal(tropical.order, "ascending");
    assert.equal(counting.combine, "+");
    assert.equal(prov.combine, "plus");
    await assert.rejects(() => requireAlgebra(m.catalog, "nothing-declares-this"), AlgebraDeclarationError);
  });

  it("checks a claimed law by exhaustion, and refuses the counterexample", async () => {
    // `max` over {0, 1} really is associative, commutative and idempotent.
    const named = `honest${String(counter++)}`;
    const row = await declare(m.self, named, {
      combine: "max",
      extend: "*",
      zero: 0,
      one: 1,
      laws: ["associative", "commutative", "idempotent"],
      carrier: [0, 1],
    });
    assert.match(row.text, /^\(algebra honest/);
    assert.equal((await requireAlgebra(m.catalog, named)).combine, "max");
    await assert.rejects(
      () => declare(m.self, named, { combine: "max", extend: "*", zero: 0, one: 1 }),
      AlgebraDeclarationError,
    );

    // An operation that leaves the carrier is refused before any law is even
    // reached: `1 - 1` is 0, and 0 is not in {1, 2}.
    await assert.rejects(
      () =>
        declare(m.self, `unclosed${String(counter++)}`, {
          combine: "-",
          extend: "*",
          zero: 0,
          one: 1,
          laws: ["commutative"],
          carrier: [1, 2],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AlgebraLawError);
        assert.match(error.message, /algebra_carrier_not_closed/);
        return true;
      },
    );

    // A closed operation that is NOT commutative is refused with the
    // counterexample. `leftmost` is closed over any carrier by construction.
    m.run("(= (leftmost $a $b) $a)");
    await assert.rejects(
      () =>
        declare(m.self, `dishonest${String(counter++)}`, {
          combine: "leftmost",
          extend: "leftmost",
          zero: 1,
          one: 1,
          laws: ["commutative"],
          carrier: [1, 2],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AlgebraLawError);
        assert.match(error.message, /algebra_law_violation/);
        assert.match(error.message, /combine-commutative/);
        return true;
      },
    );
  });

  it("refuses a law it cannot check, rather than trusting it", async () => {
    await assert.rejects(
      () =>
        declare(m.self, `unchecked${String(counter++)}`, {
          combine: "max",
          extend: "*",
          zero: 0,
          one: 1,
          laws: ["associative"],
        }),
      (error: unknown) => {
        assert.ok(error instanceof AlgebraLawError);
        assert.match(error.message, /finite_carrier_required/);
        return true;
      },
    );
  });

  it("refuses a law name it does not know", async () => {
    await assert.rejects(
      () =>
        declare(m.self, `unknown${String(counter++)}`, {
          combine: "max",
          extend: "*",
          zero: 0,
          one: 1,
          laws: ["telepathic"],
        }),
      (error: unknown) => {
        assert.match(String(error), /algebra_law_unknown/);
        return true;
      },
    );
  });
});

describe("a tagged program", () => {
  it("counts the derivations of a conclusion", async () => {
    const kb = fresh();
    paths(kb);
    // `evaluate` folds the tags a program STORED, which here are costs; the
    // counting reading is the derivation's own SHAPE, which `under` re-reads
    // from the retained tree.
    const { answers } = await evaluate(kb, S.path(S.a, S.c), { algebra: tropical });
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.value.text, "(path a c)");
    const counted = await (answers[0] as NonNullable<(typeof answers)[0]>).under(counting);
    // Two ways from a to c: the direct edge, and a-b-c.
    assert.equal(counted.annotation, 2);
  });

  it("answers the cheapest derivation under the tropical semiring", async () => {
    const kb = fresh();
    paths(kb);
    const { answers } = await evaluate(kb, S.path(S.a, S.c), { algebra: tropical });
    // min over {1 + 2, 10} is 3: the two-hop path beats the direct edge.
    assert.equal(answers[0]?.annotation, 3);
  });

  it("orders answers by the carrier's declared direction", async () => {
    const kb = fresh();
    paths(kb);
    const { answers } = await evaluate(kb, S.path(V.from, V.to), { algebra: tropical });
    const costs = answers.map((answer) => Number(answer.annotation));
    assert.deepEqual(costs, [...costs].sort((a, b) => a - b), "ascending, as tropical declares");
  });

  it("fuses only under a law it has checked", async () => {
    const kb = fresh();
    paths(kb);
    const fused = await evaluate(kb, S.path(S.a, S.c), { algebra: tropical });
    assert.deepEqual(fused.plan, [
      { optimization: "fuse-equal-conclusions", applied: true, missingLaws: [] },
    ]);

    // An algebra without combine-associative may not fuse, and says so rather
    // than fusing quietly.
    const named = `unfused${String(counter++)}`;
    await declare(m.self, named, { combine: "max", extend: "*", zero: 0, one: 1 });
    const unfused = await evaluate(kb, S.path(S.a, S.c), { algebra: named });
    assert.equal(unfused.plan[0]?.applied, false);
    assert.deepEqual(unfused.plan[0]?.missingLaws, ["combine-associative"]);
    assert.equal(unfused.answers.length, 2, "two derivations, kept apart");
  });

  it("refuses the second spend of one premise", async () => {
    const named = `linear${String(counter++)}`;
    await declare(m.self, named, {
      combine: "+",
      extend: "*",
      zero: 0,
      one: 1,
      requires: ["linear"],
    });
    const kb = fresh();
    kb.add(
      taggedFact(1, S.coin()),
      // One rule that consumes the same premise twice: under a linear algebra
      // the second spend is a refusal rather than a derivation.
      taggedRule(1, S.pair(), S.coin(), S.coin()),
    );
    annotate(kb, named, ["linear"]);
    await assert.rejects(
      () => evaluate(kb, S.pair(), { algebra: named }),
      (error: unknown) => {
        assert.ok(error instanceof LinearEvidenceError);
        assert.match(error.message, /linear_evidence_already_spent/);
        return true;
      },
    );
  });

  it("refuses an algebra whose requirements the context has not declared", async () => {
    const kb = fresh();
    kb.add(taggedFact(G(new Amplitude(1n)), S.state(S.up)));
    await assert.rejects(
      () => evaluate(kb, S.state(V.which), { algebra: "amplitude" }),
      (error: unknown) => {
        assert.ok(error instanceof AlgebraRequirementError);
        assert.match(error.message, /amplitude_fragment_refused/);
        return true;
      },
    );
    // Declared, it runs — and the arithmetic stays exact.
    annotate(kb, "amplitude", ["finite", "contractive", "staged"]);
    const { answers } = await evaluate(kb, S.state(V.which), { algebra: "amplitude" });
    assert.equal(answers.length, 1);
    assert.ok((answers[0]?.annotation as Amplitude).equals(new Amplitude(1n)));
  });

  it("reinterprets a retained derivation without asking again", async () => {
    const kb = fresh();
    paths(kb);
    const { answers } = await evaluate(kb, S.path(S.a, S.c), { algebra: tropical });
    const first = answers[0] as NonNullable<(typeof answers)[0]>;
    assert.equal(first.annotation, 3);

    // The SAME derivation, read under another algebra. No second evaluation:
    // `under` walks the tree the first ask already retained.
    const counted = await first.under(counting);
    assert.equal(counted.annotation, 2);
    assert.equal(counted.value, first.value);

    const why = first.why();
    assert.equal(why.algebra, "tropical");
    assert.equal(why.alternatives.length, 2, "two independent derivations");
    assert.match(String(why), /under tropical/);
    assert.match(String(why), /rule /);
  });

  it("records provenance as the shape of the derivation itself", async () => {
    const kb = fresh();
    paths(kb);
    const { answers } = await evaluate(kb, S.path(S.a, S.b), { algebra: prov });
    assert.ok(answers.length > 0);
    assert.match(answers[0]?.tag.text ?? "", /(plus|times|src)/);
  });

  it("draws from the answers by rate, reproducibly", async () => {
    const kb = fresh();
    kb.add(
      taggedFact(S.rate(3), S.side(S.heads)),
      taggedFact(S.rate(1), S.side(S.tails)),
    );
    const drawn = await sample(kb, S.side(V.which), {
      algebra: counting,
      draws: 200,
      seed: 7,
    });
    assert.equal(drawn.length, 200);
    const heads = drawn.filter((atom) => atom.text.includes("heads")).length;
    // Three to one, with room for the draw: the point is the WEIGHTS reach the
    // sampler, not that a finite draw hits its expectation exactly.
    assert.ok(heads > 120 && heads < 180, `${String(heads)} heads of 200`);
    const again = await sample(kb, S.side(V.which), { algebra: counting, draws: 200, seed: 7 });
    assert.deepEqual(again.map(String), drawn.map(String), "the same seed draws the same");
  });

  it("refuses a rate that is not a nonnegative number", () => {
    assert.throws(() => taggedFact(S.rate(-1), S.thing()), /negative_or_nonfinite_rate/);
    assert.throws(() => taggedFact(S.rate(S.plenty), S.thing()), /rate_not_numeric/);
  });

  it("says whether a tagged program could answer at all", async () => {
    const kb = fresh();
    paths(kb);
    assert.ok(await hasTaggedProgram(kb, S.path(V.a, V.b)));
    assert.ok(await hasTaggedProgram(kb, S.edge(S.a, S.b)));
    assert.ok(!(await hasTaggedProgram(kb, S.nothingLikeThis(V.x))));
  });

  it("refuses a rule whose body is not a premise list", async () => {
    const kb = fresh();
    kb.add([S.rule, 1, S.head(), S.notPremises()]);
    await assert.rejects(
      () => evaluate(kb, S.head(), { algebra: counting }),
      /tagged_rule_body_malformed/,
    );
  });

  it("is an ordinary declaration the engine can read back", async () => {
    const algebra = new Algebra("readable", {
      combine: "+",
      extend: "*",
      zero: 0,
      one: 1,
      laws: ["associative"],
      carrier: [0, 1],
    });
    assert.equal(
      algebra.atom.text,
      "(algebra readable + * 0 1 (laws combine-associative extend-associative) (carrier 0 1) (requires))",
    );
  });
});
