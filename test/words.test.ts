/**
 * Purpose: hold every word this door names to the engine that has to answer
 *   it, so a head that moves is caught here and not in a program.
 * Guarantees:
 *   - every operator word, every control form and the case tower reduce to
 *     what they claim, against the live engine
 *   - every word naming one head is that head in term position, checked for
 *     each entry of OPERATOR_HEADS and WORD_HEADS rather than a list here
 *   - the verdict words build what a pre-add judge answers, and each acts as
 *     its verdict against the live engine in a program that imports
 *     lib_functional, whose two-input drop made a lowercase (drop) a call
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  Accept,
  Atom,
  Collapse,
  Drop,
  Empty,
  Expression,
  FloatAtom,
  G,
  Grounded,
  If,
  Let,
  LetStar,
  Match,
  type MeTTa,
  NameError,
  Quote,
  Rational,
  RationalAtom,
  Refuse,
  S,
  Space,
  SpaceHandle,
  Superpose,
  Sym,
  TRUE,
  type Term,
  V,
  Var,
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
  float,
  floor,
  fn,
  getType,
  gt,
  gte,
  isError,
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
  rewrite,
  sqrt,
  sub,
  typeAtom,
  typed,
  unify,
  xor,
} from "../src/index.ts";
import * as words from "../src/words.ts";
import { OPERATOR_HEADS, WORD_HEADS } from "../src/words.ts";
import { sym, toAtom } from "../src/atom.ts";

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

  it("build a type claim and an arrow as VALUES", async () => {
    assert.equal(String(typed(S.f, S.Number)), "(: f Number)");
    assert.equal(String(arrow(S.Symbol, S.Number)), "(-> Symbol Number)");
    // A nullary operation's type is its result alone, as the engine declares
    // current-time's.
    assert.equal(String(arrow(S.Number)), "(-> Number)");
    assert.deepEqual(await m.fn.getType(fn.currentTime), [arrow(Number)]);
  });
});

describe("a type position", () => {
  it("names, for a host type, the type the engine admits all its values at", async () => {
    // The engine is the oracle twice: it types the first value exactly as the
    // constructor names, and a head declared with the constructor admits every
    // value and refuses a foreign one. BigInt names Number, PyMeTTa's row for
    // Python's unbounded int, because the engine types an integer outside
    // signed i64 BigInt and widens BigInt to Number [source:
    // engine/metta/types.pl metta_numeric_type/2, engine/type_rules.pl
    // typing-bigint-widens-to-number; extensions/python/metta/_catalog/
    // annotations.py, (int, "Number")].
    const kb = m.space();
    for (const [host, values, foreign] of [
      [Number, [7, 0.5], "text"],
      [BigInt, [5n, 2n ** 70n], "text"],
      [String, ["text"], 7],
      [Boolean, [true, false], 7],
      [FloatAtom, [float(1.5)], "text"],
      [RationalAtom, [G(new Rational(1n, 3n))], "text"],
      [SpaceHandle, [kb.handle], 7],
      [Space, [kb], 7],
    ] as const) {
      const takes = S[`takes-${host.name}`];
      m.add(typed(takes, arrow(host, S.Bool)), rewrite(takes(V.x), TRUE));
      assert.deepEqual(await m.eval(getType(values[0])), [typeAtom(host)], host.name);
      for (const value of values) {
        assert.deepEqual(await m.eval(takes(value)), [TRUE], `${host.name} admits ${String(value)}`);
      }
      const [refused] = await m.eval(takes(foreign));
      assert.ok(isError(refused), `${host.name} refuses ${String(foreign)}`);
    }
  });

  it("names, for an atom class, the metatype the engine gives its atoms", async () => {
    for (const [atomClass, atom] of [
      [Sym, S.a],
      [Var, V.x],
      [Expression, S.f(1)],
      [Grounded, G(1)],
    ] as const) {
      assert.deepEqual([typeAtom(atomClass)], await m.fn.getMetatype(atom), atomClass.name);
    }
    // Atom is every metatype at once, and object and a list are PyMeTTa's
    // any-atom and sequence rows [source: extensions/python/metta/_catalog/
    // annotations.py, _direct_type_atoms and _generic_type_atoms].
    assert.equal(typeAtom(Atom), S.Atom.atom);
    assert.equal(typeAtom(Object), S.Atom.atom);
    assert.equal(typeAtom(Array), S.Expression.atom);
  });

  it("reads a term as itself, an array as an expression type, and a class by its name", () => {
    assert.equal(typeAtom(S.Number), S.Number.atom);
    assert.equal(String(typeAtom([S.List, Number])), "(List Number)");
    assert.equal(String(arrow(Number, Number, Boolean)), "(-> Number Number Bool)");
    class Dog {}
    assert.equal(String(typed(S.rex, Dog)), "(: rex Dog)");
    // A subclass names what its base declares, as PyMeTTa's handle rule
    // answers SpaceType for a user subclass of its space handle.
    class Tracked extends Space {}
    assert.equal(typeAtom(Tracked), S.SpaceType.atom);
    // A subclass of a built-in is a wrapper object, not the primitive the
    // built-in names, so it names itself.
    class Count extends Number {}
    assert.equal(typeAtom(Count), S.Count.atom);
  });

  it("refuses a function that names no type, where it once became a host value", () => {
    assert.throws(() => typeAtom(() => 1), NameError);
    assert.throws(() => arrow(Number, Math.max), /Math.max|max in a type position names no type/);
  });

  it("types a definition from host constructors, which the engine then enforces", async () => {
    const twiceTyped = m.define(
      function twiceTyped(x: number): number {
        return 2 * x;
      },
      { type: arrow(Number, Number) },
    );
    assert.deepEqual(await m.fn.getType(S.twiceTyped), [arrow(S.Number, S.Number)]);
    assert.deepEqual(await twiceTyped(21), [G(42)]);
    const [refused] = await m.eval(S.twiceTyped("a"));
    assert.ok(refused instanceof Expression && refused.items[0] === S.Error.atom);
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

  it("stand for the head they name wherever a term goes", async () => {
    // Every word of both tables, read off the module rather than listed here.
    for (const [word, head] of Object.entries({ ...OPERATOR_HEADS, ...WORD_HEADS })) {
      assert.equal(toAtom(words[word as keyof typeof words] as Term), sym(head), word);
    }
    assert.equal(toAtom(add), toAtom(fn.add));
    assert.deepEqual(await m.fn.getMetatype(add), [S.Grounded.atom]);
    assert.equal(String(typed(S.plus, add)), "(: plus +)");
    // A call is not a word: what a defined function answers is an ask, and an
    // ask refuses where a term goes.
    assert.throws(() => S.f(m.eval(S.x)), NameError);
  });
});

describe("verdict words", () => {
  it("are the verdicts a pre-add judge answers, beside a library defining drop", async () => {
    // An engine of its own, because the program imports lib_functional into
    // &self, and its two-input drop is the head a lowercase verdict became a
    // call to.
    const own = await metta();
    try {
      own.run(
        "!(import! &self (library lib_functional))\n" +
          `(= (words-judge (keep $x)) ${String(Accept())})\n` +
          `(= (words-judge (swap $x)) ${String(Accept(S.swapped(V.x)))})\n` +
          `(= (words-judge (bad $x)) ${String(Refuse(S.forbidden))})\n` +
          `(= (words-judge (skip $x)) ${String(Drop())})\n` +
          "!(declare-pre-add! &words-pool words-judge)",
      );
      const pool = own.space("&words-pool");
      pool.add(S.keep(1));
      pool.add(S.swap(2));
      assert.throws(() => pool.add(S.bad(3)), /forbidden/);
      pool.add(S.skip(4));
      assert.deepEqual((await pool.atoms()).map(String).sort(), ["(keep 1)", "(swapped 2)"]);
    } finally {
      own.dispose();
    }
  });
});
