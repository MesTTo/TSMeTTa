/**
 * Purpose: the three definition doors, against a live engine: a lowered body,
 *   a traced body, and host code the engine calls.
 * Guarantees:
 *   - a lowered body becomes ONE equation and a call costs no host crossing
 *   - a traced body becomes one equation per emission, each under the goals
 *     asked above it
 *   - a construct with no MeTTa meaning refuses at DEFINITION time, naming
 *     both the construct and the remedy
 *   - a null literal lowers to MeTTa's empty expression rather than a symbol
 *     that only renders the same way [tested: "lowers null to the empty
 *     expression"; commit=191f969429df26e26769391d44234f20af481fff]
 *   - a lowered body mentions atoms through S, V and fn, grounds literals
 *     through G and float, and calls the word door's words, each lowering to
 *     the atom the same spelling builds at run time; array destructuring is a
 *     pattern let and a switch is a case [tested: "a lowered body mentions"]
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
  type Space,
  alphaEqual,
  Expression,
  G,
  If,
  type MeTTa,
  MettaError,
  S,
  Superpose,
  TRUE,
  type Term,
  UNIT,
  V,
  carAtom,
  e,
  float,
  fn,
  hostValue,
  metta,
  neg,
  nil,
  rewrite,
  toAtom,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

/**
 * An ordinary TypeScript function, which is also the definition.
 *
 * This is the whole point of the lowering door: the body is real TypeScript,
 * so it runs in TypeScript, its types check, and `m.define` installs the SAME
 * body in the engine by reading its source. A second definition that calls it
 * names it as an ordinary identifier and gets the head, which is what makes
 * the cross-reference type without anything being asserted.
 */
function findDivisor(n: number, d: number): number {
  if (d * d > n) return n;
  if (n % d === 0) return d;
  return findDivisor(n, d + 1);
}

describe("a lowered body", () => {
  it("becomes one equation, whose arithmetic is the engine's own", async () => {
    const divisor = m.define(findDivisor);
    assert.deepEqual(divisor.equations.map(String), [
      "(= (find-divisor $n $d) (if (> (* $d $d) $n) $n " +
        "(if (== (% $n $d) 0) $d (find-divisor $n (+ $d 1)))))",
    ]);
    assert.equal(String(await divisor(91, 2).one()), "7");
    assert.equal(String(await divisor(97, 2).one()), "97");
    assert.equal(findDivisor(91, 2), 7, "the same body still runs in TypeScript");
  });

  it("lowers null to the empty expression", async () => {
    const nothing = m.define(function nothing(): null {
      return null;
    });
    const equation = nothing.equations[0] as Expression;
    const body = equation.items[2];
    assert.ok(body instanceof Expression);
    assert.deepEqual(body.items, []);

    const answer = await nothing().one();
    assert.ok(answer instanceof Expression);
    assert.deepEqual(answer.items, []);
  });

  it("installs the head TypeScript's own casing images to", () => {
    const balanceOf = m.define(function balanceOf(account: number): number {
      return account;
    });
    assert.equal(balanceOf.head, "balance-of");
  });

  it("takes an exact head when the casing map cannot say it", async () => {
    // `findDivisor` here is the plain function above, already defined into the
    // engine by the first case. The lowering resolves the identifier to the
    // head the engine knows, so the cross-reference needs no scope entry and
    // no assertion: it is an ordinary typed call in ordinary TypeScript.
    const isPrime = m.define(
      function isPrime(n: number): boolean {
        return n === findDivisor(n, 2);
      },
      { name: "prime?" },
    );
    assert.equal(isPrime.head, "prime?");
    assert.equal(String(await isPrime(53537257).one()), "true");
    assert.equal(String(await isPrime(91).one()), "false");
  });

  it("costs no host crossing per call, because the whole body is in the engine", async () => {
    const countdown = m.define(function countdown(n: number): number {
      return n === 0 ? 0 : countdown(n - 1);
    });
    const before = m.counters.crossings;
    assert.equal(String(await countdown(200).one()), "0");
    // One job: start, the pulls it takes to reach the answer and its end. What
    // matters is that it does not grow with the 200 steps of the recursion.
    assert.ok(m.counters.crossings - before < 10, "the body left the engine per step");
  });

  it("lowers a const into a let", () => {
    const areaOf = m.define(function areaOf(w: number, h: number): number {
      const half = w * h;
      return half + half;
    });
    assert.deepEqual(areaOf.equations.map(String), [
      "(= (area-of $w $h) (let $half (* $w $h) (+ $half $half)))",
    ]);
  });

  it("lowers a run of consts into a let*, each seeing the ones before it", async () => {
    const hypotenuse = m.define(function hypotenuse(a: number, b: number): number {
      const aa = a * a;
      const bb = b * b;
      const cc = aa + bb;
      return cc;
    });
    assert.deepEqual(hypotenuse.equations.map(String), [
      "(= (hypotenuse $a $b) (let* (($aa (* $a $a)) ($bb (* $b $b)) ($cc (+ $aa $bb))) $cc))",
    ]);
    assert.equal(String(await hypotenuse(3, 4).one()), "25");
  });

  it("lowers a conditional expression and the logical operators", () => {
    const pick = m.define(function pick(a: number, b: number): number {
      return a > b && a > 0 ? a : b;
    });
    assert.deepEqual(pick.equations.map(String), [
      "(= (pick $a $b) (if (and (> $a $b) (> $a 0)) $a $b))",
    ]);
  });

  it("refuses a construct with no MeTTa meaning, naming it and the remedy", () => {
    assert.throws(
      () =>
        m.define(function looping(n: number): number {
          for (let i = 0; i < n; i += 1) n += 1;
          return n;
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_LOWER" && /ForStatement/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function reading(x: { a: number }): number {
          return x.a;
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /reads a property/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(async function waiting(x: number): Promise<number> {
          return await Promise.resolve(x);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /awaits/.test(error.message),
    );
  });

  it("refuses a free name nothing defines, naming the three ways to supply it", () => {
    assert.throws(
      () =>
        m.define(function reaching(n: number): number {
          return somethingUndeclared(n) as number;
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_LOWER" &&
        /somethingUndeclared/.test(error.message) &&
        /scope/.test(error.message),
    );
  });

  it("does not resolve inherited names from an explicit lowering scope", () => {
    assert.throws(
      () =>
        m.define(
          function inheritedScopeName(n: number): unknown {
            return toString(n);
          },
          { scope: {} },
        ),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /toString/.test(error.message),
    );
  });

  it("refuses a body with no name at all, naming both ways to give it one", () => {
    assert.throws(
      () => m.define((n: number): number => n),
      (error: MettaError) => error.code === "ERR_METTA_NAME",
    );
  });
});

describe("a lowered body mentions", () => {
  it("atoms through S, V and fn, as the same spellings build them", async () => {
    const testFunc = m.define(function testFunc(): Term {
      return S.result;
    });
    assert.deepEqual(testFunc.equations, [rewrite(S.testFunc(), S.result)]);
    assert.deepEqual(await testFunc(), [S.result.atom]);

    const pairOf = m.define(function pairOf(a: number, b: number): Term {
      return S.pair(a, S["car-atom"].atom, S("isPrime"), V.free, fn.add(a, b));
    });
    assert.deepEqual(pairOf.equations, [
      rewrite(S.pairOf(V.a, V.b), S.pair(V.a, S.carAtom, S("isPrime"), V.free, S["+"](V.a, V.b))),
    ]);
    // The engine renames an answer's free variable, so the answer is compared
    // up to that renaming.
    assert.ok(alphaEqual(await pairOf(1, 2).one(), S.pair(1, S.carAtom, S("isPrime"), V.free, 3)));
  });

  it("grounds literals through G and float, and refuses a host value", async () => {
    const texts = m.define(function texts(): Term {
      return e(G("a (b) c"), float(2), G(-3), G(true), G(7n));
    });
    assert.deepEqual(texts.equations, [rewrite(S.texts(), e("a (b) c", float(2), -3, true, 7n))]);
    // A safe integer comes back as a number, whichever host type wrote it.
    assert.deepEqual(await texts(), [e("a (b) c", float(2), -3, true, 7)]);
    assert.throws(
      () =>
        m.define(function hosting(x: number): Term {
          return G(x);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /not a literal/.test(error.message),
    );
  });

  it("the word door's words and constants, after the engine's own heads", async () => {
    const worded = m.define(function worded(x: number): Term {
      return If(x > 0, Collapse(Superpose([x, neg(x)])), e(TRUE, UNIT, nil(), carAtom([x, 2]), Empty()));
    });
    assert.deepEqual(worded.equations, [
      rewrite(
        S.worded(V.x),
        S.if(S[">"](V.x, 0), S.collapse(S.superpose(e(V.x, S["-"](0, V.x)))), e(TRUE, UNIT, nil(), S.carAtom(e(V.x, 2)), S.empty())),
      ),
    ]);
    assert.deepEqual(await worded(3), [e(3, -3)]);
  });

  it("a local binding of a factory's name, which shadows it", async () => {
    const shadowed = m.define(function shadowed(S: number): number {
      return S + 1;
    });
    assert.deepEqual(await shadowed(41), [toAtom(42)]);
  });

  it("an array pattern as MeTTa's pattern let", async () => {
    const swapped = m.define(function swapped(pair: Term): Term {
      const [first, [second, third]] = pair as [Term, [Term, Term]];
      return [third, second, first];
    });
    assert.deepEqual(swapped.equations, [
      rewrite(S.swapped(V.pair), S.let(e(V.first, e(V.second, V.third)), V.pair, e(V.third, V.second, V.first))),
    ]);
    assert.deepEqual(await swapped(e(1, e(2, 3))), [e(3, 2, 1)]);
  });

  it("a switch as a case, with shared labels, a late default and a break", async () => {
    const sized = m.define(function sized(n: number): Term {
      switch (n) {
        default:
          return S.many;
        case 0:
          return S.none;
        case 1:
        case 2:
          return S.few;
        case 3:
          break;
      }
      return S.three;
    });
    assert.deepEqual(
      await Promise.all([0, 1, 2, 3, 9].map(async (n) => (await sized(n).one()).text)),
      ["none", "few", "few", "three", "many"],
    );
    // With no default and nothing after the switch, an unmatched subject runs
    // off the end, which answers the unit as a TypeScript function does.
    const open = m.define(function open(n: number): Term {
      switch (n) {
        case 0:
          return S.zero;
      }
      return;
    });
    assert.deepEqual(await open(7), [UNIT]);
  });

  it("this as the space the definition lives in, and that space's own methods", async () => {
    const kb = m.space(S.lowerKb);
    kb.add(S.item(1), S.item(2));
    const stamp = m.define(function stamp(this: Space, n: number): Term {
      fn.addAtom(this, S.stamped(n));
      return this.match(S.item(V.found), S.seen(V.found));
    }, { space: kb });
    assert.equal(stamp.equations.length, 1);
    assert.ok(alphaEqual(
      stamp.equations[0]!,
      rewrite(S.stamp(V.n), S.chain(S.addAtom(kb, S.stamped(V.n)), V.effect, S.match(kb, S.item(V.found), S.seen(V.found)))),
    ));
    assert.deepEqual(await stamp(7), [S.seen(1), S.seen(2)]);
    assert.ok(kb.has(S.stamped(7)), "the statement's write landed");

    const other = m.space(S.lowerOther);
    other.add(S.token(1));
    const listed = m.define(function listed(): Term {
      return other.atoms();
    }, { scope: { other } });
    assert.deepEqual(await listed(), [S.token(1)]);
    // A host door wider than any one head is not read back in a body: delete
    // of an unbound term drains, where subtract-atom refuses one.
    for (const wrong of [
      function wrongArity(): Term { return other.match(S.token(V.n)); },
      function wrongDoor(): Term { return other.delete(S.token(1)); },
    ]) {
      assert.throws(
        () => m.define(wrong, { scope: { other } }),
        (error: MettaError) => error.code === "ERR_METTA_LOWER" && /fn\.subtractAtom/.test(error.message),
      );
    }
  });
});

declare function somethingUndeclared(n: number): unknown;
declare function toString(n: number): unknown;

describe("a traced body", () => {
  it("becomes a nest of goals, which is what a conjunction is in MeTTa", async () => {
    m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann), S.parent(S.ann, S.eve));
    const grandparent = m.define(function* grandparent(x: Term) {
      const { y } = yield* m.match(S.parent(x, V.y));
      const { z } = yield* m.match(S.parent(y, V.z));
      return z;
    });
    assert.deepEqual(grandparent.equations.map(String), [
      "(= (grandparent $x) (match &self (parent $x $y) (match &self (parent $y $z) $z)))",
    ]);
    assert.deepEqual((await grandparent(S.tom)).map(String), ["ann"]);
  });

  it("becomes one clause per emission, each under the goals asked above it", async () => {
    const descendants = m.define(function* descendants(x: Term) {
      const { c } = yield* m.match(S.parent(x, V.c));
      yield c;
      yield S.descendants(c);
    });
    assert.deepEqual(descendants.equations.map(String), [
      "(= (descendants $x) (match &self (parent $x $c) $c))",
      "(= (descendants $x) (match &self (parent $x $c) (descendants $c)))",
    ]);
    assert.deepEqual((await descendants(S.tom)).map(String), ["bob", "ann", "eve"]);
    assert.equal(await descendants(S.eve).find(), undefined);
  });

  it("binds a reduction with a let", async () => {
    m.run("(= (double $n) (* $n 2))");
    const quadruple = m.define(function* quadruple(n: Term) {
      const doubled = yield* m.eval(S.double(n));
      return S.double(doubled);
    });
    assert.match(String(quadruple.equations[0]), /^\(= \(quadruple \$n\) \(let \$ask/);
    assert.equal(String(await quadruple(5).one()), "20");
  });

  it("refuses a branch on a symbolic binding, naming both remedies", () => {
    assert.throws(
      () =>
        m.define(function* branching(x: Term) {
          const { y } = yield* m.match(S.parent(x, V.y));
          if ((y as unknown as number) > 0) yield y;
          yield S.done;
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_TRACE" &&
        /If\(gt/.test(error.message) &&
        /own source is lowered/.test(error.message),
    );
  });

  it("refuses a goal that has no MeTTa spelling", () => {
    assert.throws(
      () =>
        m.define(function* filtered(x: Term) {
          const row = yield* m.match(S.parent(x, V.y)).filter(() => true);
          yield row;
        }),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /no MeTTa spelling/.test(error.message),
    );
  });

  it("refuses a body that emits nothing", () => {
    assert.throws(
      () =>
        m.define(function* silent(x: Term) {
          yield* m.match(S.parent(x, V.y));
        }),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /emits nothing/.test(error.message),
    );
  });
});

describe("a host operation", () => {
  it("dispatches the currently registered arity at a shared name", async () => {
    const first = m.op(function pickByArity(_value: number): string {
      return "one";
    }, { name: "pick-by-arity", effect: "pureStructural" });
    const second = m.op(function pickByArity(_left: number, _right: number): string {
      return "two";
    }, { name: "pick-by-arity", effect: "pureStructural" });

    assert.equal(String(await second(1, 2).one()), '"two"');
    first.forget();
    assert.equal(String(await second(1, 2).one()), '"two"', "a stale handle removed its replacement");
  });

  it("answers once, and its arguments are ordinary host values", async () => {
    const doubled = m.op(function doubled(n: number): number {
      assert.equal(typeof n, "number", "an op received something other than a number");
      return n * 2;
    }, { effect: "pureStructural" });
    assert.equal(String(await doubled(21).one()), "42");
  });

  it("is nondeterminism from JavaScript when it is a generator", async () => {
    m.op(function* upto(n: number) {
      for (let i = 1; i <= n; i += 1) yield i;
    }, { effect: "pureStructural" });
    assert.equal(String(await m.eval(Collapse(S.upto(4))).one()), "(1 2 3 4)");
  });

  it("pulls a generator lazily, so an unbounded one is usable", async () => {
    let produced = 0;
    m.op(function* forever() {
      for (let i = 1; ; i += 1) {
        produced += 1;
        yield i;
      }
    }, { effect: "pureStructural" });
    const seen: string[] = [];
    for await (const answer of m.eval(S.forever())) {
      seen.push(String(answer));
      if (seen.length === 3) break;
    }
    assert.deepEqual(seen, ["1", "2", "3"]);
    assert.ok(produced < 10, `the host produced ${String(produced)} answers for three asks`);
  });

  it("answers as long as it likes, and the pump does not grow with it", async () => {
    // Both halves were recursive once and both died: the Prolog pull left one
    // frame and one choice point per answer, and the JavaScript settle
    // recursed per synchronous reply. Twenty thousand answers found the first
    // at about eight thousand [measured 2026-08-27]; both are loops now.
    m.op(function* countTo(n: number) {
      for (let i = 0; i < n; i += 1) yield i;
    }, { effect: "pureStructural" });
    const collapsed = String(await m.eval(Collapse(S["count-to"](20000))).one());
    assert.equal(collapsed.split(" ").length, 20000);
  });

  it("collapses into one expression with more children than a spread can carry", async () => {
    // `expr(...array)` makes an ARGUMENT per child and raises
    // `Maximum call stack size exceeded` past about sixty thousand, which a
    // collapse over a long generator reaches at once.
    m.op(function* countUp(n: number) {
      for (let i = 0; i < n; i += 1) yield i;
    }, { effect: "pureStructural" });
    const answer = await m.eval(Collapse(S["count-up"](120000))).one();
    assert.ok(answer instanceof Expression);
    assert.equal(answer.items.length, 120000);
  });

  it("is awaited when it answers with a promise", async () => {
    const later = m.op(async function later(n: number): Promise<number> {
      await new Promise((resume) => setTimeout(resume, 3));
      return n * 10;
    });
    assert.equal(String(await later(4).one()), "40");
  });

  it("refuses an async body on the synchronous door, by name", () => {
    m.op(async function slowThing(): Promise<number> {
      await new Promise((resume) => setTimeout(resume, 1));
      return 1;
    });
    assert.throws(
      () => m.runOne(S["slow-thing"]()),
      (error: MettaError) =>
        error.code === "ERR_METTA_UNSUPPORTED" && /awaiting form/.test(error.message),
    );
  });

  it("turns a rejection into the engine's own error", async () => {
    m.op(function angry(): number {
      throw new Error("no");
    });
    await assert.rejects(() => m.eval(S.angry()).one(), /the host operation raised: no/);
  });

  it("hands a raw body the atoms, unevaluated structure and all", async () => {
    const shapeOf = m.op(function shapeOf(atom: Term): string {
      return String(atom);
    }, { raw: true, effect: "pureStructural" });
    assert.equal(String(await shapeOf(S.some(S.nested(1))).one()), '"(some (nested 1))"');
  });

  it("carries a live host value in and answers the very same object", async () => {
    const held = { hello: "world" };
    const identity = m.op(function identity(value: unknown): unknown {
      return value;
    }, { effect: "pureStructural" });
    const back = await identity(held).one();
    assert.equal(hostValue(back), held, "the object did not come home");
  });

  it("declares an effect class the catalog holds, and defaults to the fail-closed one", () => {
    m.op(function unstated(): number {
      return 1;
    });
    assert.equal(m.effectOf("unstated"), "oracleIO", "an unstated effect must fail closed");
  });
});

describe("the call door", () => {
  it("asks, while a mention builds", async () => {
    const twice = m.define(function twice(n: number): number {
      return n * 2;
    });
    assert.equal(String(twice.atom), "twice");
    assert.equal(String(S.twice(21)), "(twice 21)", "a mention runs nothing");
    assert.equal(String(await twice(21).one()), "42");
  });

  it("forgets a definition when asked", async () => {
    const gone = m.define(function gone(n: number): number {
      return n;
    });
    assert.equal(String(await gone(1).one()), "1");
    gone.forget();
    assert.deepEqual((await m.eval(S.gone(1))).map(String), ["(gone 1)"], "it still reduces");
  });
});

describe("memoization", () => {
  it("is a library declaration, not a door of its own", async () => {
    // `m.cache` used to be this, adding `(memoize fib)` for you while its own
    // comment claimed it meant tabling. It was a host verb for ONE library, so
    // it is gone on this seat as it is on Python's, and the library form is
    // what both write.
    m.run("!(import! &self (library lib_memo))");
    const fib = m.define(function fib(n: number): number {
      return n < 2 ? n : fib(n - 1) + fib(n - 2);
    });
    m.add(S.memoize(S.fib));
    assert.equal(String(await fib(20).one()), "6765");
    const declared = await m.match(S.memoize(V.head));
    assert.ok(declared.some((row) => String(row["head"]) === "fib"));
  });
});

describe("superpose from the host", () => {
  it("builds the engine's own nondeterminism", async () => {
    assert.deepEqual((await m.eval(Superpose([1, 2, 3]))).map(String), ["1", "2", "3"]);
  });
});
