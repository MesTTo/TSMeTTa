/**
 * Purpose: the codec's own tests, at both strictnesses. No engine, because a
 *   codec that needs one is not a codec.
 * Guarantees:
 *   - the grammar's refusals are refusals here, by name, and the `o` tag stays
 *     out of the strict profile
 *   - repeated primitive host values reuse one live handle and clearing the
 *     table cannot resurrect that handle [tested: "reuses one host id for each
 *     primitive value"; "clears primitive ids without recycling a released
 *     handle"; commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  type Atom,
  Expression,
  FloatAtom,
  G,
  Grounded,
  HostValues,
  SpaceHandle,
  WireError,
  type Wire,
  atomFromWire,
  decodeEngine,
  encodeEngine,
  expr,
  exprOf,
  float,
  fromRoundTrip,
  fromTransport,
  numberFromText,
  numberToText,
  space,
  sym,
  toTransport,
  variable,
  wireFromAtom,
} from "../src/index.ts";

/** `(f (f ... x ...))` `depth` deep, built bottom up so building it is not the test. */
function deepAtom(depth: number, leaf: Atom = sym("x")): Atom {
  let node = leaf;
  for (let at = 0; at < depth; at += 1) node = exprOf([sym("f"), node]);
  return node;
}

/** The same shape as a portable transport term. */
function deepTransport(depth: number): unknown {
  let node: unknown = ["s", "x"];
  for (let at = 0; at < depth; at += 1) node = ["e", [["s", "f"], node]];
  return node;
}

// Deep enough that every walk here used to raise `Maximum call stack size
// exceeded`: the shallowest of them gave out at 2,047 and the deepest at
// 4,095 [measured 2026-08-31, see C47].
const DEEP = 100_000;

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
  it("refuses a numeric root before it can impersonate an expression-close marker", () => {
    for (const read of [fromTransport, toTransport]) {
      assert.throws(
        () => read(3),
        (error: unknown) => error instanceof WireError && error.code === "ERR_METTA_WIRE",
      );
    }
  });

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
    const back = decodeEngine(["o", id], { hostValues: values });
    assert.ok(back instanceof Grounded);
    assert.equal(back.value, held);
  });

  it("mints one id per object, so one object is one handle", () => {
    const values = new HostValues();
    const held = {};
    assert.equal(values.idFor(held), values.idFor(held));
    assert.equal(values.size, 1);
  });

  it("reuses one host id for each primitive value", () => {
    const values = new HostValues();
    const local = Symbol("local");
    const registered = Symbol.for("metta-node-wire-test");
    const primitives = [null, undefined, local, registered, 42, "forty-two", true] as const;
    const first = primitives.map((value) => values.idFor(value));
    const second = primitives.map((value) => values.idFor(value));

    assert.deepEqual(second, first);
    assert.equal(values.size, primitives.length);
  });

  it("clears primitive ids without recycling a released handle", () => {
    const values = new HostValues();
    const released = values.idFor(null);
    values.clear();
    assert.throws(() => values.valueOf(released), /was released/);
    const fresh = values.idFor(null);
    assert.notEqual(fresh, released);
    assert.equal(values.valueOf(fresh), null);
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

describe("the engine transport, which is flat", () => {
  it("spells an expression as its tag, its child count and its children", () => {
    assert.deepEqual(encodeEngine(expr(sym("f"), G(1))), ["e", 2, "s", "f", "n", "1"]);
    assert.deepEqual(encodeEngine(sym("f")), ["s", "f"]);
    assert.deepEqual(encodeEngine(exprOf([])), ["e", 0]);
    assert.equal(decodeEngine(["e", 2, "s", "f", "n", "1"], {}), expr(sym("f"), G(1)));
    assert.equal(decodeEngine(["e", 0], {}), exprOf([]));
  });

  it("round trips every shape through the flat form", () => {
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
      deepAtom(64),
    ];
    for (const atom of atoms) {
      assert.equal(decodeEngine(encodeEngine(atom), {}), atom, `${String(atom)} did not round trip`);
    }
  });

  it("agrees with the wire reader on every tag", () => {
    // Two readers, one grammar: the portable one answers a `Wire` without
    // interning and the engine one answers the atom directly. A leaf's flat
    // spelling IS its portable pair, so the two are asked the very same input.
    const values = new HostValues();
    const held = { live: true };
    const leaves: Wire[] = [
      ["s", "foo"],
      ["v", "x"],
      ["g", "text"],
      ["n", 42n],
      ["n", 2],
      ["n", 1.5],
      ["b", true],
      ["b", false],
      ["p", space("&kb")],
    ];
    for (const leaf of leaves) {
      const pair = toTransport(leaf);
      assert.equal(
        decodeEngine(pair, {}),
        atomFromWire(fromTransport(pair)),
        `the two readers disagree on ${JSON.stringify(pair)}`,
      );
    }
    const reference = toTransport(["o", held], { hostValues: values });
    assert.equal(decodeEngine(reference, { hostValues: values }), G(held));
  });

  it("refuses a token list that stops inside a term, or runs past it", () => {
    assert.throws(() => decodeEngine(["e", 2, "s", "f"], {}), /ended inside a term/);
    assert.throws(() => decodeEngine(["s", "f", "s", "g"], {}), /past the term/);
    assert.throws(() => decodeEngine(["e", "two", "s", "f"], {}), /carries a child count/);
    assert.throws(() => decodeEngine("s", {}), /not a transport term/);
  });

  it("restores which of s and p a name entered under, by position", () => {
    const sent = encodeEngine(expr(sym("f"), space("&kb")));
    // The engine has one atom for both, so it answers `s` where `p` went in.
    const echoed = ["e", 2, "s", "f", "s", "&kb"];
    assert.equal(fromRoundTrip(sent, echoed), expr(sym("f"), space("&kb")));
    // Without the provenance the same answer is a symbol, which is what the
    // strict grammar says it is.
    assert.equal(decodeEngine(echoed, {}), expr(sym("f"), sym("&kb")));
  });
});

describe("a term deeper than the JavaScript stack", () => {
  it("carries a term a hundred thousand deep through every codec leg", () => {
    const atom = deepAtom(DEEP);
    const tokens = encodeEngine(atom);
    assert.equal(tokens.length, DEEP * 4 + 2);
    assert.equal(decodeEngine(tokens, {}), atom);
    assert.equal(fromRoundTrip(tokens, tokens), atom);

    const transport = deepTransport(DEEP);
    assert.equal(atomFromWire(fromTransport(transport)), atom);
    // Compared by INTERNED IDENTITY rather than by `deepEqual`, which is
    // itself a recursive walk and gives out at this depth: the assertion would
    // be the thing that could not read a term the codec now can.
    assert.equal(atomFromWire(toTransport(wireFromAtom(atom)) as never), atom);
  });

  it("renders one, so a deep answer can be read", () => {
    const text = deepAtom(DEEP).text;
    assert.equal(text.length, DEEP * 4 + 1);
    assert.ok(text.startsWith("(f (f (f "));
  });

  it("carries an expression with more children than a spread can take", () => {
    // A variadic call is a ceiling and an array is not, which is C27's law:
    // `exprOf` takes the array and `expr(...array)` is the sugar over it.
    const wide = exprOf(Array.from({ length: 200_000 }, (_, at) => G(at)));
    assert.ok(wide instanceof Expression);
    assert.equal(decodeEngine(encodeEngine(wide), {}), wide);
    assert.equal(atomFromWire(wireFromAtom(wide)), wide);
  });
});
