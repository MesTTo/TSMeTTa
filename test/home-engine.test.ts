/**
 * Purpose: the home engine, the one engine every synchronous ask of an
 *   instance runs in, as the Python seat's eager runs share one engine and its
 *   lazy iteration gets an engine of its own (Job's first drive, bridge.pl's
 *   metta_node_home/1).
 * Guarantees:
 *   - a private table one synchronous ask fills is read by the next, and one an
 *     awaiting ask fills is that ask's own [tested: "shares a private table
 *     between synchronous asks", "keeps a private table to the awaiting ask
 *     that filled it"; commit=WORKTREE]
 *   - an exact memo outlives the synchronous ask that filled it [tested:
 *     "keeps an exact memo between synchronous asks"; commit=WORKTREE]
 *   - a synchronous ask a TypeScript operation starts runs in the same engine,
 *     on top of the ask that called the operation [tested: "runs an
 *     operation's synchronous ask on top of the ask that called it";
 *     commit=WORKTREE]
 *   - an ask that fails, and one refused for a promise, end without taking
 *     the home engine or what it keeps with them [tested: "keeps what the home
 *     engine holds past an ask that fails", "keeps what the home engine holds
 *     past a refused promise"; commit=WORKTREE]
 *   - a job is driven by awaiting or synchronously, never both [tested:
 *     "refuses to drive one job both ways"; commit=WORKTREE]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type MeTTa, MettaError, S, UnsupportedError, metta } from "../src/index.ts";

let m: MeTTa;
let runs = 0;

before(async () => {
  m = await metta();
  m.op(function homePrivateEdge(x: number): number {
    runs += 1;
    return x;
  });
  m.run(`
    !(import! &self (library lib_tabling))
    !(import! &self (library lib_memo))
    (= (home-private $x) (home-private-edge $x))
    !(add-atom &metta (cache home-private (plain private)))
    (= (home-exact $x) (* $x $x))
    !(memoize-exact home-exact)
  `);
});

after(() => {
  m.dispose();
});

/** The texts of a program's answers, one list per form. */
const texts = (source: string): string[][] => m.run(source).map((group) => [...group.texts]);

describe("the home engine", () => {
  it("shares a private table between synchronous asks", () => {
    const before = runs;
    assert.deepEqual(texts("!(home-private 1)"), [["1"]]);
    assert.deepEqual(texts("!(home-private 1)"), [["1"]]);
    assert.equal(runs - before, 1, "the second ask read the table the first filled");
  });

  it("keeps a private table to the awaiting ask that filled it", async () => {
    const before = runs;
    assert.equal(String(await m.eval(S["home-private"](2)).one()), "2");
    assert.equal(String(await m.eval(S["home-private"](2)).one()), "2");
    assert.equal(runs - before, 2, "each awaiting ask runs in an engine of its own");
  });

  it("keeps an exact memo between synchronous asks", () => {
    assert.deepEqual(texts("!(home-exact 7)"), [["49"]]);
    assert.deepEqual(texts("!(get-memoize-stats home-exact)"), [["((entries 1) (answers 1))"]]);
  });

  it("runs an operation's synchronous ask on top of the ask that called it", () => {
    const before = runs;
    let nested: string[][] = [];
    m.op(function homeNested(x: number): number {
      nested = texts("!(home-private 3)");
      return x;
    });
    // The outer ask completes (home-private 3) before it calls the operation,
    // so the nested ask reads that table rather than filling its own.
    assert.deepEqual(texts("!(let $a (home-private 3) (home-nested $a))"), [["3"]]);
    assert.deepEqual(nested, [["3"]]);
    assert.equal(runs - before, 1);
  });

  it("keeps what the home engine holds past an ask that fails", () => {
    const before = runs;
    m.op(function homeBroken(x: number): number {
      throw new Error(`no ${String(x)}`);
    });
    assert.deepEqual(texts("!(home-private 4)"), [["4"]]);
    assert.throws(() => m.run("!(home-broken 4)"), MettaError);
    assert.deepEqual(texts("!(home-private 4)"), [["4"]]);
    assert.equal(runs - before, 1);
  });

  it("keeps what the home engine holds past a refused promise", () => {
    const before = runs;
    m.op(async function homeLater(x: number): Promise<number> {
      return x;
    });
    assert.deepEqual(texts("!(home-private 5)"), [["5"]]);
    assert.throws(() => m.run("!(home-later 1)"), UnsupportedError);
    assert.deepEqual(texts("!(home-private 5)"), [["5"]]);
    assert.equal(runs - before, 1);
  });

  it("refuses to drive one job both ways", async () => {
    const job = m.engine.start(["spacenames"]);
    assert.notEqual(await job.next(), null);
    assert.throws(() => job.syncAll(), /driven by awaiting or synchronously, not both/);
    job.close();
  });
});
