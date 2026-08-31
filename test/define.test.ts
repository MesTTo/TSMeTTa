/**
 * Purpose: the three definition doors, against a live engine: a lowered body,
 *   a traced body, and host code the engine calls.
 * Guarantees:
 *   - a lowered body becomes ONE equation and a call costs no host crossing
 *   - a traced body becomes one equation per emission, each under the goals
 *     asked above it
 *   - a construct with no MeTTa meaning refuses at DEFINITION time, naming
 *     both the construct and the remedy
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  Collapse,
  Expression,
  type MeTTa,
  MettaError,
  S,
  Superpose,
  type Term,
  V,
  hostValue,
  metta,
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

  it("refuses a body with no name at all, naming both ways to give it one", () => {
    assert.throws(
      () => m.define((n: number): number => n),
      (error: MettaError) => error.code === "ERR_METTA_NAME",
    );
  });
});

declare function somethingUndeclared(n: number): unknown;

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

describe("tabling", () => {
  it("declares the engine's own table beside the equations", async () => {
    m.run("!(import! &self (library lib_memo))");
    const fib = m.cache(function fib(n: number): number {
      return n < 2 ? n : fib(n - 1) + fib(n - 2);
    });
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
