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
  type Atom,
  Collapse,
  Empty,
  type Space,
  _,
  add,
  and,
  caseOf,
  alphaEqual,
  CastError,
  EngineError,
  Expression,
  G,
  If,
  type MeTTa,
  MettaError,
  NameError,
  Random,
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
  or,
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

/** Installed under an exact head, `even?`, and called by this name. */
function isEven(n: number): boolean {
  return n % 2 === 0;
}

/**
 * How many doubles lie between two numbers: 0 for one number, 0 and -0 being
 * one, and NaN being one with itself.
 *
 * Within one sign doubles order as their bit patterns do, so mapping each
 * pattern onto one signed line makes the distance a subtraction.
 */
function ulpsApart(left: number, right: number): number {
  if (left === right || (Number.isNaN(left) && Number.isNaN(right))) return 0;
  const [a, b] = new BigInt64Array(new Float64Array([left, right]).buffer) as unknown as [bigint, bigint];
  const line = (bits: bigint): bigint => (bits < 0n ? -(bits & 0x7fff_ffff_ffff_ffffn) : bits);
  const distance = line(a) - line(b);
  return Number(distance < 0n ? -distance : distance);
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

  it("reaches a definition installed under an exact head by its function's own name", async () => {
    m.define(isEven, { name: "even?" });
    const evens = m.define(function evens(a: number, b: number): number {
      return (isEven(a) ? 1 : 0) + (isEven(b) ? 1 : 0);
    });
    assert.match(String(evens.equations[0]), /\(even\? \$a\)/);
    assert.equal(String(await evens(2, 3).one()), "1");
    assert.equal(m.disassemble("isEven"), m.disassemble("even?"), "the surface reads a name the way a body does");
  });

  it("refuses a name two definitions were written with, rather than guessing", () => {
    m.define(
      function doubled(n: number): number {
        return n * 2;
      },
      { name: "doubled-a" },
    );
    m.define(
      function doubled(n: number): number {
        return n + n;
      },
      { name: "doubled-b" },
    );
    assert.throws(
      () =>
        m.define(function usesDoubled(n: number): number {
          return doubled(n);
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_LOWER" && /doubled-a, doubled-b/.test(error.message) && /scope/.test(error.message),
    );
    assert.throws(() => m.disassemble("doubled"), NameError);
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

  it("walks an expression with an array's own map, filter and reduce", async () => {
    function walkSum(a: number, b: number): number {
      return a + b;
    }
    m.define(walkSum);
    const walks = m.define(function walks(): Term {
      return [
        [1, 2, 3, 4].reduce((acc, x) => acc + x, 0),
        [1, 2, 3].map((x) => x + 1),
        [1, 2, 3, 4, 5].filter((x) => x > 3),
        [1, 2, 3, 4].reduce(walkSum, 0),
      ];
    });
    assert.equal(
      String(walks.equations[0]),
      "(= (walks) ((foldl-atom (1 2 3 4) 0 $acc $x (+ $acc $x)) (map-atom (1 2 3) $x (+ $x 1)) " +
        "(filter-atom (1 2 3 4 5) $x (> $x 3)) (foldl-atom (1 2 3 4) 0 walk-sum)))",
    );
    assert.equal(String(await walks().one()), "(10 (2 3 4) (4 5) 10)");
    assert.throws(
      () =>
        m.define(function noInitialValue(): number {
          return [1, 2].reduce((a, b) => a + b);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /initial value/.test(error.message),
    );
  });

  it("lowers the bitwise operators onto the bit- family, over unbounded integers", async () => {
    const bits = m.define(function bits(a: bigint, b: bigint): Term {
      return [a & b, a | b, a ^ b, ~a, a << 62n, a >> 1n];
    });
    assert.equal(
      String(bits.equations[0]),
      "(= (bits $a $b) ((bit-and $a $b) (bit-or $a $b) (bit-xor $a $b) (bit-not $a) (bit-shift-left $a 62) (bit-shift-right $a 1)))",
    );
    // 12 << 62 in 32-bit JavaScript numbers would wrap; the engine's integer does not.
    assert.equal(String(await bits(12n, 10n).one()), "(8 14 6 -13 55340232221128654848 6)");
    assert.throws(
      () =>
        m.define(function unsignedShift(a: number): number {
          return a >>> 1;
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /unbounded/.test(error.message),
    );
  });

  it("lowers a conditional expression and the logical operators", () => {
    const pick = m.define(function pick(a: number, b: number): number {
      return a > b && a > 0 ? a : b;
    });
    assert.deepEqual(pick.equations.map(String), [
      "(= (pick $a $b) (if (and-then (> $a $b) (> $a 0)) $a $b))",
    ]);
  });

  it("short-circuits && and || as TypeScript does, where the word door's and and or are relations", async () => {
    const safe = m.define(function safe(x: number): boolean {
      return x !== 0 && 10 / x > 1;
    });
    const either = m.define(function either(x: number): boolean {
      return x === 0 || 10 / x > 1;
    });
    assert.equal(String(safe.equations[0]), "(= (safe $x) (and-then (!= $x 0) (> (/ 10 $x) 1)))");
    assert.equal(String(await safe(0).one()), "false", "the division never runs");
    assert.equal(String(await safe(5).one()), "true");
    assert.equal(String(await either(0).one()), "true", "the division never runs");
    const solved = await m.eval(If(and(or(V.x, TRUE), V.y), [V.x, V.y])).toArray();
    assert.deepEqual(solved.map(String), ["(true true)", "(false true)"], "and and or solve for unbound operands");
  });

  it("keeps Math's JavaScript meaning, over the engine's own math heads", async () => {
    const near = m.define(function near(a: number, b: number): boolean {
      return Math.abs(a - b) < 2;
    });
    assert.equal(String(near.equations[0]), "(= (near $a $b) (< (abs-math (- $a $b)) 2))");
    assert.equal(String(await near(1, 2.5).one()), "true");

    // A tie rounds UP in JavaScript and away from zero in the engine's
    // round-math, so Math.round is the floor unless the fraction reaches a half.
    const rounded = m.define(function rounded(x: number): number {
      return Math.round(x);
    });
    assert.match(
      String(rounded.equations[0]),
      /^\(= \(rounded \$x\) \(let (\$floor__\d+) \(floor-math \$x\) \(if \(< \(- \$x \1\) 0\.5\) \1 \(ceil-math \$x\)\)\)\)$/,
    );
    const ties = [-2.5, -0.5, 0.5, 2.5, 0.49999999999999994];
    assert.deepEqual(ties.map(Math.round), [-2, -0, 1, 3, 0]);
    // MeTTa's integers have one zero, so JavaScript's -0 comes back as 0.
    assert.deepEqual(await Promise.all(ties.map(async (x) => hostValue(await rounded(x).one()))), [-2, 0, 1, 3, 0]);

    const constants = m.define(function constants(): Term {
      return [Math.PI, -Math.E, -Infinity, Math.max(), Math.min(), Math.max(4), Math.min(3, 1, 2)];
    });
    assert.equal(
      String(constants.equations[0]),
      "(= (constants) (3.141592653589793 -2.718281828459045 -inf -inf inf 4 (min (min 3 1) 2)))",
    );

    const walked = m.define(function walked(xs: number[]): Term {
      return [xs.map(Math.abs), xs.map(Math.round), xs.map((x) => Math.max(x, 0))];
    });
    assert.match(String(walked.equations[0]), /\(map-atom \$xs abs-math\) \(map-atom \$xs \(\|-> \(\$x__\d+\) \(let /);
    assert.equal(String(await walked([-1.5, 2.5]).one()), "((1.5 2.5) (-1 3) (0 2.5))");
  });

  it("runs Math's functions in the engine as TypeScript runs them, over every draw", async () => {
    function mathOf(x: number): number[] {
      const unit = x / 1000000;
      return [
        Math.abs(x),
        Math.acos(unit),
        Math.asin(unit),
        Math.atan(x),
        Math.ceil(x),
        Math.cos(x),
        Math.exp(unit),
        Math.floor(x),
        Math.log(Math.abs(x)),
        Math.pow(unit, 3),
        Math.round(x),
        Math.sin(x),
        Math.sqrt(Math.abs(x)),
        Math.tan(x),
        Math.trunc(x),
        Math.max(x, 0, -x),
        Math.min(x, 1),
      ];
    }
    const names = ["abs", "acos", "asin", "atan", "ceil", "cos", "exp", "floor", "log", "pow", "round", "sin", "sqrt", "tan", "trunc", "max", "min"];
    // ECMA-262 leaves these implementation-approximated, and V8's libm and the
    // engine's differ in the last place on some arguments; the rest are exact,
    // sqrt because IEEE 754 rounds it correctly in both.
    const approximated = new Set(["acos", "asin", "atan", "cos", "exp", "log", "pow", "sin", "tan"]);
    const lowered = m.define(mathOf);
    const random = new Random(20260924);
    const draws = [
      ...[-2.5, -0.5, 0, 0.5, 1.5, 2.5, 0.49999999999999994, -0.49999999999999994, 1, -1, 3, -3.7, 0.3, 1e-9],
      ...Array.from({ length: 100 }, () => random.between(-1000, 1000) + 0.5),
      ...Array.from({ length: 100 }, () => random.between(-1000000, 1000000)),
      ...Array.from({ length: 200 }, () => (random.next() - 0.5) * 2000000),
    ];
    const disagreements: string[] = [];
    for (const x of draws) {
      const answer = await lowered(x).one();
      assert.ok(answer instanceof Expression);
      const engine = answer.items.map((item) => Number(hostValue(item)));
      mathOf(x).forEach((expected, at) => {
        const got = engine[at] as number;
        const name = names[at] as string;
        const apart = ulpsApart(got, expected);
        if (apart > (approximated.has(name) ? 1 : 0)) {
          disagreements.push(`Math.${name} at ${String(x)}: engine ${String(got)}, TypeScript ${String(expected)}, ${String(apart)} ulps`);
        }
      });
    }
    assert.deepEqual(disagreements, []);
  });

  it("refuses a Math function the engine has no head for, or one passed where its arity is not the caller's", () => {
    assert.throws(
      () =>
        m.define(function signOf(x: number): number {
          return Math.sign(x);
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_LOWER" && /Math\.sign/.test(error.message) && /abs, acos, asin/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function powers(xs: number[]): Term {
          return xs.map(Math.pow);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /takes 2/.test(error.message) && /index/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function largest(xs: number[]): number {
          // @ts-expect-error: TypeScript refuses it too, and a JavaScript caller has no checker
          return xs.reduce(Math.max, -Infinity);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /any number of arguments/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function twoAbs(x: number): number {
          // @ts-expect-error: the arity refusal is the point of this case
          return Math.abs(x, x);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /takes 1/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function shadowsMath(Math: { abs(x: number): number }): number {
          return Math.abs(1);
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /not a plain name/.test(error.message),
    );
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
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /async function/.test(error.message) && /op/.test(error.message),
    );
  });

  it("refuses a free name nothing defines, naming the ways to supply it and to mention it", () => {
    assert.throws(
      () =>
        m.define(function reaching(n: number): number {
          return somethingUndeclared(n) as number;
        }),
      (error: MettaError) =>
        error.code === "ERR_METTA_LOWER" &&
        /somethingUndeclared/.test(error.message) &&
        /scope/.test(error.message) &&
        error.message.includes("S.somethingUndeclared(...)"),
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

  it("a caseOf chain as a case tower, its handlers reading the pattern's variables", async () => {
    const len = m.define(function len(list: Term): Term {
      return caseOf(list)
        .with([], () => 0)
        .with(S.cons(_, V.tail), ({ tail }) => add(len(tail), 1))
        .end();
    });
    assert.ok(alphaEqual(
      len.equations[0]!,
      rewrite(S.len(V.list), S.case(V.list, [[[], 0], [S.cons(_, V.tail), S["+"](S.len(V.tail), 1)]])),
    ));
    assert.deepEqual(await len([1, 2, 3]), [toAtom(3)]);

    const describe = m.define(function describe(value: Term): Term {
      return caseOf(value)
        .with(S.pair(V.left, V.right), ({ left: chosen }) => S.picked(chosen))
        .otherwise(() => {
          const fallback = S.other;
          return fallback;
        });
    });
    assert.deepEqual(await describe(S.pair(1, 2)), [S.picked(1)]);
    assert.deepEqual(await describe(S.lone), [S.other.atom]);
  });

  it("a space's methods on a parameter the program declares as a space", async () => {
    const first = m.define(function firstOf(space: Space, pattern: Atom): Term {
      return fn.once(space.match(pattern, pattern));
    });
    assert.ok(alphaEqual(
      first.equations[0]!,
      rewrite(S.firstOf(V.space, V.pattern), S.once(S.match(V.space, V.pattern, V.pattern))),
    ));
    const kb = m.space(S.lowerFirst);
    kb.add(S.item(1), S.item(2));
    assert.deepEqual(await first(kb, S.item(V.n)), [S.item(1)]);
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
declare function doubled(n: number): number;

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

describe("a lambda", () => {
  it("is an arrow function, in a lowered body and from the host", async () => {
    const double = m.lambda((x: number) => x * 2);
    assert.equal(String(double), "(|-> ($x) (* $x 2))");
    assert.equal(String(await m.eval([double, 21]).one()), "42");
    assert.equal(String(await m.eval(fn.forall(fn.superpose([1, 3]), m.lambda((v: number) => v < 2))).one()), "false");

    const below = m.define(function below(limit: number): Term {
      return (v: number) => v < limit;
    });
    assert.equal(String(below.equations[0]), "(= (below $limit) (|-> ($v) (< $v $limit)))");
    assert.equal(String(await m.eval([S.below(2), 1]).one()), "true");

    const adder = m.define(function adder(k: number): number {
      const plus = (a: number, b: number) => a + b + k;
      return plus(1, 2);
    });
    assert.equal(String(await adder(10).one()), "13", "a const holding a lambda applies it, and the lambda reads k");
  });

  it("gives a binder that shadows the body around it a fresh variable", async () => {
    const shadow = m.define(function shadow(x: number): Term {
      return (x: number) => x + 1;
    });
    assert.match(String(shadow.equations[0]), /^\(= \(shadow \$x\) \(\|-> \(\$x__\d+\) \(\+ \$x__\d+ 1\)\)\)$/);
    assert.equal(String(await m.eval([S.shadow(5), 1]).one()), "2", "the call binds the head's $x, not the lambda's");
  });

  it("refuses an async arrow and a destructured binder", () => {
    assert.throws(
      () => m.lambda(async (x: number) => x),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /async/.test(error.message),
    );
    assert.throws(
      () =>
        m.define(function pairwise(): Term {
          return ([a, b]: number[]) => a + b;
        }),
      (error: MettaError) => error.code === "ERR_METTA_LOWER" && /ArrayPattern/.test(error.message),
    );
  });
});

describe("a rule set", () => {
  it("stores each yielded equation as written, over the generator's parameters as variables", async () => {
    const depth = m.rules(function* depth(inner: Term) {
      yield rewrite(S.depth(S.leaf), 0);
      yield rewrite(S.depth(S.wrap(inner)), add(1, S.depth(inner)));
    });
    assert.deepEqual(depth.map(String), ["(= (depth leaf) 0)", "(= (depth (wrap $inner)) (+ 1 (depth $inner)))"]);
    assert.ok(depth.every((equation) => m.self.has(equation)));
    assert.equal(String(await m.eval(S.depth(S.wrap(S.wrap(S.leaf)))).one()), "2");
  });

  it("checks every yield before storing any, and refuses what is not an equation", () => {
    const before = m.self.size;
    assert.throws(
      () =>
        m.rules(function* halfWritten() {
          yield rewrite(S.landed(), 1);
          yield S.notAnEquation(2);
        }),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /not an equation/.test(error.message),
    );
    assert.equal(m.self.size, before, "a refused rule set lands nothing");
  });

  it("refuses a goal, a body that yields nothing, and a plain function", () => {
    assert.throws(
      () =>
        m.rules(function* asking() {
          yield* m.match(S.anything(V.x));
        }),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /asks a goal/.test(error.message),
    );
    assert.throws(
      () => m.rules(function* silent() {}),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /no equation/.test(error.message),
    );
    assert.throws(
      () => m.rules((() => rewrite(S.plain(), 1)) as never),
      (error: MettaError) => error.code === "ERR_METTA_TRACE" && /not a generator/.test(error.message),
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

  it("turns a rejection into the engine's own error, with the thrown one as its cause", async () => {
    const thrown = new Error("no");
    m.op(function angry(): number {
      throw thrown;
    });
    await assert.rejects(
      () => m.eval(S.angry()).one(),
      (error: unknown) =>
        error instanceof EngineError &&
        /the host operation raised: no/.test(error.message) &&
        error.cause === thrown,
    );
  });

  it("hands a host operation's own error back as itself or as the cause", async () => {
    // One of this package's own errors IS the reading, as PyMeTTa re-raises
    // its own: the caller catches the very object, class and code intact.
    const own = new CastError("not a count");
    m.op(function refusesToCount(): number {
      throw own;
    });
    await assert.rejects(() => m.eval(S.refusesToCount()).one(), (error: unknown) => error === own);
    // An author's error, rejected late or thrown mid-stream, rides on the
    // engine's error as its cause.
    const late = new RangeError("too late");
    m.op(async function rejectsLate(): Promise<number> {
      await Promise.resolve();
      throw late;
    });
    await assert.rejects(
      () => m.eval(S.rejectsLate()).one(),
      (error: unknown) => error instanceof EngineError && error.cause === late,
    );
    const midway = new RangeError("ran out");
    m.op(
      function* runsOut(): Generator<number> {
        yield 1;
        throw midway;
      },
      { effect: "pureStructural" },
    );
    await assert.rejects(
      () => m.eval(S.runsOut()).toArray(),
      (error: unknown) => error instanceof EngineError && error.cause === midway,
    );
    // A failure MeTTa catches is data, and reaches no door.
    const caught = await m.eval(fn.catch(S.refusesToCount())).one();
    assert.ok(caught instanceof Expression && String(caught.items[0]) === "Error");
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

  it("is its head wherever a term goes", async () => {
    const triple = m.define(function triple(n: number): number {
      return n * 3;
    });
    assert.equal(toAtom(triple), triple.atom);
    assert.equal(String(S.twiceOf(triple, 2)), "(twice-of triple 2)");
    const applied = m.define(function applied(f: (n: number) => number, n: number): number {
      return f(n);
    });
    assert.equal(String(await applied(triple, 7).one()), "21", "the host hands the engine the symbol it applies");
    assert.notEqual(G(triple), triple.atom, "G grounds the live object");
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
