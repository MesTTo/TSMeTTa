/**
 * Purpose: the compensating-transaction journal — receipts for what committed,
 *   and reverse recovery by the compensations a program declared.
 * Guarantees:
 *   - every guarantee `src/saga.ts` states is exercised here, including the
 *     three that only show up when something goes wrong
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type MeTTa, S, metta } from "../src/index.ts";
import { Saga, compensates, compensations, saga } from "../src/saga.ts";

let m: MeTTa;
let ledger: string[] = [];
let counter = 0;

before(async () => {
  m = await metta();
  m.op(
    function charge(amount: number): number {
      ledger.push(`charge ${String(amount)}`);
      return amount;
    },
    { effect: "writesState" },
  );
  m.op(
    function refund(amount: number): number {
      ledger.push(`refund ${String(amount)}`);
      return amount;
    },
    { effect: "writesState" },
  );
  m.op(function peek(): number {
    ledger.push("peek");
    return 1;
  }, { effect: "readOnlyLookup" });
  m.op(
    function ship(what: string): string {
      ledger.push(`ship ${what}`);
      return what;
    },
    { effect: "writesState" },
  );
  compensates(m, "charge", "refund");
});

after(() => {
  m.dispose();
});

const fresh = (): Saga => {
  counter += 1;
  ledger = [];
  return saga(m, m.space(`&receipts${String(counter)}`));
};

describe("a saga", () => {
  it("commits a receipt per effectful step and none for a failed one", async () => {
    using book = fresh();
    await book.run(S.charge(10));
    // A READ earns no receipt: there would be nothing to undo, and a rollback
    // that tried would be compensating a lookup.
    await book.run(S.peek());
    assert.deepEqual(book.receipts.map(String), ["(did charge (10) 10)"]);
    assert.deepEqual(ledger, ["charge 10", "peek"]);
    assert.equal((await book.space.atoms()).length, 1, "the journal is ordinary data");
  });

  it("compensates in reverse order, and clears what it undid", async () => {
    using book = fresh();
    await book.run(S.charge(10));
    await book.run(S.charge(20));
    await book.rollback();
    assert.deepEqual(ledger, ["charge 10", "charge 20", "refund 20", "refund 10"]);
    assert.equal(book.receipts.length, 0);
    assert.equal((await book.space.atoms()).length, 0);
  });

  it("refuses to start undoing when a compensation is missing", async () => {
    using book = fresh();
    await book.run(S.charge(10));
    await book.run(S.ship("crate"));
    // PREFLIGHT: nothing is undone, because stopping half way through leaves
    // the world in neither state.
    await assert.rejects(() => book.rollback(), /nothing undoes ship/);
    assert.deepEqual(ledger, ["charge 10", "ship crate"], "no compensation ran");
    assert.equal(book.receipts.length, 2, "and the journal is intact");
  });

  it("keeps the failed suffix so a retry resumes", async () => {
    using book = fresh();
    let refuse = true;
    m.op(
      function unstable(n: number): number {
        ledger.push(`unstable ${String(n)}`);
        return n;
      },
      { effect: "writesState" },
    );
    const undo = m.op(
      function undoUnstable(n: number): number {
        ledger.push(`undo ${String(n)}`);
        if (refuse) throw new Error("not yet");
        return n;
      },
      { effect: "writesState" },
    );
    compensates(m, "unstable", "undo-unstable");
    await book.run(S.charge(1));
    await book.run(S.unstable(2));
    await assert.rejects(() => book.rollback(), /not yet/);
    // The failed receipt and everything BEFORE it are still owed.
    assert.deepEqual(book.receipts.map(String), ["(did charge (1) 1)", "(did unstable (2) 2)"]);
    refuse = false;
    await book.rollback();
    assert.deepEqual(book.receipts.length, 0);
    assert.deepEqual(ledger.slice(-3), ["undo 2", "undo 2", "refund 1"], "it resumed");
    undo.forget();
  });

  it("does not journal its own compensations", async () => {
    using book = fresh();
    await book.run(S.charge(5));
    await book.rollback();
    // `refund` is itself writesState; journalling it would make undoing an
    // obligation to undo.
    assert.equal(book.receipts.length, 0);
    assert.equal((await book.space.atoms()).length, 0);
  });

  it("reads the compensations a program declared", async () => {
    const declared = await compensations(m);
    assert.equal(declared.get("charge"), "refund");
  });

  it("refuses a second recording scope while one is open", async () => {
    using first = fresh();
    using second = saga(m, m.space("&receipts-second"));
    // One engine, one journal at a time: two open captures would interleave.
    const running = first.run(S.charge(1));
    await assert.rejects(() => second.run(S.charge(2)), /two sagas cannot record at once/);
    await running;
  });

  it("says so when it is closed", async () => {
    const book = fresh();
    book.close();
    await assert.rejects(() => book.run(S.charge(1)), /this saga is closed/);
    assert.match(String(saga(m, m.self)), /^Saga\(&self, 0 receipts\)/);
  });
});
