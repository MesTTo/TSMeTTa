/**
 * Purpose: tables shared by every ask of one instance on the WebAssembly host,
 *   whose engines run one at a time, and the parking that lets an ask wait for
 *   another ask to complete a table (Engine.park, and bridge.pl's
 *   prolog:tabling_wait/1 over the host's swi-threadless-shared-table-private-
 *   per-engine patch).
 * Guarantees:
 *   - a table outlives the ask that built it, so a later ask reads it and its
 *     statistics [tested: "keeps a table across asks"; commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 *   - a private table, and exact memoization, which keeps a private table,
 *     stay the ask's own, while bounded memoization outlives it [tested:
 *     "keeps a private table and exact memoization to their ask, and bounded
 *     memoization past it"; commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 *   - an ask that meets a table another ask is completing parks, and answers
 *     once that ask completes it, without running the table's body itself
 *     [tested: "parks an ask behind the ask completing its table";
 *     commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 *   - an owner that gives the table up hands it back, and the parked ask
 *     evaluates it itself [tested: "evaluates a table its owner gave up";
 *     commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 *   - the synchronous door, which has nobody to hand the thread to, refuses by
 *     name [tested: "refuses on the synchronous door rather than wait";
 *     commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 *   - two asks deadlocked over two tables resolve, the one that detects the
 *     cycle giving its table up and waiting its turn [tested: "resolves two
 *     asks deadlocked over two tables"; commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type Atom, Collapse, type MeTTa, S, V, metta } from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
  m.run("!(import! &self (library lib_tabling))");
});

after(() => {
  m.dispose();
});

/** A promise and the two functions that settle it. */
function gate(): { opened: Promise<void>; open: () => void; fail: (error: Error) => void } {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const opened = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { opened, open, fail };
}

/** A collapsed answer's members, as sorted text. */
function members(answer: Atom | undefined): string[] {
  assert.ok(answer !== undefined, "an answer");
  return String(answer)
    .replace(/^\(|\)$/g, "")
    .split(" ")
    .filter((item) => item !== "")
    .toSorted();
}

/** Let every job that can run reach its next suspension. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resume) => setImmediate(resume));
}

describe("a table on a host whose engines run one at a time", () => {
  it("keeps a table across asks", async () => {
    let calls = 0;
    m.op(function keptEdge(x: number): number {
      calls += 1;
      return x;
    });
    m.run(`
      !(add-atom &self (kept-link 1 2))
      !(add-atom &self (kept-link 2 3))
      (= (kept-reach $x $y) (match &self (kept-link $x $y) (kept-edge $y)))
      (= (kept-reach $x $z) (match &self (kept-link $x $y) (kept-reach $y $z)))
      !(tabled (kept-reach $x $y))
    `);
    assert.deepEqual(members(await m.eval(Collapse(S["kept-reach"](1, V.y))).one()), ["2", "3"]);
    assert.deepEqual(members(await m.eval(Collapse(S["kept-reach"](1, V.y))).one()), ["2", "3"]);
    // Two links, each read once, by the first ask alone.
    assert.equal(calls, 2);
    const stats = String(await m.eval(S["table-stats"](S["kept-reach"](V.x, V.y))).one());
    assert.match(stats, /\(tables [1-9]/);
  });

  it("keeps a private table and exact memoization to their ask, and bounded memoization past it", async () => {
    let privateRuns = 0;
    m.op(function ownPrivateEdge(x: number): number {
      privateRuns += 1;
      return x;
    });
    m.run(`
      !(import! &self (library lib_memo))
      (= (own-private $x) (own-private-edge $x))
      !(add-atom &metta (cache own-private (plain private)))
      (= (own-exact $x) (* $x $x))
      (= (own-bounded $x) (+ $x $x))
      !(memoize-exact own-exact)
      !(memoize own-bounded)
    `);
    // Two calls in each of two asks: the table answers the second call of an
    // ask, and a later ask builds its own.
    const twice = S.let(V.a, S["own-private"](7), S["own-private"](7));
    for (let ask = 0; ask < 2; ask += 1) assert.equal(String(await m.eval(twice).one()), "7");
    assert.equal(privateRuns, 2);
    // lib_memo answers through its own counters, over bodies that call nothing.
    const stats = async (name: string): Promise<string> =>
      String(await m.eval(S["get-memoize-stats"](S[name])).one());
    const filled = S.let(V.a, S["own-exact"](7), S.let(V.b, S["own-bounded"](7), S["get-memoize-stats"](S["own-exact"])));
    assert.equal(String(await m.eval(filled).one()), "((entries 1) (answers 1))");
    // Exact memoization keeps a private table, so it is the filling ask's; a
    // bounded cache lives in the engine's database, which every ask shares.
    assert.equal(await stats("own-exact"), "((entries 0) (answers 0))");
    assert.equal(await stats("own-bounded"), "((entries 1) (answers 1))");
  });

  it("parks an ask behind the ask completing its table", async () => {
    const reached = gate();
    const release = gate();
    let calls = 0;
    m.op(async function slowEdge(x: number): Promise<number> {
      calls += 1;
      reached.open();
      await release.opened;
      return x;
    });
    m.run(`
      !(add-atom &self (slow-link 1 2))
      !(add-atom &self (slow-link 2 3))
      (= (slow-reach $x $y) (match &self (slow-link $x $y) (slow-edge $y)))
      (= (slow-reach $x $z) (match &self (slow-link $x $y) (slow-reach $y $z)))
      !(tabled (slow-reach $x $y))
    `);
    const first = m.eval(Collapse(S["slow-reach"](1, V.y))).one();
    await reached.opened; // the first ask owns the table, suspended at its host op
    const second = m.eval(Collapse(S["slow-reach"](1, V.y))).one();
    await settle();
    assert.equal(calls, 1, "the second ask parks rather than evaluate the table");
    release.open();
    const [one, two] = await Promise.all([first, second]);
    assert.deepEqual(members(one), ["2", "3"]);
    assert.deepEqual(members(two), ["2", "3"]);
    assert.equal(calls, 2);
  });

  it("evaluates a table its owner gave up", async () => {
    const reached = gate();
    const refused = gate();
    let calls = 0;
    m.op(async function flakyEdge(x: number): Promise<number> {
      calls += 1;
      if (calls === 1) {
        reached.open();
        await refused.opened;
      }
      return x;
    });
    m.run(`
      !(add-atom &self (flaky-link 1 2))
      (= (flaky-reach $x $y) (match &self (flaky-link $x $y) (flaky-edge $y)))
      !(tabled (flaky-reach $x $y))
    `);
    const first = m.eval(Collapse(S["flaky-reach"](1, V.y))).one();
    await reached.opened;
    const second = m.eval(Collapse(S["flaky-reach"](1, V.y))).one();
    await settle();
    // The owner's host op fails, its leader unwinds, and the table it owned
    // is fresh again for the ask that was waiting on it.
    refused.fail(new Error("the link went away"));
    await assert.rejects(first, /the link went away/);
    assert.deepEqual(members(await second), ["2"]);
    assert.equal(calls, 2);
  });

  it("refuses on the synchronous door rather than wait", async () => {
    const reached = gate();
    const release = gate();
    m.op(async function lateEdge(x: number): Promise<number> {
      reached.open();
      await release.opened;
      return x;
    });
    m.run(`
      !(add-atom &self (late-link 1 2))
      (= (late-reach $x $y) (match &self (late-link $x $y) (late-edge $y)))
      !(tabled (late-reach $x $y))
    `);
    const first = m.eval(Collapse(S["late-reach"](1, V.y))).one();
    await reached.opened;
    assert.throws(
      () => m.runOne(Collapse(S["late-reach"](1, V.y))),
      (error: Error) => /shared table this ask needs/.test(error.message) && /awaiting form/.test(error.message),
    );
    release.open();
    assert.deepEqual(members(await first), ["2"]);
  });

  it("resolves two asks deadlocked over two tables", async () => {
    const gates = { p: gate(), q: gate() };
    const reached = { p: gate(), q: gate() };
    m.op(async function crossGate(tag: Atom, x: number): Promise<number> {
      const name = String(tag) as "p" | "q";
      reached[name].open();
      await gates[name].opened;
      return x;
    });
    m.run(`
      (= (cross-p $x) (cross-gate p $x))
      (= (cross-p $x) (cross-q $x))
      (= (cross-q $x) (cross-gate q $x))
      (= (cross-q $x) (cross-p $x))
      !(tabled (cross-p $x))
      !(tabled (cross-q $x))
    `);
    const p = m.eval(Collapse(S["cross-p"](1))).one();
    await reached.p.opened; // the first ask owns cross-p's table
    const q = m.eval(Collapse(S["cross-q"](1))).one();
    await reached.q.opened; // the second owns cross-q's
    // The first now needs cross-q and parks; the second then needs cross-p,
    // which closes the cycle: it gives cross-q up and waits its turn.
    gates.p.open();
    await settle();
    gates.q.open();
    const [fromP, fromQ] = await Promise.all([p, q]);
    assert.deepEqual(members(fromP), ["1"]);
    assert.deepEqual(members(fromQ), ["1"]);
  });
});
