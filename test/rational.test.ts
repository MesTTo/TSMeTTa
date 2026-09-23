/**
 * Purpose: an exact MeTTa rational, crossing between the engine and
 *   TypeScript as the number it is.
 * Guarantees:
 *   - a rational the engine answers arrives as a RationalAtom holding the
 *     exact Rational, prints as the engine writes it, and goes back into an
 *     ask as the same number [tested: "crosses from the engine and back as the
 *     number it is"]
 *   - a rational orders exactly among the integers and the floats, a float
 *     first where the values tie [tested: "orders exactly among the other
 *     numbers"]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  G,
  type MeTTa,
  Rational,
  RationalAtom,
  S,
  byStandardOrder,
  float,
  lib,
  metta,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
  m.import(lib.math);
});

after(() => {
  m.dispose();
});

describe("an exact rational", () => {
  it("crosses from the engine and back as the number it is", async () => {
    const third = await m.fn.mathRational(1, 3).one();
    assert.ok(third instanceof RationalAtom);
    assert.deepEqual([third.value.numerator, third.value.denominator], [1n, 3n]);
    assert.equal(String(third), "1r3");
    assert.equal(third, G(new Rational(1n, 3n)), "one number, one atom");
    assert.equal(String(await m.eval(S["+"](third, 1)).one()), "4r3");
    assert.equal(await m.eval(S["*"](third, 3)).one(), G(1), "a whole answer is the integer");
    // Wider than a double can hold, and still exact.
    const tiny = await m.fn.mathRational(1, 2n ** 2000n).one();
    assert.ok(tiny instanceof RationalAtom);
    assert.equal(tiny.value.denominator, 2n ** 2000n);
    assert.equal(await m.eval(S["*"](tiny, 2n ** 2000n)).one(), G(1));
  });

  it("orders exactly among the other numbers", () => {
    const third = G(new Rational(1n, 3n));
    const nearest = float(0.3333333333333333);
    const sorted = [G(1), third, float(0.5), G(0), nearest].toSorted(byStandardOrder);
    assert.deepEqual(sorted.map(String), ["0", "0.3333333333333333", "1r3", "0.5", "1"]);
    // The double nearest a third lies below it, and a tie puts the float first.
    assert.ok(byStandardOrder(nearest, third) < 0);
    assert.ok(byStandardOrder(float(0.5), G(new Rational(1n, 2n))) < 0);
    assert.ok(byStandardOrder(float(Infinity), third) > 0);
  });
});
