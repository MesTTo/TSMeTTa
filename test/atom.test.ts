/**
 * Purpose: the atom algebra's own tests: interning, freezing, printing,
 *   ordering, coercion refusal and the walkers. No engine.
 * Guarantees:
 *   - the claims `src/atom.ts` makes in its header fail here before anything
 *     downstream sees them
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { inspect } from "node:util";

import {
  Atom,
  Expression,
  FloatAtom,
  G,
  Grounded,
  SpaceHandle,
  Sym,
  Var,
  byStandardOrder,
  expr,
  float,
  fresh,
  mapTerm,
  space,
  substitute,
  sym,
  termVars,
  toAtom,
  variable,
} from "../src/index.ts";
import { ATOM_OF } from "../src/atom.ts";

describe("interning", () => {
  it("makes === structural", () => {
    assert.equal(sym("a"), sym("a"));
    assert.equal(variable("x"), variable("x"));
    assert.equal(expr(sym("f"), G(1)), expr(sym("f"), G(1)));
    assert.equal(space("&kb"), space("&kb"));
    assert.notEqual(sym("a"), sym("b"));
  });

  it("makes Set and Map structural without either being reimplemented", () => {
    const held = new Set([expr(sym("f"), G(1))]);
    assert.ok(held.has(expr(sym("f"), G(1))));
    assert.equal(held.size, 1);
    held.add(expr(sym("f"), G(1)));
    assert.equal(held.size, 1);
    assert.ok([sym("a"), sym("b")].includes(sym("b")));
  });

  it("gives a host value one atom per object", () => {
    const held = { hello: "world" };
    assert.equal(G(held), G(held));
    assert.equal(G(held).value, held);
    assert.notEqual(G({ hello: "world" }), G({ hello: "world" }));
  });

  it("interns registered symbols without treating them as weak keys", () => {
    const key = "metta-node.atom.test.registered";
    const shared = Symbol.for(key);
    assert.equal(G(shared), G(Symbol.for(key)));
    assert.equal(G(shared).value, shared);

    const first = Symbol("private");
    const second = Symbol("private");
    assert.equal(G(first), G(first));
    assert.notEqual(G(first), G(second));
  });

  it("keeps a fresh variable out of every source name's way", () => {
    const one = fresh();
    const two = fresh();
    assert.notEqual(one, two);
    assert.notEqual(one, variable("g"));
  });
});

describe("immutability", () => {
  it("freezes every atom", () => {
    for (const atom of [sym("a"), variable("x"), G(1), float(1), expr(sym("f")), space("&s")]) {
      assert.ok(Object.isFrozen(atom), `${String(atom)} is not frozen`);
    }
  });

  it("freezes an expression's children list", () => {
    assert.ok(Object.isFrozen(expr(sym("f"), sym("g")).items));
  });
});

describe("narrowing", () => {
  it("tells the five shapes apart by instanceof", () => {
    assert.ok(sym("a") instanceof Sym);
    assert.ok(variable("x") instanceof Var);
    assert.ok(G(1) instanceof Grounded);
    assert.ok(expr() instanceof Expression);
    assert.ok(space("&s") instanceof SpaceHandle);
    for (const atom of [sym("a"), variable("x"), G(1), expr(), space("&s")]) {
      assert.ok(atom instanceof Atom);
    }
  });

  it("gives an expression a head and arguments", () => {
    const term = expr(sym("parent"), sym("tom"), sym("bob"));
    assert.equal(term.head, sym("parent"));
    assert.deepEqual([...term.args], [sym("tom"), sym("bob")]);
    assert.equal(expr().head, undefined);
  });
});

describe("printing", () => {
  it("renders MeTTa text", () => {
    assert.equal(String(expr(sym("parent"), sym("tom"), sym("bob"))), "(parent tom bob)");
    assert.equal(String(variable("x")), "$x");
    assert.equal(String(G("hi")), '"hi"');
    assert.equal(String(G(true)), "true");
    assert.equal(String(G(false)), "false");
    assert.equal(String(expr()), "()");
  });

  it("tells an integer from a float, which is what the engine does", () => {
    assert.equal(String(G(42)), "42");
    assert.equal(String(float(42)), "42.0");
    assert.equal(String(G(1.5)), "1.5");
    assert.equal(G(1.5), float(1.5), "a fractional number is already a float");
    assert.notEqual(G(42), float(42));
    assert.ok(float(42) instanceof FloatAtom);
    assert.ok(!(G(42) instanceof FloatAtom));
  });

  it("keeps the sign of negative zero, which String(-0) loses", () => {
    assert.equal(String(G(-0)), "-0.0");
    assert.notEqual(G(-0), G(0));
  });

  it("prints as MeTTa text in the console too", () => {
    assert.equal(inspect(expr(sym("f"), G(1))), "(f 1)");
    assert.equal(`${String(sym("a"))}`, "a");
  });

  it("names a live host value by its constructor rather than pretending", () => {
    assert.equal(String(G(new Map())), "(js Map)");
    assert.equal(String(G(null)), "(js null)");
  });
});

describe("coercion", () => {
  it("renders for a string hint and refuses everything else", () => {
    const atom = sym("a");
    assert.equal(String(atom), "a");
    assert.equal(`${atom}`, "a");
    assert.equal([atom, atom].join(","), "a,a");
    assert.throws(() => Number(atom), /does not coerce/);
    assert.throws(() => (atom as unknown as number) + 1, /does not coerce/);
  });

  it("carries a code a test can match rather than prose", () => {
    try {
      Number(sym("a"));
      assert.fail("expected a refusal");
    } catch (error) {
      assert.equal((error as { code?: string }).code, "ERR_METTA_UNSUPPORTED");
    }
  });
});

describe("term position", () => {
  it("reads an array as an expression", () => {
    assert.equal(toAtom([sym("parent"), sym("tom")]), expr(sym("parent"), sym("tom")));
  });

  it("reads a plain value as a grounded atom", () => {
    assert.equal(toAtom(42), G(42));
    assert.equal(toAtom("hi"), G("hi"));
  });

  it("reads a callable that carries its own atom as that atom", () => {
    const callable = Object.defineProperty(
      () => undefined,
      ATOM_OF,
      { value: sym("parent") },
    );
    assert.equal(toAtom(callable), sym("parent"));
  });
});

describe("walking", () => {
  it("collects distinct named variables in first-seen order", () => {
    const pattern = expr(sym("f"), variable("y"), variable("x"), variable("y"));
    assert.deepEqual(termVars(pattern).map((v) => v.name), ["y", "x"]);
  });

  it("leaves the anonymous variable out, because it names nothing", () => {
    assert.deepEqual(termVars(expr(sym("f"), variable("_"), variable("x"))).map((v) => v.name), [
      "x",
    ]);
  });

  it("rebuilds a term from the leaves upward", () => {
    const built = mapTerm(expr(sym("f"), G(1), expr(sym("g"), G(2))), (leaf) =>
      leaf instanceof Grounded ? G(Number(leaf.value) * 10) : leaf,
    );
    assert.equal(String(built), "(f 10 (g 20))");
  });

  it("substitutes by name and leaves the rest alone", () => {
    const pattern = expr(sym("f"), variable("x"), variable("y"));
    assert.equal(String(substitute(pattern, { x: sym("tom") })), "(f tom $y)");
  });
});

describe("the standard order", () => {
  it("sorts variable, number, symbol, text, expression", () => {
    const sorted = [expr(sym("z")), sym("b"), variable("v"), G(3), G("s")].sort(byStandardOrder);
    assert.deepEqual(sorted.map(String), ["$v", "3", "b", '"s"', "(z)"]);
  });

  it("sorts expressions by arity before contents", () => {
    const sorted = [expr(sym("a"), sym("b")), expr(sym("z"))].sort(byStandardOrder);
    assert.deepEqual(sorted.map(String), ["(z)", "(a b)"]);
  });
});
