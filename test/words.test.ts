/**
 * Purpose: hold every word this door names to the engine that has to answer
 *   it, so a head that moves is caught here and not in a program.
 * Guarantees:
 *   - every operator word, every control form and the case tower reduce to
 *     what they claim, against the live engine
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  Collapse,
  Empty,
  G,
  If,
  Let,
  LetStar,
  Match,
  type MeTTa,
  Quote,
  S,
  Superpose,
  type Term,
  V,
  abs,
  add,
  and,
  arrow,
  carAtom,
  caseOf,
  cdrAtom,
  ceil,
  consAtom,
  div,
  eq,
  floor,
  fn,
  getType,
  gt,
  gte,
  lt,
  lte,
  maxAtom,
  metta,
  minAtom,
  mod,
  mul,
  ne,
  neg,
  not,
  or,
  pow,
  sqrt,
  sub,
  typed,
  unify,
  xor,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

/** What the engine answers for a built term, as its own text. */
const answer = async (term: Term): Promise<string> => String(await m.eval(term).one());

describe("comparison words", () => {
  it("reduce to what they claim", async () => {
    assert.equal(await answer(eq(1, 1)), "true");
    assert.equal(await answer(ne(1, 2)), "true");
    assert.equal(await answer(lt(1, 2)), "true");
    assert.equal(await answer(lte(2, 2)), "true");
    assert.equal(await answer(gt(2, 1)), "true");
    assert.equal(await answer(gte(2, 2)), "true");
  });

  it("are the ecosystem's own roster, not the Python operator module's", () => {
    // `gte` is what Drizzle, Prisma, Mongo, Sequelize and lodash all say; the
    // Python side's `ge` would be a transliteration of a different host.
    assert.equal(String(gte(1, 2)), "(>= 1 2)");
    assert.equal(String(lte(1, 2)), "(<= 1 2)");
  });
});

describe("arithmetic words", () => {
  it("reduce to what they claim", async () => {
    assert.equal(await answer(add(1, 2)), "3");
    assert.equal(await answer(sub(5, 2)), "3");
    assert.equal(await answer(mul(3, 4)), "12");
    assert.equal(await answer(div(6, 3)), "2");
    assert.equal(await answer(mod(7, 3)), "1");
    // An integer base raised to an integer power keeps its kind, which is
    // upstream's answer too [measured 2026-08-30 against PeTTa@ae66fa8:
    // `!(pow-math 2 8)` is `256` on both engines].
    assert.equal(await answer(pow(2, 8)), "256");
    assert.equal(await answer(abs(-3)), "3");
    assert.equal(await answer(sqrt(9.0)), "3.0");
    assert.equal(await answer(floor(3.7)), "3");
    assert.equal(await answer(ceil(3.2)), "4");
  });

  it("negate by subtracting from zero, which is the composite MeTTa has", async () => {
    assert.equal(String(neg(5)), "(- 0 5)");
    assert.equal(await answer(neg(5)), "-5");
  });

  it("fold an expression of numbers", async () => {
    assert.equal(await answer(minAtom([3, 1, 2])), "1");
    assert.equal(await answer(maxAtom([3, 1, 2])), "3");
  });
});

describe("logic words", () => {
  it("reduce to what they claim", async () => {
    assert.equal(await answer(and(true, false)), "false");
    assert.equal(await answer(or(true, false)), "true");
    assert.equal(await answer(not(true)), "false");
    assert.equal(await answer(xor(true, false)), "true");
  });
});

describe("structure words", () => {
  it("take an expression apart and put it back together", async () => {
    assert.equal(await answer(carAtom([1, 2, 3])), "1");
    assert.equal(await answer(cdrAtom([1, 2, 3])), "(2 3)");
    assert.equal(await answer(consAtom(1, [2, 3])), "(1 2 3)");
  });

  it("ask a term its type", async () => {
    assert.equal(await answer(getType(1)), "Number");
  });

  it("build a type claim and an arrow as VALUES", () => {
    assert.equal(String(typed(S.f, S.Number)), "(: f Number)");
    assert.equal(String(arrow(S.Symbol, S.Number)), "(-> Symbol Number)");
    assert.throws(() => arrow(S.Number), /at least an argument and a result/);
  });
});

describe("control forms", () => {
  it("reduce to what they claim", async () => {
    assert.equal(await answer(If(gt(2, 1), S.yes, S.no)), "yes");
    assert.equal(await answer(Let(V.x, 1, add(V.x, 1))), "2");
    assert.equal(await answer(LetStar([[V.x, 1], [V.y, 2]], add(V.x, V.y))), "3");
    assert.equal(await answer(Collapse(Superpose([1, 2]))), "(1 2)");
    // quote ANSWERS its operand rather than a wrapper, which is upstream's
    // own lowering, `Out = Expr`
    // [source: PeTTa@ae66fa8 src/translator.pl:320-322].
    assert.equal(await answer(Quote(S.f(1))), "(f 1)");
    assert.deepEqual(await m.eval(Empty()), []);
  });

  it("query a space by term", async () => {
    const kb = m.space("&words");
    kb.add(S.parent(S.tom, S.bob));
    assert.equal(await answer(Match(kb.handle, S.parent(V.x, S.bob), V.x)), "tom");
  });

  it("unify at arity two and at arity four", async () => {
    // Arity two is the HOST matcher: a substitution, and no engine at all.
    assert.deepEqual(unify(S.f(1), S.f(V.x)), { x: G(1) });
    assert.equal(unify(S.f(1), S.g(1)), undefined);
    // Arity four is the engine's own conditional form.
    assert.equal(await answer(unify(S.f(1), S.f(V.x), V.x, S.nope)), "1");
    assert.equal(await answer(unify(S.f(1), S.g(2), S.yes, S.no)), "no");
  });
});

describe("the case tower", () => {
  it("builds the engine's own case term, and it answers", async () => {
    const tower = caseOf(2)
      .with(1, () => S.one)
      .with(2, () => S.two)
      .otherwise(() => S.other);
    assert.equal(String(tower), "(case 2 ((1 one) (2 two) ($_ other)))");
    assert.equal(await answer(tower), "two");
  });

  it("hands an arm's body the variables its own pattern binds", async () => {
    const kb = m.space("&case");
    kb.add(S.pair(S.left, S.right));
    const tower = caseOf(S.pair(S.left, S.right))
      .with(S.pair(V.a, V.b), ({ a }) => a)
      .otherwise(() => S.none);
    assert.equal(String(tower), "(case (pair left right) (((pair $a $b) $a) ($_ none)))");
    assert.equal(await answer(tower), "left");
  });

  it("answers nothing for a subject no arm matches, with no catch-all", async () => {
    const tower = caseOf(9).with(1, () => S.one).end();
    assert.deepEqual(await m.eval(tower), []);
  });
});

describe("the word door and the free functions are one mechanism", () => {
  it("name one head, by construction rather than by agreement", () => {
    assert.equal(String(fn.gte(1, 2)), String(gte(1, 2)));
    assert.equal(String(fn.add(1, 2)), String(add(1, 2)));
    assert.equal(String(fn.mod(7, 3)), String(mod(7, 3)));
    assert.equal(String(fn.pow(2, 3)), String(pow(2, 3)));
  });
});
