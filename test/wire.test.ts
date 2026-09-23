/**
 * Purpose: the codec's own tests, at both strictnesses. No engine, because a
 *   codec that needs one is not a codec.
 * Guarantees:
 *   - the grammar's refusals are refusals here, by name, and the `o` tag stays
 *     out of the strict profile
 *   - repeated primitive host values reuse one live handle and clearing the
 *     table cannot resurrect that handle [tested: "reuses one host id for each
 *     primitive value"; "clears primitive ids without recycling a released
 *     handle"; commit=e4367498bed06c34f25aff75335e7b25f28b3b73]
 *   - an `h` payload names one atom per id and names in its engine's table,
 *     is written back as it came, and is refused on the portable transport,
 *     by another engine's table and once released [tested: "names one engine
 *     value by one atom per id and names, and writes it back as it came",
 *     "refuses a handle on the portable transport, from another engine, or once
 *     released"; commit=WORKTREE]
 *   - round-trip space provenance follows structural positions and is disabled
 *     after equal-length shapes diverge while scalar leaf changes preserve
 *     later sibling paths [tested: "does not align provenance across a shape change",
 *     "keeps later provenance aligned when only a leaf type changes";
 *     commit=2da346c3fa02a9baedb6168e6b3f6e0756bd6c91]
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
  NativeHandle,
  NativeHandles,
  Rational,
  RationalAtom,
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
  hostValue,
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

  it("carries a rational exactly across the engine transport, and refuses it on the portable one", () => {
    const third = numberFromText("1r3");
    assert.ok(third instanceof Rational);
    assert.deepEqual([third.numerator, third.denominator], [1n, 3n]);
    assert.equal(numberToText(new Rational(-2n, 6n)), "-1r3", "the engine's own spelling, in lowest terms");
    assert.equal(numberFromText("6r2"), 3n, "a whole rational is that integer, as the Python seat reads it");
    assert.throws(() => numberFromText("1/3"), /not a spelling the engine's writer produces/);

    const atom = G(new Rational(2n, 6n));
    assert.ok(atom instanceof RationalAtom);
    assert.equal(atom, G(new Rational(1n, 3n)), "interned by value, as every number is");
    assert.equal(String(atom), "1r3");
    assert.deepEqual(encodeEngine(atom, { hostValues: new HostValues() }), ["n", "1r3"]);
    assert.equal(decodeEngine(["n", "1r3"], {}), atom);
    assert.throws(() => toTransport(wireFromAtom(atom)), (error: unknown) =>
      error instanceof WireError && /no spelling for the rational 1r3/.test(error.message),
    );
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
    // The VALUE, as CODEC.md's n row asks: `bigint` is an integer at any
    // width and `number` is a float, which is the only pair of JavaScript
    // types that tells `["n", 1]` from `["n", 1.0]`.
    assert.deepEqual(fromTransport(["n", 42n]), ["n", 42n]);
    assert.deepEqual(fromTransport(["n", 42]), ["n", 42]);
    assert.deepEqual(fromTransport(["n", 9007199254740993n]), ["n", 9007199254740993n]);
    assert.deepEqual(fromTransport(["b", "true"]), ["b", true]);
    assert.deepEqual(fromTransport(["e", []]), ["e", []]);
  });

  it("refuses an n payload that is text, naming the tag and what arrived", () => {
    // Not a legacy spelling with a compatibility path: this transport carries
    // the value and the ENGINE transport carries decimal text, so text here is
    // a peer speaking a different grammar.
    for (const [payload, kind] of [
      ["42", "a string"],
      ["1.0Inf", "a string"],
      [true, "a boolean"],
      [null, "null"],
    ] as readonly [unknown, string][]) {
      assert.throws(
        () => fromTransport(["n", payload]),
        (error: unknown) => {
          assert.ok(error instanceof WireError);
          assert.match(error.message, /^the n tag carries an exact integer or a float, not /);
          assert.ok(error.message.includes(kind), error.message);
          return true;
        },
        JSON.stringify(payload),
      );
    }
  });

  it("decodes a portable space reference into an interned handle", () => {
    const [tag, handle] = fromTransport(["p", "&self"]) as readonly ["p", SpaceHandle];
    assert.equal(tag, "p");
    assert.ok(handle instanceof SpaceHandle);
    assert.equal(handle.name, "&self");
    assert.equal(handle, space("&self"), "one name denotes one space identity");
    // The ampersand is the built-in spaces' spelling, not a rule of the tag: a
    // bare symbol written through is a registered space name and crosses here.
    const [, bare] = fromTransport(["p", "self"]) as readonly ["p", SpaceHandle];
    assert.equal(bare.name, "self");
    assert.notEqual(bare, handle, "a bare name is a different space from &self");
    assert.throws(() => fromTransport(["p", 5]), /expected text from the engine/);
  });

  it("refuses the o and h tags, which only this host's own session can name", () => {
    assert.throws(() => fromTransport(["o", "1"]), /live host value by reference/);
    assert.throws(() => toTransport(["o", {}]), /live host value by reference/);
    assert.throws(() => fromTransport(["h", "1|0|x"]), /native engine value by reference/);
    assert.throws(() => toTransport(["h", "1"]), /native engine value by reference/);
  });

  it("refuses a tag outside the grammar", () => {
    assert.throws(() => fromTransport(["z", "what"]), /unknown wire tag/);
    assert.throws(() => toTransport(["z", "what"]), /unknown wire tag/);
  });

  it("refuses a wire atom that is not a pair", () => {
    assert.throws(() => fromTransport(["s"]), /not a transport atom/);
    assert.throws(() => toTransport("s"), /not a wire atom/);
  });

  it("refuses a payload of the wrong kind for its tag", () => {
    assert.throws(() => toTransport(["s", 5]), /carries text/);
    assert.throws(() => toTransport(["n", "2"]), /carries a number/);
    assert.throws(() => fromTransport(["n", "2"]), /carries an exact integer or a float/);
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
    const registered = Symbol.for("tsmetta-wire-test");
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
    // interning and the engine one answers the atom directly. The two
    // serialisations spell a number differently, the portable one carrying the
    // value and the engine one its decimal text, so each leg is driven through
    // its own writer and the ATOM is what has to come back the same.
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
      const atom = atomFromWire(leaf);
      assert.equal(decodeEngine(encodeEngine(atom), {}), atom, `the engine leg lost ${String(atom)}`);
      assert.equal(
        atomFromWire(fromTransport(toTransport(leaf))),
        atom,
        `the portable leg lost ${String(atom)}`,
      );
    }
    const reference = toTransport(["o", held], { hostValues: values });
    assert.equal(decodeEngine(reference, { hostValues: values }), G(held));
    const handles = new NativeHandles();
    const native = decodeEngine(["h", "3|0|<regex>(0x1,'a')"], { handles });
    assert.equal(decodeEngine(toTransport(["h", native], { handles }), { handles }), native);
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

  it("does not align provenance across a shape change", () => {
    const sent = ["e", 3, "s", "f", "s", "a", "p", "&kb"];
    const reshaped = ["e", 2, "s", "f", "e", 1, "s", "&kb"];
    assert.equal(fromRoundTrip(sent, reshaped), expr(sym("f"), expr(sym("&kb"))));
  });

  it("keeps later provenance aligned when only a leaf type changes", () => {
    const sent = ["e", 3, "s", "f", "s", "a", "p", "&kb"];
    const changed = ["e", 3, "s", "f", "n", "1", "s", "&kb"];
    assert.equal(fromRoundTrip(sent, changed), expr(sym("f"), G(1), space("&kb")));
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

describe("native handles", () => {
  it("names one engine value by one atom per id and names, and writes it back as it came", () => {
    const handles = new NativeHandles();
    const blob = decodeEngine(["h", "3|0|<regex>(0x1,'a')"], { handles });
    assert.ok(blob instanceof NativeHandle && blob instanceof Grounded);
    assert.equal(blob.ident, 3);
    assert.deepEqual(blob.names, []);
    assert.equal(String(blob), "<regex>(0x1,'a')");
    assert.equal(hostValue(blob), blob, "a handle is its own host value");
    assert.equal(decodeEngine(["h", "3|0|<regex>(0x1,'a')"], { handles }), blob);
    assert.deepEqual(encodeEngine(blob, { handles }), ["h", "3|0|<regex>(0x1,'a')"]);
    // A term with variables crosses under this crossing's names, and its text
    // may hold the separator.
    const carried = decodeEngine(["h", "4|2|_7|_8|f(_7,[a|_8],_7)"], { handles });
    assert.ok(carried instanceof NativeHandle);
    assert.deepEqual(carried.names, ["_7", "_8"]);
    assert.equal(String(carried), "f(_7,[a|_8],_7)");
    assert.deepEqual(encodeEngine(carried, { handles }), ["h", "4|2|_7|_8|f(_7,[a|_8],_7)"]);
    // The same id under other names is another atom naming the same value.
    const renamed = decodeEngine(["h", "4|2|_9|_10|f(_9,[a|_10],_9)"], { handles });
    assert.notEqual(renamed, carried);
    assert.equal(handles.size, 2);
  });

  it("refuses a handle on the portable transport, from another engine, or once released", () => {
    const handles = new NativeHandles();
    const blob = decodeEngine(["h", "5|0|<blob>"], { handles });
    assert.ok(blob instanceof NativeHandle);
    assert.throws(() => fromTransport(["h", "5|0|<blob>"]), /only this host's own engine transport/);
    assert.throws(() => toTransport(["h", blob]), /only this host's own engine transport/);
    assert.throws(
      () => encodeEngine(blob, { handles: new NativeHandles() }),
      /belongs to another engine/,
    );
    assert.throws(() => decodeEngine(["h", "x|0|<blob>"], { handles }), /carries Id\|N\|Names\|Text/);
    assert.throws(() => decodeEngine(["h", "6|2|_1"], { handles }), /carries Id\|N\|Names\|Text/);
    blob.release();
    assert.throws(() => encodeEngine(blob, { handles }), /was released/);
    // The release waits for the engine's next crossing, and is handed over once.
    assert.deepEqual(handles.drain(), [5]);
    assert.deepEqual(handles.drain(), []);
  });
});
