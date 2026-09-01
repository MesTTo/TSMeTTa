/**
 * Purpose: the structural operations that need no engine — unification,
 *   one-way matching, alpha-canonical keys, renaming — and the atom-keyed
 *   collections built on them.
 * Guarantees:
 *   - neither walk is recursive, so a term ten thousand deep is handled
 *   - `PatternMap`'s mapping protocol stays exact while `matching` answers the
 *     dispatch question
 *   - `MatchIndex` preserves registration order without sorting its already
 *     ordered registration map, and deletions preserve shared-prefix siblings
 *     [tested: "walks registration order without sorting";
 *     commit=fc5eb6ec4f780dd7abab83aa753a1277feddcd47]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  type Atom,
  G,
  S,
  V,
  alphaEqual,
  alphaKey,
  exprOf,
  isGround,
  matchTerms,
  renameVariables,
  sym,
  unifies,
  unifyTerms,
  variable,
} from "../src/index.ts";
import { AlphaSet, MatchIndex, PatternMap } from "../src/structures.ts";

describe("the host-side matcher", () => {
  it("unifies symmetrically, binding variables on either side", () => {
    assert.deepEqual(unifyTerms(S.f(1, V.y), S.f(V.x, 2)), { x: G(1), y: G(2) });
    assert.equal(unifyTerms(S.f(1), S.g(1)), undefined);
    assert.equal(unifyTerms(S.f(1), S.f(1, 2)), undefined);
    assert.ok(unifies(S.f(V.x), S.f(S.a)));
  });

  it("normalises an alias chain", () => {
    // x = y, y = a reports BOTH names bound to a, not x bound to y.
    const bound = unifyTerms(S.f(V.x, V.y), S.f(V.y, S.a));
    assert.deepEqual(bound, { x: S.a.atom, y: S.a.atom });
  });

  it("treats the anonymous variable as fresh at every occurrence", () => {
    assert.deepEqual(unifyTerms(S.f(V._, V._), S.f(1, 2)), {});
    assert.deepEqual(matchTerms(S.f(V._, V._), S.f(1, 2)), {});
    // A NAMED variable twice is nonlinear and constrains.
    assert.equal(matchTerms(S.f(V.x, V.x), S.f(1, 2)), undefined);
    assert.deepEqual(matchTerms(S.f(V.x, V.x), S.f(1, 1)), { x: G(1) });
  });

  it("matches one way: only the pattern's variables bind", () => {
    assert.deepEqual(matchTerms(S.parent(V.x, S.bob), S.parent(S.tom, S.bob)), {
      x: S.tom.atom,
    });
    // A variable in the SUBJECT is data, so a ground pattern does not fit it.
    assert.equal(matchTerms(S.parent(S.tom, V.y), S.parent(V.a, S.bob)), undefined);
  });

  it("binds variable names inherited by Object.prototype", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const bindings = matchTerms(S.f(variable(name)), S.f(S.a));
      assert.ok(bindings !== undefined && Object.hasOwn(bindings, name), `did not bind ${name}`);
      assert.equal(bindings[name], S.a.atom);
    }
  });

  it("unifies a term ten thousand deep", () => {
    // The ceiling C26 and C27 found in the pump and in `expr` must not be
    // reintroduced here: both walks are iterative.
    const deep = (leaf: Atom): Atom => {
      let built = leaf;
      for (let at = 0; at < 10_000; at += 1) built = exprOf([sym("f"), built]);
      return built;
    };
    const left = deep(variable("x"));
    const right = deep(G(1));
    assert.deepEqual(unifyTerms(left, right), { x: G(1) });
    assert.ok(!isGround(left));
    assert.ok(isGround(right));
  });

  it("keys a term by its shape, blind to variable spelling", () => {
    assert.equal(alphaKey(S.f(V.x, V.y)), alphaKey(S.f(V.a, V.b)));
    assert.notEqual(alphaKey(S.f(V.x, V.x)), alphaKey(S.f(V.a, V.b)));
    assert.ok(alphaEqual(S.f(V.x), S.f(V.y)));
    assert.ok(!alphaEqual(S.f(V.x), S.f(S.a)));
  });

  it("renames every variable at once, keeping the anonymous one alone", () => {
    const renamed = renameVariables(S.f(V.x, V.x, V._), (name) => `lib-${name}`);
    assert.equal(renamed.text, "(f $lib-x $lib-x $_)");
  });
});

describe("the atom-keyed collections", () => {
  it("answers the platform's own collection doors", () => {
    const seen = new AlphaSet([S.f(V.x)]);
    assert.ok(seen.has(S.f(V.y)));
    assert.ok(!seen.has(S.f(S.a)));
    assert.equal(seen.size, 1);
    assert.equal([...seen].length, 1);
    assert.equal(new Set(seen).size, 1);
    assert.equal(seen.toSet().size, 1);
    let visited = 0;
    seen.forEach(() => {
      visited += 1;
    });
    assert.equal(visited, 1);

    const map = new PatternMap<number>([[S.a, 1]]);
    const asRead: ReadonlyMap<Atom, number> = map;
    assert.equal(asRead.get(S.a.atom), 1);
    assert.deepEqual([...map.keys()].map(String), ["a"]);
    assert.deepEqual([...map.values()], [1]);
    assert.equal(Object.fromEntries([...map].map(([k, v]) => [String(k), v]))["a"], 1);
  });

  it("composes alpha sets without losing the blindness", () => {
    const a = new AlphaSet([S.f(V.x), S.g(S.one)]);
    const b = new AlphaSet([S.f(V.q)]);
    assert.equal(a.union(b).size, 2);
    assert.equal(a.intersection(b).size, 1);
    assert.ok(a.intersection(b).has(S.f(V.anything)));
    assert.equal(a.difference(b).size, 1);
    assert.equal(a.symmetricDifference(b).size, 1);
    assert.ok(b.isSubsetOf(a));
    assert.ok(a.isSupersetOf(b));
    assert.ok(!a.isDisjointFrom(b));
  });

  it("keeps the mapping protocol exact and the dispatch question separate", () => {
    const routes = new PatternMap<string>();
    routes.set(S.route(S.home), "home");
    routes.set(S.route(V.anything), "fallback");
    // The MAPPING protocol answers what was stored under that very key.
    assert.equal(routes.get(S.route(S.home)), "home");
    assert.equal(routes.get(S.route(V.other)), "fallback");
    assert.equal(routes.get(S.route(S.away)), undefined);
    // The DISPATCH question answers everything that applies.
    const applied = [...routes.matching(S.route(S.home))].map(([, value]) => value);
    assert.deepEqual(applied.sort(), ["fallback", "home"]);
    assert.deepEqual([...routes.matching(S.route(S.away))].map(([, v]) => v), ["fallback"]);
    assert.equal(routes.size, 2);
    assert.equal(routes.getOrInsert(S.route(S.new1), "made"), "made");
    assert.equal(routes.getOrInsertComputed(S.route(S.new1), () => "other"), "made");
  });

  it("answers in registration order", () => {
    const inbox = new MatchIndex<string>();
    inbox.add(S.order(V.id, S.express), "rush");
    inbox.add(S.order(V.id, V.mode), "any");
    inbox.add(S.other(V.x), "elsewhere");
    const found = [...inbox.matches(S.order(7, S.express))].map(([, value]) => value);
    assert.deepEqual(found, ["rush", "any"]);
    assert.equal(inbox.size, 3);
    // A removal does not let a later registration take a survivor's place.
    assert.ok(inbox.delete(S.order(V.id, S.express), "rush"));
    inbox.add(S.order(V.id, S.express), "rush2");
    assert.deepEqual(
      [...inbox.matches(S.order(7, S.express))].map(([, value]) => value),
      ["any", "rush2"],
    );
  });

  it("keeps a nonlinear pattern exact through the index", () => {
    const index = new MatchIndex<string>();
    index.add(S.pair(V.x, V.x), "same");
    index.add(S.pair(V.x, V.y), "any");
    assert.deepEqual([...index.matches(S.pair(1, 1))].map(([, v]) => v), ["same", "any"]);
    assert.deepEqual([...index.matches(S.pair(1, 2))].map(([, v]) => v), ["any"]);
  });

  it("reaches every entry when the probe itself carries variables", () => {
    const index = new MatchIndex<string>();
    index.add(S.edge(S.a, S.b), "ab");
    index.add(S.edge(S.b, S.c), "bc");
    assert.deepEqual([...index.matches(S.edge(S.a, V.to))].map(([, v]) => v), ["ab"]);
    assert.equal([...index.matches(S.edge(V.from, V.to))].length, 2);
  });

  it("walks registration order without sorting", () => {
    const index = new MatchIndex<string>();
    index.add(S.edge(S.a, S.b), "ab");
    index.add(S.edge(S.a, S.c), "ac");
    index.add(S.edge(S.d, S.e), "de");
    assert.ok(index.delete(S.edge(S.a, S.b), "ab"));
    index.add(S.edge(S.a, S.f), "af");

    const originalSort = Array.prototype.sort;
    Array.prototype.sort = function noSortAllowed(): never {
      throw new Error("MatchIndex re-sorted registration order");
    };
    try {
      assert.deepEqual([...index].map(([, value]) => value), ["ac", "de", "af"]);
      assert.deepEqual(
        [...index.matches(S.edge(V.from, V.to))].map(([, value]) => value),
        ["ac", "de", "af"],
      );
    } finally {
      Array.prototype.sort = originalSort;
    }

    // Removing one leaf under `(edge a ...)` must not detach its live sibling.
    assert.ok(index.delete(S.edge(S.a, S.f), "af"));
    assert.deepEqual([...index.matches(S.edge(S.a, S.c))].map(([, value]) => value), ["ac"]);

    // Repeated distinct-path churn must leave no stale registration visible.
    for (let at = 0; at < 1_000; at += 1) {
      const pattern = S.churn(at);
      index.add(pattern, `v${String(at)}`);
      assert.ok(index.delete(pattern, `v${String(at)}`));
    }
    assert.equal(index.size, 2);
    assert.deepEqual([...index].map(([, value]) => value), ["ac", "de"]);
  });
});
