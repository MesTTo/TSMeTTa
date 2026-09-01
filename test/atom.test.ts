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
  exprOf,
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

  it("interns a wide expression without joining every child id into text", () => {
    const items = Array.from({ length: 20_000 }, (_, at) => G(at));
    const original = Array.prototype.join;
    let joinedIds = false;
    Array.prototype.join = function guarded<T>(this: T[], separator?: string): string {
      if (this.length === items.length + 1 && this[0] === "e") {
        joinedIds = true;
        throw new Error("exprOf materialised one string field per child");
      }
      return original.call(this, separator);
    } as typeof Array.prototype.join;
    try {
      const first = exprOf(items);
      assert.equal(exprOf(items), first, "the structural expression stopped interning");
    } finally {
      Array.prototype.join = original;
    }
    assert.equal(joinedIds, false);
  });

  it("keeps structurally different expressions separate inside one hash bucket", () => {
    class FixedIdAtom extends Atom {
      override readonly kind = "symbol" as const;
      readonly label: string;
      constructor(id: number, label: string) {
        super();
        Object.defineProperty(this, "id", { value: id });
        this.label = label;
        Object.freeze(this);
      }
      override get text(): string {
        return this.label;
      }
    }

    // These two id sequences collide under the FNV-1a bucket hash. Exact child
    // identity, not the hash, remains the equality decision.
    const leftItems = [
      new FixedIdAtom(1_048_577, "left-a"),
      new FixedIdAtom(3_145_735, "left-b"),
    ];
    const rightItems = [
      new FixedIdAtom(2_097_155, "right-a"),
      new FixedIdAtom(1_922_775_893, "right-b"),
    ];
    const left = exprOf(leftItems);
    const right = exprOf(rightItems);
    assert.notEqual(left, right, "a hash collision became structural equality");
    assert.equal(exprOf(leftItems), left);
    assert.equal(exprOf(rightItems), right);
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
  it("sorts variable, number, text, symbol, expression", () => {
    const sorted = [expr(sym("z")), sym("b"), variable("v"), G(3), G("s")].sort(byStandardOrder);
    assert.deepEqual(sorted.map(String), ["$v", "3", '"s"', "b", "(z)"]);
  });

  it("matches the engine's numeric, atomic and list order at every edge", () => {
    assert.ok(byStandardOrder(G(Number.NaN), G(Number.NEGATIVE_INFINITY)) < 0);
    assert.ok(byStandardOrder(G(-0), float(0)) < 0);
    assert.ok(byStandardOrder(float(0), G(0)) < 0);
    assert.ok(byStandardOrder(G(2n ** 60n), G(2n ** 60n + 1n)) < 0);
    assert.ok(byStandardOrder(G(2 ** 60), G(2n ** 60n + 1n)) < 0);
    assert.ok(byStandardOrder(G("true"), G(true)) < 0);
    assert.ok(byStandardOrder(expr(), sym("Apple")) < 0);
    assert.ok(byStandardOrder(expr(sym("a"), sym("b")), expr(sym("z"))) < 0);
    assert.ok(byStandardOrder(expr(sym("a")), expr(sym("a"), sym("b"))) < 0);
    assert.ok(byStandardOrder(sym("\u{e000}"), sym("\u{10000}")) < 0);
  });

  it("is a total order across every host atom distinction", () => {
    const first = {};
    const second = {};
    const atoms: readonly Atom[] = [
      variable("alpha"),
      variable("beta"),
      G(Number.NaN),
      G(Number.NEGATIVE_INFINITY),
      G(-0),
      float(0),
      G(0),
      G(0n),
      G(2 ** 60),
      G(2n ** 60n),
      G(2n ** 60n + 1n),
      G(Number.POSITIVE_INFINITY),
      G("\u{e000}"),
      G("\u{10000}"),
      expr(),
      sym("[]"),
      G(first),
      G(second),
      G(Symbol.for("metta-node.atom.order")),
      G(Symbol("metta-node.atom.order")),
      space("&same"),
      sym("&same"),
      G(false),
      sym("false"),
      G(true),
      sym("true"),
      expr(sym("a")),
      expr(sym("a"), sym("b")),
      expr(sym("z")),
    ];
    const sign = (value: number): number => Math.sign(value);
    for (const left of atoms) {
      assert.equal(byStandardOrder(left, left), 0, `atom ${String(left.id)} is not reflexive`);
      for (const right of atoms) {
        const leftRight = byStandardOrder(left, right);
        const rightLeft = byStandardOrder(right, left);
        assert.equal(
          sign(leftRight) + sign(rightLeft),
          0,
          `atoms ${String(left.id)} and ${String(right.id)} are not antisymmetric`,
        );
        assert.equal(
          leftRight === 0,
          left === right,
          `distinct atoms ${String(left.id)} and ${String(right.id)} compare equal`,
        );
        for (const last of atoms) {
          if (leftRight <= 0 && byStandardOrder(right, last) <= 0) {
            assert.ok(
              byStandardOrder(left, last) <= 0,
              `atoms ${String(left.id)}, ${String(right.id)}, ${String(last.id)} are not transitive`,
            );
          }
        }
      }
    }
  });
});
