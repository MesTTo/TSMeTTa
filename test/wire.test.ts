/**
 * Purpose: the codec's own tests, at both strictnesses. No engine, because a
 *   codec that needs one is not a codec.
 * Guarantees:
 *   - the grammar's refusals are refusals here, by name, and the `o` tag stays
 *     out of the strict profile
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  FloatAtom,
  G,
  Grounded,
  HostValues,
  SpaceHandle,
  atomFromWire,
  decodeEngine,
  expr,
  float,
  fromTransport,
  numberFromText,
  numberToText,
  space,
  sym,
  toTransport,
  variable,
  wireFromAtom,
} from "../src/index.ts";

describe("numbers", () => {
  it("reads every spelling the engine's writer produces", () => {
    assert.equal(numberFromText("42"), 42n);
    assert.equal(numberFromText("-9223372036854775809"), -9223372036854775809n);
    assert.equal(numberFromText("2.0"), 2);
    assert.equal(numberFromText("1.5e10"), 1.5e10);
    assert.equal(numberFromText("1.0Inf"), Infinity);
    assert.equal(numberFromText("-1.0Inf"), -Infinity);
    assert.ok(Number.isNaN(numberFromText("1.5NaN") as number));
  });

  it("refuses a value JavaScript has no type for, by name", () => {
    assert.throws(() => numberFromText("1r3"), /no JavaScript type/);
  });

  it("writes a spelling the reader takes back", () => {
    assert.equal(numberToText(42n), "42");
    assert.equal(numberToText(2), "2.0");
    assert.equal(numberToText(-0), "-0.0", "String(-0) loses the sign a double carries");
    assert.equal(numberToText(Infinity), "1.0Inf");
    assert.equal(numberToText(1e21), "1.0e+21");
  });
});

describe("the strict wire", () => {
  it("decodes every leaf tag", () => {
    assert.deepEqual(fromTransport(["s", "foo"]), ["s", "foo"]);
    assert.deepEqual(fromTransport(["v", "x"]), ["v", "x"]);
    assert.deepEqual(fromTransport(["g", "text"]), ["g", "text"]);
    assert.deepEqual(fromTransport(["n", "42"]), ["n", 42n]);
    assert.deepEqual(fromTransport(["b", "true"]), ["b", true]);
    assert.deepEqual(fromTransport(["e", []]), ["e", []]);
  });

  it("decodes a portable space reference into an interned handle", () => {
    const [tag, handle] = fromTransport(["p", "&self"]) as readonly ["p", SpaceHandle];
    assert.equal(tag, "p");
    assert.ok(handle instanceof SpaceHandle);
    assert.equal(handle.name, "&self");
    assert.equal(handle, space("&self"), "one name denotes one space identity");
    assert.throws(() => fromTransport(["p", "self"]), /ampersand-prefixed space name/);
  });

  it("refuses the o tag, which only this host's own session can name", () => {
    assert.throws(() => fromTransport(["o", "1"]), /live host value by reference/);
    assert.throws(() => toTransport(["o", {}]), /live host value by reference/);
  });

  it("refuses a tag outside the grammar", () => {
    assert.throws(() => fromTransport(["z", "what"]), /unknown wire tag/);
    assert.throws(() => toTransport(["h", "1"]), /unknown wire tag/);
  });

  it("refuses a wire atom that is not a pair", () => {
    assert.throws(() => fromTransport(["s"]), /not a transport atom/);
    assert.throws(() => toTransport("s"), /not a wire atom/);
  });

  it("refuses a payload of the wrong kind for its tag", () => {
    assert.throws(() => toTransport(["s", 5]), /carries text/);
    assert.throws(() => toTransport(["n", "2"]), /carries a number/);
    assert.throws(() => toTransport(["b", "true"]), /carries a boolean/);
    assert.throws(() => fromTransport(["b", "maybe"]), /carries true or false/);
    assert.throws(() => toTransport(["e", "x"]), /carries a list/);
    assert.throws(() => fromTransport(["e", "x"]), /carries a list/);
    assert.throws(() => toTransport(["p", "&self"]), /carries a SpaceHandle/);
  });
});

describe("the engine transport's own tag", () => {
  it("hands a live value out by reference and gets the very same object back", () => {
    const values = new HostValues();
    const held = { hello: "world" };
    const [, id] = toTransport(["o", held], { hostValues: values });
    const [tag, back] = decodeEngine(["o", id], { hostValues: values });
    assert.equal(tag, "o");
    assert.equal(back, held);
  });

  it("mints one id per object, so one object is one handle", () => {
    const values = new HostValues();
    const held = {};
    assert.equal(values.idFor(held), values.idFor(held));
    assert.equal(values.size, 1);
  });

  it("refuses a released id rather than answering a fresh value", () => {
    const values = new HostValues();
    assert.throws(() => values.valueOf(99), /was released/);
  });
});

describe("atoms and wire atoms", () => {
  it("round trips every shape", () => {
    const atoms = [
      sym("foo"),
      variable("x"),
      G("text"),
      G(true),
      G(42),
      float(42),
      G(1.5),
      space("&kb"),
      expr(sym("f"), G(1), expr()),
    ];
    for (const atom of atoms) {
      assert.equal(atomFromWire(wireFromAtom(atom)), atom, `${String(atom)} did not round trip`);
    }
  });

  it("keeps the integer and the float apart across the wire", () => {
    assert.deepEqual(wireFromAtom(G(42)), ["n", 42n]);
    assert.deepEqual(wireFromAtom(float(42)), ["n", 42]);
    assert.ok(atomFromWire(["n", 42]) instanceof FloatAtom);
    assert.ok(!(atomFromWire(["n", 42n]) instanceof FloatAtom));
  });

  it("keeps a big integer exact, where a number could not", () => {
    const wide = 170141183460469231731687303715884118073n;
    const held = atomFromWire(["n", wide]);
    assert.ok(held instanceof Grounded);
    assert.equal(held.value, wide);
    assert.deepEqual(wireFromAtom(G(wide)), ["n", wide]);
  });
});
