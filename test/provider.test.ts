/**
 * Purpose: spaces implemented in TypeScript, and the combinators over them.
 * Guarantees:
 *   - a provider's capabilities are derived from its methods, and the engine
 *     refuses what a provider does not implement
 *   - a live host collection is read afresh for every query, with no
 *     publication step
 *   - a multiset difference compares live host values by identity rather than
 *     by their shared rendering [tested: "distinguishes live host values by
 *     identity when diffing"; commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  type Atom,
  G,
  Match,
  MettaError,
  type MeTTa,
  S,
  type SpaceProvider,
  V,
  capabilitiesOf,
  hostValue,
  metta,
} from "../src/index.ts";
import { diff, mapped, objectView, overlay, readOnly, union, view } from "../src/spaces.ts";
import { checkSpaceProvider } from "../src/testing.ts";

let m: MeTTa;
let counter = 0;

const freshName = (): string => {
  counter += 1;
  return `&provided${String(counter)}`;
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("a space implemented in TypeScript", () => {
  it("derives its capabilities from its methods", () => {
    const readOnlyProvider: SpaceProvider = { *atoms() { yield S.a; } };
    assert.deepEqual(capabilitiesOf(readOnlyProvider), ["match", "enumerate"]);

    const writable: SpaceProvider = {
      *atoms() { yield S.a; },
      add() {},
      remove() { return true; },
      clear() {},
    };
    assert.deepEqual(capabilitiesOf(writable), [
      "match",
      "enumerate",
      "add",
      "remove",
      "clear",
    ]);

    // Subscribability is DECLARED, never derived: a store with add and remove
    // and no channel of its own cannot promise events.
    assert.ok(!capabilitiesOf(writable).includes("subscribe"));
    const announced: SpaceProvider = {
      ...writable,
      delivers: () => ["per-write-exactly", "ordered"] as const,
    };
    assert.ok(capabilitiesOf(announced).includes("subscribe"));

    // A matcher with no enumeration is matchable and not enumerable.
    const matcherOnly: SpaceProvider = { *match() { yield S.a; } };
    assert.deepEqual(capabilitiesOf(matcherOnly), ["match"]);
  });

  it("answers enumeration, matching and writes through the engine", async () => {
    const rows = new Map<string, number>([
      ["ada", 3],
      ["bob", 5],
    ]);
    const table: SpaceProvider = {
      *atoms() {
        for (const [who, score] of rows) yield S.kv(S(who), score);
      },
      add(atom: Atom) {
        const parts = (atom as { items?: readonly Atom[] }).items;
        if (parts !== undefined) rows.set(String(parts[1]), Number(hostValue(parts[2] as Atom)));
      },
      remove(atom: Atom) {
        const parts = (atom as { items?: readonly Atom[] }).items;
        return parts === undefined ? false : rows.delete(String(parts[1]));
      },
    };
    const name = freshName();
    const kb = m.attach(name, table);
    assert.deepEqual((await kb.atoms()).map(String), ["(kv ada 3)", "(kv bob 5)"]);
    const found = await kb.match(S.kv(V.who, V.n)).toArray();
    assert.deepEqual(
      found.map((row) => `${String(row["who"])}=${String(row["n"])}`),
      ["ada=3", "bob=5"],
    );
    // A bound position narrows: the engine unifies against what the provider
    // yields, so this is exact even though the provider filtered nothing.
    assert.deepEqual((await kb.match(S.kv(S.ada, V.n)).toArray()).map((r) => String(r["n"])), ["3"]);

    kb.add(S.kv(S.cy, 7));
    assert.equal(rows.get("cy"), 7);
    assert.ok(kb.delete(S.kv(S.ada, 3)));
    assert.ok(!rows.has("ada"));
    m.detach(name);
  });

  it("refuses a capability the provider does not implement, in its own words", async () => {
    const frozen: SpaceProvider = {
      *atoms() {
        yield S.locked;
      },
      refusal: (capability) => `this catalogue is published, so it cannot ${capability}`,
    };
    const name = freshName();
    const kb = m.attach(name, frozen);
    assert.deepEqual((await kb.atoms()).map(String), ["locked"]);
    assert.throws(() => kb.add(S.anything), (error: unknown) => {
      assert.ok(error instanceof MettaError);
      // The provider's own sentence reaches the caller, rather than a generic
      // "does not implement add".
      assert.match(String(error), /published/);
      return true;
    });
    m.detach(name);
  });

  it("passes its own conformance suite", async () => {
    const held: Atom[] = [];
    const store: SpaceProvider = {
      *atoms() {
        yield* held;
      },
      add(atom) {
        held.push(atom);
      },
      remove(atom) {
        const at = held.indexOf(atom);
        if (at < 0) return false;
        held.splice(at, 1);
        return true;
      },
    };
    const name = freshName();
    const kb = m.attach(name, store);
    const results = await checkSpaceProvider(kb, store, [S.sample(1), S.sample(2)]);
    assert.ok(results.length > 0);
    for (const each of results) assert.ok(each.ok, `${each.name}: ${each.detail ?? ""}`);
    m.detach(name);
  });
});

describe("the space combinators", () => {
  it("reads a live Map through the engine", async () => {
    const scores = new Map<string, number>([["ada", 3]]);
    const name = freshName();
    const live = m.attach(name, scores);
    assert.deepEqual((await live.atoms()).map(String), ["(kv ada 3)"]);
    // No publication step: the next query reads the object as it is now.
    scores.set("bob", 5);
    assert.equal((await live.match(S.kv(V.who, V.n)).toArray()).length, 2);
    // And a write through MeTTa reaches the Map.
    live.add(S.kv(S.cy, 7));
    assert.equal(scores.get("cy"), 7);
    m.detach(name);
  });

  it("views an array by index and a set by membership", async () => {
    const list = ["zero", "one"];
    const listName = freshName();
    const byIndex = m.attach(listName, list);
    assert.deepEqual((await byIndex.atoms()).map(String), ['(kv 0 "zero")', '(kv 1 "one")']);

    const members = new Set(["a", "b"]);
    const setName = freshName();
    const bySet = m.attach(setName, members);
    assert.deepEqual((await bySet.atoms()).map(String), ['"a"', '"b"']);
    m.detach(listName);
    m.detach(setName);
  });

  it("refuses a write through the engine's own capability rule", async () => {
    const source = view(new Map([["ada", 3]]));
    const name = freshName();
    const closed = m.attach(name, readOnly(source));
    assert.deepEqual((await closed.atoms()).map(String), ["(kv ada 3)"]);
    // `readOnly` implements no write method at all, so the refusal is the
    // engine's standing capability error rather than a check written here.
    assert.throws(() => closed.add(S.kv(S.bob, 5)));
    m.detach(name);
  });

  it("reads a union of two spaces as one", async () => {
    const left = view(new Map([["ada", 3]]));
    const right = view(new Map([["bob", 5]]));
    const name = freshName();
    const both = m.attach(name, union(left, right));
    assert.deepEqual((await both.atoms()).map(String).sort(), ["(kv ada 3)", "(kv bob 5)"]);
    assert.equal((await both.match(S.kv(V.who, V.n)).toArray()).length, 2);
    m.detach(name);
  });

  it("routes every write to an overlay's front layer", async () => {
    const front = new Map<string, number>();
    const back = new Map([["ada", 3]]);
    const name = freshName();
    const layered = m.attach(name, overlay(view(front), view(back)));
    layered.add(S.kv(S.bob, 5));
    assert.equal(front.get("bob"), 5);
    assert.equal(back.size, 1, "the back layer is never written");
    assert.equal((await layered.atoms()).length, 2);
    m.detach(name);
  });

  it("renames a shape through one declaration, both ways", async () => {
    const triples = new Map<string, number>([["ada", 1]]);
    const inner = view(triples);
    const name = freshName();
    const edges = m.attach(name, mapped(inner, [S.bridge, S.edge(V.a, V.b), S.kv(V.a, V.b)]));
    assert.deepEqual((await edges.atoms()).map(String), ["(edge ada 1)"]);
    assert.deepEqual((await edges.match(S.edge(V.who, V.n)).toArray()).map((r) => String(r["who"])), [
      "ada",
    ]);
    edges.add(S.edge(S.bob, 2));
    assert.equal(triples.get("bob"), 2);
    m.detach(name);
  });

  it("says how two spaces differ, as a multiset", async () => {
    const a = view(new Map([["ada", 1], ["bob", 2]]));
    const b = view(new Map([["bob", 2], ["cy", 3]]));
    const report = await diff(a, b);
    assert.deepEqual(report.onlyInFirst.map(String), ["(kv ada 1)"]);
    assert.deepEqual(report.onlyInSecond.map(String), ["(kv cy 3)"]);
  });

  it("distinguishes live host values by identity when diffing", async () => {
    const first = {};
    const second = {};
    assert.equal(G(first).text, G(second).text, "the fixture needs one shared rendering");

    const apart = await diff(view(new Set([first])), view(new Set([second])));
    assert.deepEqual(apart.onlyInFirst, [G(first)]);
    assert.deepEqual(apart.onlyInSecond, [G(second)]);

    const same = await diff(view(new Set([first])), view(new Set([first])));
    assert.deepEqual(same, { onlyInFirst: [], onlyInSecond: [] });
  });

  it("presents a live object's own fields, and writes them back", async () => {
    const person = { name: "Ada", age: 36 };
    const name = freshName();
    const fields = m.attach(name, objectView(person));
    const held = (await fields.atoms()).map((atom) => atom.text);
    assert.equal(held.length, 2);
    assert.ok(held.some((text) => text.includes("age") && text.includes("36")));
    person.age = 37;
    const now = await fields.match(S.field(V.who, S.age, V.value)).toArray();
    assert.equal(String(now[0]?.["value"]), "37");
    m.detach(name);
  });

  it("refuses a combinator given a name rather than a space", () => {
    assert.throws(
      () => union("&kb" as unknown as never),
      (error: unknown) => {
        assert.match(String(error), /a name alone carries no engine/);
        return true;
      },
    );
  });

  it("mentions a provider's own atoms in an ordinary reduction", async () => {
    const rows = new Map([["ada", 3]]);
    const name = freshName();
    const kb = m.attach(name, rows);
    // The point: the provider space is an ordinary operand, so a MeTTa
    // program reaches it by name like any other space.
    const found = await m.eval(Match(kb.handle, S.kv(V.who, V.n), V.who)).toArray();
    assert.deepEqual(found.map(String), ["ada"]);
    m.detach(name);
  });
});
