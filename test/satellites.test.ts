/**
 * Purpose: the satellites the Python package has and this one now does —
 *   conversion, tables, lint, integration, arrays, the manifest, and the two
 *   tabled views.
 * Guarantees:
 *   - each one is exercised against a live engine where it needs one, and
 *     without one where it does not
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Expression, G, type MeTTa, S, type Space, V, metta } from "../src/index.ts";
import {
  TO_ATOM,
  build,
  declarations,
  isProjectable,
  project,
  registerType,
  unregisterType,
} from "../src/convert.ts";
import { ARRAY_OPS, Tensor, dtypeOf, installArrays, isArray, topIndices } from "../src/arrays.ts";
import { Finding, RULES, lint } from "../src/lint.ts";
import { Installed, integrate, moduleOps, objectOps } from "../src/integrate.ts";
import { VOCABULARY, boot } from "../src/manifest.ts";
import { ClosureView, TabledMap } from "../src/structures.ts";
import { arrayTables, bridge, tableSpace } from "../src/tables.ts";

let m: MeTTa;
let counter = 0;

const fresh = (): Space => {
  counter += 1;
  return m.space(`&sat${String(counter)}`);
};

// Written with explicit fields rather than parameter properties: the package
// compiles under `erasableSyntaxOnly`, which is what keeps it runnable under
// Node's own type stripping, and a parameter property is not erasable.
class Person {
  readonly name: string;
  readonly age: number;
  constructor(name: string, age: number) {
    this.name = name;
    this.age = age;
  }
}

class Point {
  readonly x: number;
  constructor(x: number) {
    this.x = x;
  }
  [TO_ATOM](): unknown {
    return [S.Point, this.x];
  }
}

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("projecting a host value", () => {
  it("round-trips every registered type", () => {
    registerType(Person, {
      name: "Person",
      toAtom: (person) => [person.name, person.age],
      fromAtom: (name: string, age: number) => new Person(name, age),
    });
    const ada = new Person("Ada", 36);
    assert.equal(project(ada).text, '(Person "Ada" 36)');
    const back = build(project(ada)) as Person;
    assert.ok(back instanceof Person);
    assert.equal(back.name, "Ada");
    assert.equal(back.age, 36);
    assert.ok(isProjectable(ada));
    assert.ok(declarations().includes("Person"));
    assert.ok(unregisterType(Person));
  });

  it("a registration can be removed and its name reclaimed", () => {
    registerType(Person, { name: "Person", toAtom: () => [], fromAtom: () => new Person("", 0) });
    assert.ok(unregisterType(Person));
    assert.ok(!declarations().includes("Person"));
    // The name is free again, so another type may take it.
    class Other {}
    registerType(Other, { name: "Person", toAtom: () => [], fromAtom: () => new Other() });
    assert.ok(unregisterType(Other));
  });

  it("lets a type project itself, with no registration at all", () => {
    assert.equal(project(new Point(3)).text, "(Point 3)");
    assert.ok(isProjectable(new Point(3)));
  });

  it("projects arrays and plain objects structurally", () => {
    assert.equal(project([1, 2, 3]).text, "(1 2 3)");
    assert.equal(project({ a: 1 }).text, "(object (a 1))");
    assert.deepEqual(build(project({ a: 1, b: "two" })), { a: 1, b: "two" });
  });

  it("crosses an unregistered type by reference, which is what it always did", () => {
    const when = new Date(0);
    const atom = project(when);
    assert.equal(build(atom), when, "the very same object");
  });
});

describe("a table-backed space", () => {
  it("answers the union of every shape a schema admits", async () => {
    const tables = {
      edges: [{ a: "x", b: "y" }],
      links: [{ from: "y", to: "z" }],
    };
    const kb = m.attach(
      "&tabled1",
      tableSpace(arrayTables(tables), [
        bridge(S.edge(V.a, V.b), "edges", { a: V.a, b: V.b }),
        bridge(S.edge(V.a, V.b), "links", { from: V.a, to: V.b }),
      ]),
    );
    const held = (await kb.atoms()).map(String).sort();
    assert.deepEqual(held, ['(edge "x" "y")', '(edge "y" "z")']);
    // Both shapes answer one query, which is the equation reading one level up.
    assert.equal((await kb.match(S.edge(V.from, V.to)).toArray()).length, 2);
    // A bound position narrows: the source filters on it.
    assert.equal((await kb.match(S.edge("x", V.to)).toArray()).length, 1);
    m.detach("&tabled1");
  });

  it("refuses an add two shapes admit", async () => {
    const tables = { one: [] as Record<string, unknown>[], two: [] as Record<string, unknown>[] };
    const provider = tableSpace(arrayTables(tables), [
      bridge(S.thing(V.x), "one", { x: V.x }),
      bridge(S.thing(V.x), "two", { x: V.x }),
    ]);
    await assert.rejects(
      async () => provider.add?.(S.thing("a") as unknown as never),
      /admitted by 2 shapes/,
    );
  });

  it("writes a row through the shape that admits it", async () => {
    const tables = { edges: [] as Record<string, unknown>[] };
    const kb = m.attach(
      "&tabled2",
      tableSpace(arrayTables(tables), [bridge(S.edge(V.a, V.b), "edges", { a: V.a, b: V.b })]),
    );
    await kb.added(S.edge("p", "q"));
    assert.deepEqual(tables.edges, [{ a: "p", b: "q" }]);
    m.detach("&tabled2");
  });
});

describe("linting", () => {
  it("finds what it carries rules for, and changes nothing it looks at", async () => {
    const before = m.self.size;
    const findings = await lint(
      m,
      [
        "(= (twice $n) (* 2 $n))",
        "(= (twice $n) (* 2 $n))",
        "(= (unused $a $b) $a)",
        "(= (wrong $n) (twice $n $n))",
        "(: thing Widget)",
        "!(nothing-defines-this 1)",
      ].join("\n"),
    );
    const rules = findings.map((finding) => finding.rule);
    assert.ok(rules.includes("duplicate-equation"), rules.join(", "));
    assert.ok(rules.includes("unused-variable"), rules.join(", "));
    assert.ok(rules.includes("arity-disagreement"), rules.join(", "));
    assert.ok(rules.includes("undeclared-type"), rules.join(", "));
    assert.ok(rules.includes("unknown-head"), rules.join(", "));
    assert.ok(findings[0] instanceof Finding);
    assert.match(String(findings[0]), /^form \d+: /);
    assert.equal(m.self.size, before, "linting stored nothing");
  });

  it("an ok comment suppresses only its own rule", async () => {
    const source = [
      "(= (unused $a $b) $a)",
      "; metta: ok(unused-variable)",
      "(= (other $c $d) $c)",
    ].join("\n");
    const findings = await lint(m, source, { rules: ["unused-variable"] });
    assert.equal(findings.length, 1, findings.map(String).join("; "));
    assert.match(findings[0]?.text ?? "", /unused/);
  });

  it("runs only the rules it was asked for", async () => {
    const findings = await lint(m, "(= (twice $n) (* 2 $n))\n(= (twice $n) (* 2 $n))", {
      rules: ["unused-variable"],
    });
    assert.deepEqual(findings, []);
    assert.equal(RULES.length, 5);
  });
});

describe("integrating a library", () => {
  it("installs and uninstalls an integration completely", async () => {
    const installed = await integrate(m, {
      name: "clock",
      install: (surface) => {
        moduleOps(surface, { fixedNow: () => 1234 }, { prefix: "clock" });
      },
    });
    assert.ok(installed instanceof Installed);
    assert.equal(await m.eval(S["clock-fixed-now"]()).one().then(String), "1234");
    assert.ok(m.catalog.has(S.integration(S.clock)));

    await installed.remove();
    assert.ok(!m.catalog.has(S.integration(S.clock)));
    // The operation is gone: the head no longer reduces.
    assert.equal(String(await m.eval(S["clock-fixed-now"]()).one()), "(clock-fixed-now)");
  });

  it("leaves nothing behind when an install fails", async () => {
    const before = m.engine.operations().length;
    await assert.rejects(() =>
      integrate(m, {
        name: "broken",
        install: (surface) => {
          moduleOps(surface, { halfInstalled: () => 1 }, { prefix: "broken" });
          throw new Error("the second half failed");
        },
      }),
    );
    assert.equal(m.engine.operations().length, before, "what it registered came back out");
  });

  it("binds an object's own methods, keeping the receiver", async () => {
    class Counter {
      #at = 40;
      bump(by: number): number {
        this.#at += by;
        return this.#at;
      }
    }
    const installed = await integrate(m, {
      name: "counter",
      install: (surface) => {
        objectOps(surface, new Counter(), { prefix: "ctr" });
      },
    });
    assert.equal(String(await m.eval(S["ctr-bump"](2)).one()), "42");
    await installed.remove();
  });

  it("refuses a module with no name to record it under", async () => {
    await assert.rejects(() => integrate(m, { installMetta: () => undefined }), /needs a name/);
  });
});

describe("numeric arrays", () => {
  it("crosses by reference, with identity", async () => {
    installArrays(m);
    const scores = new Float64Array([3, 1, 4, 1, 5]);
    assert.ok(isArray(scores));
    assert.equal(dtypeOf(scores), "float64");
    assert.equal(String(await m.eval(S["array-size"](G(scores))).one()), "5");
    assert.equal(String(await m.eval(S["array-max"](G(scores))).one()), "5");
    assert.equal(String(await m.eval(S["array-sum"](G(scores))).one()), "14");
    // The array itself never crossed: the engine held a reference.
    assert.equal(scores.length, 5);
  });

  it("never writes into an array it was given", () => {
    const held = new Int32Array([1, 2, 3]);
    const copy = ARRAY_OPS.arraySlice(held, 0, 2);
    (copy as Int32Array)[0] = 99;
    assert.equal(held[0], 1, "the slice is a copy");
  });

  it("prints as what it is", () => {
    assert.equal(String(G(new Float32Array(4))), "(array float32 4)");
    assert.equal(String(G(new Tensor(new Float64Array(6), [2, 3]))), "(tensor float64 2 3)");
  });

  it("reads a shape over the same elements", () => {
    const tensor = new Tensor(new Float64Array([1, 2, 3, 4, 5, 6]), [2, 3]);
    assert.equal(tensor.rank, 2);
    assert.equal(tensor.size, 6);
    assert.equal(tensor.at(1, 2), 6);
    assert.equal(tensor.type.text, "(Tensor float64 2 3)");
    const flat = tensor.reshape(6);
    assert.equal(flat.data, tensor.data, "a reshape shares the elements");
    assert.throws(() => tensor.at(0));
    assert.throws(() => tensor.at(9, 9));
    assert.throws(() => new Tensor(new Float64Array(5), [2, 3]));
  });

  it("takes the k best without sorting everything", () => {
    const scores = new Float64Array([3, 9, 1, 9, 7]);
    // Best first, ties by position.
    assert.deepEqual(topIndices(scores, 3), [1, 3, 4]);
    assert.deepEqual(topIndices(scores, 0), []);
    assert.equal(topIndices(scores, 99).length, 5);
  });
});

describe("a manifest", () => {
  it("reports every problem before anything performs", async () => {
    const before = m.self.size;
    await assert.rejects(
      () =>
        boot(
          ['(boot (load 7))', "(boot (nonsense))", "!(this-runs)"].join("\n"),
          { metta: m },
        ),
      (error: unknown) => {
        const said = String(error);
        assert.match(said, /load takes one string path/);
        assert.match(said, /unknown boot form/);
        assert.match(said, /a manifest declares, it does not run/);
        return true;
      },
    );
    assert.equal(m.self.size, before, "a bad manifest changed nothing");
    assert.deepEqual(VOCABULARY, ["load", "attach", "bridge", "serve"]);
  });

  it("records every form it performed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "metta-manifest-"));
    const rules = join(directory, "rules.metta");
    writeFileSync(rules, "(= (from-manifest) 42)\n");
    const assembled = await boot(
      [`(boot (load "${rules}"))`, "(boot (bridge &manifested (edge $a $b) (kv $a $b)))"].join("\n"),
      { metta: m },
    );
    assert.equal(assembled.performed.length, 2);
    assert.equal(String(await m.eval(S["from-manifest"]()).one()), "42");
    // The deployment is knowledge: each form is in the space it booted.
    const recorded = await m.match(S.boot(V.what)).toArray();
    assert.ok(recorded.length >= 2, `${String(recorded.length)} boot atoms`);
    await assembled.close();
  });

  it("refuses a manifest that declares nothing", async () => {
    await assert.rejects(() => boot("", { metta: m }), /declares nothing/);
  });
});

describe("the tabled views", () => {
  it("closes a relation over its own atoms", async () => {
    const kb = fresh();
    kb.add(S.imports(S.app, S.core), S.imports(S.core, S.libc));
    const deps = await ClosureView.open(m, kb, "imports");
    assert.ok(await deps.holds(S.app, S.libc), "the closure reaches two hops");
    assert.ok(!(await deps.holds(S.libc, S.app)));
    const reachable = [...(await deps.reachable(S.app))].map(String).sort();
    assert.deepEqual(reachable, ["core", "libc"]);
    assert.match(String(deps), /^ClosureView\(imports on /);
  });

  it("terminates on a cycle, which is what tabling buys", async () => {
    const kb = fresh();
    kb.add(S.calls(S.a, S.b), S.calls(S.b, S.a));
    const cycle = await ClosureView.open(m, kb, "calls");
    // Without tabling this walk never returns; with it, it settles.
    assert.ok(await cycle.holds(S.a, S.a));
    assert.equal((await cycle.reachable(S.a)).size, 2);
  });

  it("caches a computed function in the engine's own table", async () => {
    m.run("(= (square $n) (* $n $n))");
    const squares = await TabledMap.open(m, m.self, "square", { arity: 1 });
    assert.equal(String(await squares.get(7)), "49");
    assert.ok(await squares.has(7));
    const stats = await squares.stats();
    assert.equal(typeof stats.tables, "number");
    assert.equal(typeof stats.answers, "number");
    //  is asynchronous, so a bad key REJECTS rather than throwing.
    await assert.rejects(() => squares.get(1, 2), /takes 1 argument/);
    squares.clear(m);
    assert.match(String(squares), /^TabledMap\(square\/1 on /);
  });
});
