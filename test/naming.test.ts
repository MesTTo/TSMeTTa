/**
 * Purpose: the naming map's own tests, and the doors that apply it. No engine.
 * Guarantees:
 *   - the map fires only where it can be right, and a spelling it would have
 *     mangled fails here rather than in a program that names nothing
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { S, V, _, fn, mapsExactly, mettaName, seg, sym, tsName, variable } from "../src/index.ts";

describe("the camelCase map", () => {
  it("images a lowerCamelCase identifier onto hyphens", () => {
    assert.equal(mettaName("carAtom"), "car-atom");
    assert.equal(mettaName("findDivisor"), "find-divisor");
    assert.equal(mettaName("balanceOf"), "balance-of");
    assert.equal(mettaName("fib"), "fib");
  });

  it("keeps a run of capitals as one word", () => {
    assert.equal(mettaName("loadHTTPUrl"), "load-httpurl");
  });

  it("fires only where it can be right", () => {
    // Every one of these is already spelled the way it means to be spelled, and
    // a naive camelCase map turns each into a name that denotes nothing.
    for (const exact of [
      "Number",
      "StateMonad",
      "%Undefined%",
      "prime?",
      "change-state!",
      "car-atom",
      "&self",
      "->",
      "_",
    ]) {
      assert.equal(mettaName(exact), exact, `the map changed ${exact}`);
      assert.ok(mapsExactly(exact));
    }
  });

  it("is idempotent, so the two doors meet at one atom", () => {
    for (const name of ["carAtom", "car-atom", "Number", "fib", "%Undefined%"]) {
      assert.equal(mettaName(mettaName(name)), mettaName(name));
    }
  });

  it("reads back the other way", () => {
    assert.equal(tsName("car-atom"), "carAtom");
    assert.equal(tsName("not-provable"), "notProvable");
    assert.equal(mettaName(tsName("find-divisor")), "find-divisor");
  });
});

describe("the symbol door", () => {
  it("meets the bracket door at one atom wherever both can spell a name", () => {
    assert.equal(S.carAtom.atom, S["car-atom"].atom);
    assert.equal(S.parent.atom, S("parent").atom);
    assert.equal(S.parent.atom, sym("parent"));
  });

  it("leaves a name the map cannot say exactly alone", () => {
    assert.equal(S.Number.atom, sym("Number"));
    assert.equal(S["%Undefined%"].atom, sym("%Undefined%"));
    assert.equal(S["prime?"].atom, sym("prime?"));
  });

  it("is bare data and applied is an expression", () => {
    assert.equal(String(S.parent.atom), "parent");
    assert.equal(String(S.parent(S.tom, S.bob)), "(parent tom bob)");
  });

  it("does not answer then, because a thenable namespace would be awaited", () => {
    assert.equal((S as unknown as Record<string, unknown>)["then"], undefined);
    assert.equal(String(S("then")), "then");
  });
});

describe("the variable door", () => {
  it("is exact, because a name is the key an answer is destructured by", () => {
    assert.equal(V.myThing, variable("myThing"));
    assert.equal(String(V.x), "$x");
    assert.equal(V.x, V("x"));
  });

  it("gives the anonymous variable its own spelling", () => {
    assert.equal(String(_), "$_");
  });
});

describe("the word door", () => {
  it("treats inherited object names as ordinary MeTTa names", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      assert.equal(String(fn[name]), mettaName(name));
    }
    assert.equal(String(fn), "fn");
    assert.equal(String(S), "S");
    assert.equal(String(V), "V");
  });

  it("reaches an operator's punctuation head, which no casing map could", () => {
    assert.equal(String(fn.add(1, 2)), "(+ 1 2)");
    assert.equal(String(fn.gte(1, 2)), "(>= 1 2)");
    assert.equal(String(fn.eq(1, 1)), "(== 1 1)");
    assert.equal(String(fn.pow(2, 8)), "(pow-math 2 8)");
  });

  it("maps every other name through TypeScript's own casing", () => {
    assert.equal(String(fn.carAtom(S.xs)), "(car-atom xs)");
    assert.equal(String(fn["change-state!"](S.c, 1)), "(change-state! c 1)");
  });
});

describe("segments", () => {
  it("builds the engine's own sequence-variable spelling", () => {
    assert.equal(String(seg(V.before)), "(:seg $before)");
    assert.equal(String(seg("after")), "(:seg $after)");
  });
});
