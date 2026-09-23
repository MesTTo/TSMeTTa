/**
 * Purpose: verify asynchronous resource release and table bridge equality.
 * Owns resources: the runtime and attached provider close after each test.
 * Guarantees: cleanup finishes before an awaited take returns, and repeated
 *   columns unify [tested: npm test; commit=WORKTREE].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { metta, S, V, type Atom } from "../src/index.ts";
import { tableSpace, bridge, type Row } from "../src/tables.ts";
import { fromPattern } from "../src/testing.ts";
import { Random } from "../src/random.ts";
import { matchTerms } from "../src/matching.ts";

test("awaits a provider finalizer before take completes", async () => {
  using m = await metta();
  let closed = false;
  const space = m.attach("&release", {
    async *atoms() {
      try { yield S.item(1); yield S.item(2); }
      finally { await setImmediate(); closed = true; }
    },
  });
  assert.equal((await space.match(S.item(V.n)).take(1)).length, 1);
  assert.equal(closed, true);
});

test("generator effects include their nondeterministic delivery", async () => {
  using m = await metta();
  for (const effect of ["pureStructural", "readOnlyLookup", "nondeterministicReadOnly", "writesState", "oracleIO"] as const) {
    const operation = m.op(function* choices() { yield 1; yield 2; }, { effect });
    assert.equal(m.effectOf(operation), effect === "pureStructural" || effect === "readOnlyLookup" ? "nondeterministicReadOnly" : effect);
    assert.equal(await operation().count(), 2);
    operation.forget();
  }
});

test("an awaited finalizer refusal reaches the query caller", async () => {
  using m = await metta();
  const values = m.op(async function* cleanupFailure() {
    try { yield 1; yield 2; }
    finally { await setImmediate(); throw new Error("release refused"); }
  });
  await assert.rejects(() => values().take(1).toArray(), /release refused/);
  assert.equal(String(await m.eval(S("+")(20, 22)).one()), "42");
});

test("table columns share repeated and nested variable bindings", async () => {
  const provider = tableSpace({ rows: () => [{ a: 1, b: 2 }, { a: 3, b: 3 }] },
    [bridge(S.same(V.x), "t", { a: V.x, b: V.x })]);
  const atoms: string[] = [];
  for await (const atom of provider.atoms!()) atoms.push(String(atom));
  assert.deepEqual(atoms, ["(same 3)"]);
  const nested = tableSpace({ rows: () => [{ a: S.pair(1, 2), b: 1 }] },
    [bridge(S.pair(V.x, V.y), "t", { a: S.pair(V.x, V.y), b: V.x })]);
  const values: string[] = [];
  for await (const atom of nested.atoms!()) values.push(String(atom));
  assert.deepEqual(values, ["(pair 1 2)"]);
});

test("a literal dollar is pushed down as a table constraint", async () => {
  let where: Row | undefined;
  const provider = tableSpace({ rows: (_table, filter) => { where = filter; return []; } },
    [bridge(S.price(V.x), "t", { value: V.x })]);
  for await (const _ of provider.match!(S.price("$5") as Atom)) { /* empty source */ }
  assert.deepEqual(where, { value: "$5" });
});

test("generated pattern instances and shrinks preserve shared bindings", () => {
  const pattern = S.edge(V.x, V.x);
  const arbitrary = fromPattern(pattern);
  const random = new Random(1);
  const anonymous = fromPattern(S.pair(V("_"), V("_")));
  let independent = false;
  for (let i = 0; i < 100; i += 1) {
    const value = arbitrary.generate(random, 3);
    assert.notEqual(matchTerms(pattern, value), undefined);
    for (const smaller of arbitrary.shrink!(value)) assert.notEqual(matchTerms(pattern, smaller), undefined);
    if (matchTerms(S.pair(V.x, V.x), anonymous.generate(random, 3)) === undefined) independent = true;
  }
  assert.equal(independent, true);
});
