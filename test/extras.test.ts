/**
 * Purpose: the surface's remaining doors against a live engine: theories,
 *   racing, the coordination verbs, the typed source query, and validator
 *   interop.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  type MeTTa,
  PettaError,
  S,
  type StandardSchemaV1,
  Superpose,
  V,
  answersOf,
  decodeWith,
  hostValue,
  metta,
  nearest,
  sym,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("a theory", () => {
  it("installs every method a class declares", async () => {
    class Arithmetic {
      twiceOver(n: number): number {
        return n * 2;
      }
      thriceOver(n: number): number {
        return n * 3;
      }
    }
    const installed = m.theory(Arithmetic);
    assert.deepEqual(installed.map((one) => one.head), ["twice-over", "thrice-over"]);
    assert.equal(String(await m.eval(S["twice-over"](21)).one()), "42");
    assert.equal(String(await m.eval(S["thrice-over"](7)).one()), "21");
  });

  it("refuses a class with nothing to install, by name", () => {
    class Empty {}
    assert.throws(
      () => m.theory(Empty),
      (error: PettaError) => error.code === "ERR_METTA_NAME",
    );
  });
});

describe("racing", () => {
  it("answers the first branch and cancels the rest", async () => {
    m.run("(= (forever $n) (superpose ($n (forever (+ $n 1)))))");
    const winner = await m.race([m.eval(S["+"](1, 1)), m.eval(S.forever(100))]);
    assert.ok(["2", "100"].includes(String(winner)), `unexpected winner ${String(winner)}`);
  });

  it("refuses when every branch answers nothing", async () => {
    await assert.rejects(
      () => m.race([m.eval(S.empty()), m.eval(S.empty())]),
      (error: unknown) => error instanceof AggregateError,
    );
  });
});

describe("the coordination verbs", () => {
  it("waits for an atom, and peek leaves it where it is", async () => {
    const jobs = m.space("&jobs-peek");
    setTimeout(() => jobs.add(S.job(7)), 15);
    const row = await jobs.peek(S.job(V.n), { pollMs: 1 });
    assert.equal(hostValue(row["n"]!), 7);
    assert.equal(jobs.size, 1, "peek removed the atom");
  });

  it("waits for an atom, and take removes exactly the one it matched", async () => {
    const jobs = m.space("&jobs-take");
    jobs.add(S.job(1), S.job(2));
    const first = await jobs.take(S.job(V.n), { pollMs: 1 });
    assert.equal(jobs.size, 1, "take removed the wrong number of atoms");
    const second = await jobs.take(S.job(V.n), { pollMs: 1 });
    assert.equal(jobs.size, 0);
    assert.deepEqual(
      [first, second].map((row) => Number(hostValue(row["n"]!))).sort(),
      [1, 2],
      "take answered the same atom twice",
    );
  });

  it("is bounded by a signal rather than waiting forever", async () => {
    const jobs = m.space("&jobs-never");
    await assert.rejects(
      () => jobs.take(S.job(V.n), { pollMs: 1, signal: AbortSignal.timeout(40) }),
      (error: Error) => error.name === "TimeoutError",
    );
  });
});

describe("a source query", () => {
  it("reads the pattern through the engine and keys the row by its variables", async () => {
    m.add(S.likes(S.ada, "coffee"));
    const rows = await m.q('(likes Ada $drink)');
    assert.equal(rows.length, 0, "Ada is not ada, and the engine is case sensitive");
    const found = await m.q('(likes ada $drink)');
    assert.deepEqual(found.map((row) => hostValue(row["drink"]!)), ["coffee"]);
  });
});

describe("answers already in hand", () => {
  it("behave exactly as an ask does", async () => {
    const held = answersOf("three symbols", [sym("a"), sym("b"), sym("c")]);
    assert.deepEqual((await held).map(String), ["a", "b", "c"]);
    assert.deepEqual((await held.take(2)).map(String), ["a", "b"]);
    assert.equal(String(await held.find()), "a");
    await assert.rejects(() => held.one(), /more than one answer/);
    assert.equal(String(held), "Answers(three symbols)");
  });
});

describe("validator interop", () => {
  /** A Standard Schema validator, written by hand so no dependency is added. */
  const positive: StandardSchemaV1<unknown, number> = {
    "~standard": {
      version: 1,
      vendor: "hand-written",
      validate: (value) =>
        typeof value === "number" && value > 0
          ? { value }
          : { issues: [{ message: `${String(value)} is not a positive number` }] },
    },
  };

  it("validates an answer with any library that speaks the spec", async () => {
    const answer = await m.eval(S["+"](20, 22)).one();
    assert.equal(decodeWith(positive, hostValue(answer)), 42);
  });

  it("reports the validator's own issues, naming the vendor", async () => {
    const answer = await m.eval(S["-"](0, 1)).one();
    assert.throws(
      () => decodeWith(positive, hostValue(answer)),
      /hand-written schema: -1 is not a positive number/,
    );
  });
});

describe("a refusal computes its remedy", () => {
  it("names the nearest declared spelling", () => {
    assert.equal(nearest("balanace-of", ["balance-of", "car-atom"]), "balance-of");
    assert.equal(nearest("utterly-different", ["balance-of"]), undefined);
  });

  it("offers it when a lowered body reaches a name nothing defines", () => {
    m.define(function balanceOf(account: number): number {
      return account;
    });
    assert.throws(
      () =>
        m.define(function reporting(account: number): number {
          return balanaceOf(account) as number;
        }),
      (error: PettaError) => /nearest declared: balance-of/.test(error.message),
    );
  });
});

declare function balanaceOf(n: number): unknown;

describe("nondeterminism from the host", () => {
  it("collapses what superpose spread", async () => {
    assert.deepEqual((await m.eval(Superpose([S.a, S.b]))).map(String), ["a", "b"]);
  });
});
