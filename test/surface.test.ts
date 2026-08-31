/**
 * Purpose: the surface's own tests against a live engine: spaces as
 *   collections, rows keyed by their own variable names, the scopes, worlds,
 *   state cells, watches, schemas and the library tier.
 * Guarantees:
 *   - a binding row survives a bound value that names a function, which a bare
 *     tuple template would have reduced [measured 2026-08-27]
 *   - a world's restore leaves its parent exactly as it was
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  type Library,
  type MeTTa,
  MettaError,
  S,
  Space,
  SpaceHandle,
  Sym,
  V,
  arrow,
  hostValue,
  metta,
  space,
  sym,
} from "../src/index.ts";

let m: MeTTa;
let counter = 0;

const fresh = (): Space => {
  counter += 1;
  return m.space(`&t${String(counter)}`);
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("a space is a collection", () => {
  it("means by add, delete, has, size and clear what Set means", () => {
    const kb = fresh();
    assert.equal(kb.size, 0);
    assert.equal(kb.add(S.parent(S.tom, S.bob)), kb, "add answers the space, as Set.add does");
    kb.add(S.parent(S.bob, S.ann));
    assert.equal(kb.size, 2);
    assert.ok(kb.has(S.parent(S.tom, S.bob)));
    assert.ok(kb.has(S.parent(V.x, S.bob)), "a pattern asks the same question");
    assert.ok(!kb.has(S.parent(S.zoe, S.bob)));
    assert.ok(kb.delete(S.parent(S.tom, S.bob)), "delete answers whether anything went");
    assert.ok(!kb.delete(S.parent(S.tom, S.bob)));
    assert.equal(kb.size, 1);
    kb.clear();
    assert.equal(kb.size, 0);
  });

  it("walks its own atoms without evaluating them", async () => {
    const kb = fresh();
    kb.add(S.twice(2), S.twice(3));
    m.run("(= (twice $n) (* $n 2))");
    const held = (await kb.atoms()).map(String).sort();
    assert.deepEqual(held, ["(twice 2)", "(twice 3)"], "a stored atom is data, not a call");
  });

  it("is an atom, so it goes into a term", () => {
    const kb = fresh();
    assert.ok(kb.handle instanceof SpaceHandle);
    assert.equal(String(S.holds(kb.handle)), `(holds ${kb.name})`);
  });

  it("names a parametric space by a whole atom", () => {
    const one = m.space(S.cache(S.primary, 100));
    const two = m.space(S.cache(S.primary, 200));
    assert.notEqual(one.name, two.name);
    assert.equal(m.space(S.cache(S.primary, 100)), one, "one name is one space");
  });
});

describe("rows", () => {
  it("are keyed by the pattern's own variable names", async () => {
    const kb = fresh();
    kb.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann));
    const rows = await kb.match(S.parent(V.older, V.younger));
    assert.equal(rows.length, 2);
    const pairs = rows.map((row) => `${String(row["older"])}->${String(row["younger"])}`).sort();
    assert.deepEqual(pairs, ["bob->ann", "tom->bob"]);
  });

  it("destructure by name", async () => {
    const kb = fresh();
    kb.add(S.parent(S.tom, S.bob));
    for await (const { older } of kb.match(S.parent(V.older, S.bob))) {
      assert.equal(older, sym("tom"));
    }
  });

  it("carry ATOMS, so an answer composes back into the next term", async () => {
    const kb = fresh();
    kb.add(S.parent(S.tom, S.bob));
    const edges = await kb.match(S.parent(V.x, V.y)).map(({ x, y }) => S.edge(x, y));
    assert.deepEqual(edges.map(String), ["(edge tom bob)"]);
  });

  it("survive a bound value that names a function", async () => {
    // The trap this exists for: a bare tuple template is EVALUATED, so with
    // `twice` defined, `(match &kb (uses $f $n) ($f $n))` answers 6 rather than
    // the row. The row rides in a `quote`, whose argument does not reduce.
    const kb = fresh();
    m.run("(= (twice $n) (* $n 2))");
    kb.add(S.uses(S.twice, 3));
    const rows = await kb.match(S.uses(V.f, V.n));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!["f"], sym("twice"));
    assert.equal(hostValue(rows[0]!["n"] as never), 3);
  });

  it("answer an empty row for a ground pattern that matches", async () => {
    const kb = fresh();
    kb.add(S.parent(S.tom, S.bob));
    assert.deepEqual(await kb.match(S.parent(S.tom, S.bob)), [{}]);
    assert.deepEqual(await kb.match(S.parent(S.zoe, S.bob)), []);
  });

  it("take a template instead, and then the template is evaluated", async () => {
    const kb = fresh();
    kb.add(S.n(2), S.n(3));
    const doubled = await kb.match(S.n(V.x), S["*"](V.x, 2));
    assert.deepEqual(doubled.map(String).sort(), ["4", "6"]);
  });
});

describe("scopes", () => {
  it("counts what a block cost, and freezes the count when it ends", async () => {
    let frozen = 0;
    {
      using s = m.stats();
      await m.eval(S["+"](1, 1)).one();
      assert.ok(s.inferences > 0, "no inferences were counted");
      assert.ok(s.crossings > 0, "no crossings were counted");
      frozen = s.inferences;
    }
    await m.eval(S["+"](2, 2)).one();
    assert.ok(frozen > 0);
  });

  it("bounds what a job may spend, and pops the bound at the end of the block", async () => {
    {
      using _limit = m.limits({ stack: 400_000_000 });
      assert.equal(String(await m.eval(S["+"](1, 1)).one()), "2");
    }
    assert.equal(String(await m.eval(S["+"](1, 1)).one()), "2");
  });

  it("discards what a speculation wrote", async () => {
    const kb = fresh();
    await m.speculate(S["add-atom"](kb.handle, S.ghost())).toArray();
    assert.equal(kb.size, 0, "a speculation kept its write");
  });
});

describe("a restricted space", () => {
  it("keeps ordinary computation and its own equations", async () => {
    const locked = m.space(S.locked, { grants: [] });
    locked.add(m.parse("(= (double $x) (* $x 2))"));
    assert.equal(String(await locked.eval(S.double(21)).one()), "42");
  });

  it("refuses a capability it was not granted, naming the capability and the remedy", async () => {
    const sealed = m.space(S.sealed, { grants: [] });
    await assert.rejects(
      () => sealed.eval(S.exists_file("package.json")).toArray(),
      (error: MettaError) =>
        /does not publish the file capability/.test(error.message) &&
        /grant it explicitly/.test(error.message),
    );
  });

  it("runs the same goal when the capability was granted", async () => {
    // A name and creation OPTIONS compose freely here, which the Python side
    // records as a gap it wanted closed: `m.space(S.reader, { grants: [...] })`
    // is one door for both.
    const reader = m.space(S.reader, { grants: ["file"] });
    // A path the engine's own virtual filesystem carries: boot mounts this
    // package's bridge there, and the host's cwd is not in that filesystem at
    // all, so asking about one proves only that nothing refused.
    assert.deepEqual(
      (await reader.eval(S.exists_file("/metta/bridge.pl"))).map(String),
      ["true"],
    );
    assert.deepEqual(
      (await reader.eval(S.exists_file("/metta/nothing-here"))).map(String),
      ["false"],
      "the capability let it run and it answered truthfully",
    );
  });
});

describe("a child space", () => {
  it("reads through its parent and writes locally, which is what a world rides on", async () => {
    const parent = fresh();
    const child = fresh();
    parent.add(S.fromParent(1));
    child.readsThrough(parent);
    child.add(S.fromChild(2));
    assert.equal((await child.match(S.fromParent(V.n))).length, 1, "the child cannot see the parent");
    assert.equal((await child.match(S.fromChild(V.n))).length, 1);
    assert.equal((await parent.match(S.fromChild(V.n))).length, 0, "a local write reached the parent");
  });
});

describe("a world", () => {
  it("drafts, and commit applies the whole delta", async () => {
    const kb = fresh();
    kb.add(S.todo(1, S.active));
    const w = m.world(kb);
    w.add(S.todo(2, S.active));
    assert.equal((await w.match(S.todo(V.id, S.active))).length, 2, "the draft sees both");
    assert.equal(kb.size, 1, "the parent has not been touched");
    w.commit();
    assert.equal(kb.size, 2);
  });

  it("restores by throwing the draft away, so there is nothing to undo", async () => {
    const kb = fresh();
    kb.add(S.todo(1, S.active));
    const w = m.world(kb);
    w.add(S.todo(2, S.active));
    w.restore();
    assert.equal(kb.size, 1);
  });

  it("restores when the block is left, whatever left it", () => {
    const kb = fresh();
    kb.add(S.todo(1, S.active));
    try {
      using w = m.world(kb);
      w.add(S.todo(2, S.active));
      throw new Error("something went wrong");
    } catch {
      // The world disposed on the way out.
    }
    assert.equal(kb.size, 1);
  });

  it("journals a removal and applies it at commit", async () => {
    const kb = fresh();
    kb.add(S.todo(1, S.active));
    const w = m.world(kb);
    w.remove(S.todo(1, S.active));
    w.add(S.todo(1, S.done));
    assert.equal(
      (await w.match(S.todo(V.id, S.active))).length,
      0,
      "the world's own read honours the journal",
    );
    assert.equal(kb.size, 1, "the parent still holds it, which is what makes restore free");
    w.commit();
    const after = (await kb.atoms()).map(String);
    assert.deepEqual(after, ["(todo 1 done)"]);
  });

  it("refuses a second settlement, by code", () => {
    const w = m.world(fresh());
    w.commit();
    assert.throws(
      () => w.add(S.late()),
      (error: MettaError) => error.code === "ERR_METTA_CLOSED",
    );
  });
});

describe("a state cell", () => {
  it("answers itself on write, as Map.set does", () => {
    const cell = m.state(S.rest);
    assert.equal(String(cell.value), "rest");
    assert.equal(String(cell.set(S.active).value), "active");
    assert.equal(cell.set(S.rest), cell, "set answers the cell");
  });

  it("reads, transforms and writes in one step", () => {
    const cell = m.state(1);
    cell.update((current) => Number(hostValue(current)) + 1);
    assert.equal(hostValue(cell.value), 2);
  });
});

describe("watching a space", () => {
  it("answers admissions as they happen", async () => {
    const kb = fresh();
    const seen: string[] = [];
    const watching = (async (): Promise<void> => {
      for await (const admission of kb.watch(S.todo(V.id, V.state), { pollMs: 1 })) {
        seen.push(`${admission.edge} ${String(admission.atom)}`);
        if (seen.length === 2) break;
      }
    })();
    await new Promise((resume) => setTimeout(resume, 20));
    kb.add(S.todo(1, S.active));
    kb.add(S.todo(2, S.active));
    kb.add(S.other(3));
    await watching;
    assert.deepEqual(seen, ["add (todo 1 active)", "add (todo 2 active)"]);
  });

  it("reports removals when asked for that edge", async () => {
    const kb = fresh();
    kb.add(S.gone(1));
    const seen: string[] = [];
    const watching = (async (): Promise<void> => {
      for await (const admission of kb.watch(S.gone(V.n), { edges: ["remove"], pollMs: 1 })) {
        seen.push(`${admission.edge} ${String(admission.atom)}`);
        break;
      }
    })();
    await new Promise((resume) => setTimeout(resume, 20));
    kb.delete(S.gone(1));
    await watching;
    assert.deepEqual(seen, ["remove (gone 1)"]);
  });
});

describe("a schema", () => {
  it("declares vocabulary the engine holds and the types can read", async () => {
    const kb = m.schema({ ageOf: "(-> Symbol Number)" });
    assert.deepEqual([...kb.names], ["ageOf"]);
    assert.equal(String(kb.typeOf("ageOf")), "(-> Symbol Number)");
    const declared = await m.match(S[":"](S.ageOf, V.t));
    assert.equal(String(declared[0]?.["t"]), "(-> Symbol Number)");
  });

  it("refuses a declaration that is not one term, by name", () => {
    assert.throws(() => m.schema({ bad: "(-> Symbol" }), /missing a \)/);
    assert.throws(() => m.schema({ bad: "a b" }), /more than one term/);
  });

  it("builds the same arrow the word door builds", () => {
    const kb = m.schema({ pairOf: "(-> Symbol Symbol Pair)" });
    assert.equal(kb.typeOf("pairOf"), arrow(S.Symbol, S.Symbol, S.Pair));
  });
});

describe("the library tier", () => {
  it("installs both realms and records itself as data", async () => {
    const library: Library = {
      name: "greetings",
      version: "1.0.0",
      source: "(= (greet $who) (Hello $who))",
      grants: ["network"],
      vocabulary: ["greet"],
    };
    m.use(library);
    assert.equal(String(await m.eval(S.greet(S.world)).one()), "(Hello world)");
    const loaded = await m.catalog.match(S.library(V.name, V.version));
    assert.ok(loaded.some((row) => (row["name"] as Sym).name === "greetings"));
    const grants = await m.catalog.match(S["library-grant"](S.greetings, V.grant));
    assert.deepEqual(grants.map((row) => String(row["grant"])), ["network"]);
  });

  it("refuses a library whose artifact is absent, rather than failing later", () => {
    assert.throws(
      () => m.use({ name: "absent", present: () => false }),
      (error: MettaError) => error.code === "ERR_METTA_CAPABILITY",
    );
  });
});

describe("reflection", () => {
  it("names every space the engine has registered", () => {
    const kb = fresh();
    kb.add(S.something());
    assert.ok(m.spaces().includes(space(kb.name)));
    assert.ok(m.spaces().includes(space("&self")));
  });

  it("answers the engine's own account of how a match will be answered", () => {
    const kb = fresh();
    assert.match(kb.explain(S.parent(V.x, V.y)), /explain\(stored/);
  });

  it("answers an operation's declared effect class", () => {
    m.op(function pureThing(): number {
      return 1;
    }, { effect: "pureStructural" });
    assert.equal(m.effectOf("pureThing"), "pureStructural");
    assert.equal(m.effectOf("no-such-operation-here"), "unknown");
  });
});

describe("reconcile", () => {
  it("makes a space hold exactly the declared facts", async () => {
    const kb = fresh();
    kb.add(S.flag(1), S.flag(2), S.other(9));
    const report = await m.reconcile([S.flag(2), S.flag(3)], {
      scope: S.flag(V.n),
      space: kb,
    });
    assert.deepEqual(report.removed.map(String), ["(flag 1)"]);
    assert.deepEqual(report.added.map(String), ["(flag 3)"]);
    const held = (await kb.atoms()).map(String).sort();
    assert.deepEqual(held, ["(flag 2)", "(flag 3)", "(other 9)"], "the scope was respected");
  });
});
