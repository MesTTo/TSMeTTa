/**
 * Purpose: the ergonomic surface — the lazy answer helpers, the
 *   lazy paths into a live host value, the strategy names, the module tier and
 *   the presentation hook.
 * Guarantees:
 *   - every helper on an ask stays LAZY, so a `take` never computes the rest
 *   - importing the module tier boots nothing
 *   - successive cancellation constraints compose, so adding a signal cannot
 *     discard an ask's existing deadline
 *     [tested: "composes successive cancellation signals instead of replacing the first";
 *     commit=0fc1435242a699749fdd6ba3995239648c02242e]
 *   - negative answer positions use a circular tail and every position follows
 *     `Array.prototype.at` coercion [tested: "keeps a circular tail with Array.at index coercion";
 *     commit=WORKTREE]
 *   - an `undefined` answer still exists, unsupported chunk sizes narrow by
 *     `UnsupportedError`, and the documented helper family executes
 *     [tested: "finds an undefined answer by iterator completion";
 *     "classifies invalid chunk sizes as unsupported";
 *     "drops, flat-maps, and reduces answers"; commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { inspect } from "node:util";
import { after, before, describe, it } from "node:test";

import { type MeTTa, S, UnsupportedError, V, answersOf, metta } from "../src/index.ts";
import { Path, attr, installPaths, key, path, pathOf, reach } from "../src/paths.ts";
import { All, Choice, Id, Seq, TopDown, Try } from "../src/strategies.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
  m.add(S.n(1), S.n(2), S.n(3), S.n(4), S.n(5));
});

after(() => {
  m.dispose();
});

describe("the lazy answer helpers", () => {
  it("reaches one answer by position without pulling the rest", async () => {
    let pulled = 0;
    const counted = answersOf("counted", [1, 2, 3, 4, 5]).tap(() => {
      pulled += 1;
    });
    assert.equal(await counted.at(0), 1);
    assert.equal(pulled, 1, "at(0) costs one answer");
    assert.equal(await counted.at(2), 3);
    assert.equal(await counted.at(-1), 5);
    assert.equal(await counted.at(-2), 4);
    assert.equal(await counted.at(9), undefined);
    assert.equal(await counted.last(), 5);
  });

  it("keeps a circular tail with Array.at index coercion", async () => {
    const answers = answersOf("positions", [1, 2, 3, 4, 5]);
    assert.equal(await answers.at(Number.NaN), 1);
    assert.equal(await answers.at(1.9), 2);
    assert.equal(await answers.at(-1.9), 5);
    assert.equal(await answers.at(Number.POSITIVE_INFINITY), undefined);
    assert.equal(await answers.at(Number.NEGATIVE_INFINITY), undefined);

    const originalShift = Array.prototype.shift;
    Array.prototype.shift = function noShiftAllowed(): never {
      throw new Error("Answers.at shifted its tail window");
    };
    try {
      assert.equal(await answersOf("tail", Array.from({ length: 5_000 }, (_, at) => at)).at(-1_000), 4_000);
    } finally {
      Array.prototype.shift = originalShift;
    }
  });

  it("finds an undefined answer by iterator completion", async () => {
    assert.equal(await answersOf("undefined", [undefined]).exists(), true);
    assert.equal(await answersOf<undefined>("empty", []).exists(), false);
  });

  it("keeps only the first of each distinct answer, lazily", async () => {
    const rows = answersOf("rows", [
      { who: "ada", n: 1 },
      { who: "ada", n: 2 },
      { who: "bob", n: 3 },
    ]);
    assert.deepEqual(
      (await rows.unique((row) => row.who).toArray()).map((row) => row.who),
      ["ada", "bob"],
    );
    // Atoms are interned, so the default key is the atom itself.
    assert.equal(await answersOf("atoms", [S.a.atom, S.a.atom, S.b.atom]).unique().count(), 2);
  });

  it("batches answers into runs, the last one short", async () => {
    const runs = await answersOf("runs", [1, 2, 3, 4, 5]).chunk(2).toArray();
    assert.deepEqual(runs, [[1, 2], [3, 4], [5]]);
  });

  it("classifies invalid chunk sizes as unsupported", () => {
    for (const size of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => answersOf("bad", [1]).chunk(size), UnsupportedError);
    }
  });

  it("drops, flat-maps, and reduces answers", async () => {
    const numbers = answersOf("numbers", [1, 2, 3, 4]);
    assert.deepEqual(await numbers.drop(2).toArray(), [3, 4]);
    assert.deepEqual(await numbers.flatMap((value) => [value, -value]).toArray(), [1, -1, 2, -2, 3, -3, 4, -4]);
    assert.equal(await numbers.reduce((total, value) => total + value, 0), 10);
  });

  it("collects into a map and into groups", async () => {
    const rows = answersOf("rows", [
      { who: "ada", n: 1 },
      { who: "bob", n: 2 },
      { who: "ada", n: 3 },
    ]);
    const byWho = await rows.toMap(
      (row) => row.who,
      (row) => row.n,
    );
    assert.deepEqual([...byWho.entries()], [["ada", 3], ["bob", 2]]);
    const grouped = await rows.groupBy((row) => row.who);
    assert.deepEqual(grouped.get("ada")?.map((row) => row.n), [1, 3]);
    assert.deepEqual([...grouped.keys()], ["ada", "bob"]);
  });

  it("becomes a Web stream, with the cursor closed on cancel", async () => {
    const stream = m.match(S.n(V.x)).stream();
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    await reader.cancel();
    // The whole set, through the platform's own collector.
    const all = await Array.fromAsync(m.match(S.n(V.x)));
    assert.equal(all.length, 5);
  });

  it("bounds an ask with a deadline in milliseconds", async () => {
    const bounded = m.match(S.n(V.x)).timeout(5_000);
    assert.equal((await bounded).length, 5);
  });

  it("composes successive cancellation signals instead of replacing the first", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const reason = new Error("the first deadline elapsed");
    first.abort(reason);

    await assert.rejects(
      () => answersOf("bounded", [1]).until(first.signal).until(second.signal).toArray(),
      (error: unknown) => error === reason,
    );
  });
});

describe("lazy paths into a live host value", () => {
  it("reaches a named field and a subscript", () => {
    const person = { profile: { age: 36 }, rows: [{ id: 7 }] };
    assert.equal(reach(person, path("profile", "age")), 36);
    assert.equal(reach(person, path("rows", 0, "id")), 7);
    assert.equal(reach(person, path("profile", "missing")), undefined);
    assert.equal(reach(person, path("rows", 9, "id")), undefined);
    assert.equal(reach(new Map([["k", 1]]), path(key("k"))), 1);
  });

  it("composes without mutating what it came from", () => {
    const profile = path("profile");
    const age = profile.then("age");
    assert.equal(profile.segments.length, 1);
    assert.equal(age.segments.length, 2);
    assert.equal(String(age), ".profile.age");
    assert.throws(() => new Path([]));
    assert.throws(() => attr(""));
  });

  it("ends a cyclic reach rather than looping", () => {
    const loop: Record<string, unknown> = {};
    loop["self"] = loop;
    // Every step is checked against the identities already seen, so this
    // answers nothing instead of walking forever.
    assert.equal(reach(loop, path("self", "self")), undefined);
  });

  it("crosses as an atom the engine reads back", () => {
    const walk = path("profile", 0);
    const atom = walk.atom;
    assert.equal(atom.text, '(segments (attr "profile") (key 0))');
    assert.equal(String(pathOf(atom)), String(walk));
  });

  it("reaches through a live value from inside a reduction", async () => {
    installPaths(m);
    const person = { profile: { age: 36 } };
    const answers = await m
      .eval(S["path-at"](person, path("profile", "age").atom))
      .toArray();
    assert.deepEqual(answers.map(String), ["36"]);
    // A reach that fails prunes its branch rather than raising.
    assert.equal((await m.eval(S["path-at"](person, path("nope").atom)).toArray()).length, 0);
  });
});

describe("the strategy names", () => {
  it("reifies the strategies without an engine", () => {
    assert.equal(String(Id), "id");
    assert.equal(String(Try), "try");
    assert.equal(String(All), "all");
    assert.equal(String(TopDown), "topdown");
    // Calling one builds the plan as an ordinary atom.
    assert.equal(Seq(Try(Id), All(Id)).text, "(seq (try id) (all id))");
    assert.equal(Choice(Id, All(Id)).text, "(choice id (all id))");
  });
});

describe("presentation", () => {
  it("prints every handle as what it is", () => {
    assert.equal(inspect(S.parent(S.tom, S.bob)), "(parent tom bob)");
    assert.equal(inspect(m.self), "Space(&self)");
    assert.equal(inspect(m), "MeTTa(&self)");
    assert.match(inspect(m.match(S.n(V.x))), /^Answers\(match\(&self/);
    assert.match(inspect(m.state(S.rest)), /^State\(/);
    assert.match(inspect(m.stats()), /^Stats\(inferences=/);
  });
});
