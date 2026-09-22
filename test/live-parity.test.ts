/**
 * Purpose: verify standing-query lifetime and committed materialized answers.
 * Owns resources: the suite disposes its engine, views and subscriptions.
 * Guarantees: seeding cannot lose an intervening write and removals retain
 *   multiset meaning [tested: "matches fresh engine joins through 150 generated mutations"; commit=94e5fc7eb685b895dde2878e7054332a0cb61c7d].
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { Answers, LiveView, type MeTTa, S, V, metta, subscribe, variable } from "../src/index.ts";
import { Random } from "../src/random.ts";

describe("live parity", () => {
  let m: MeTTa;
  before(async () => { m = await metta(); });
  after(() => { m.dispose(); });

  it("includes writes made while a view is opening", async () => {
    using kb = m.space();
    kb.add(S.person(S.ada));
    const opening = LiveView.open(kb, S.person(V.name));
    kb.add(S.person(S.grace));
    using view = await opening;
    await view.settled();
    assert.equal(view.size, 2);
    using ground = kb.live(S.person(S.ada));
    assert.deepEqual(ground.rows, [{}]);
    assert.equal(ground.count({}), 1);
  });

  it("recomputes a variable-pattern removal against the committed store", async () => {
    using kb = m.space();
    kb.add(S.person(S.ada), S.person(S.grace));
    using view = await LiveView.open(kb, S.person(V.name));
    kb.delete(S.person(V.any));
    await view.settled();
    assert.equal(view.size, kb.size);
    assert.equal(view.size, 1);
  });

  it("honors a caller cancellation and closes a broken-out subscription", async () => {
    using kb = m.space();
    const abort = new AbortController();
    using watch = subscribe(kb, S.person(V.name), { signal: abort.signal });
    abort.abort(new Error("caller cancelled"));
    await watch.settled();
    assert.equal(watch.active, false);
    using loop = subscribe(kb, S.person(V.name));
    kb.add(S.person(S.ada));
    for await (const _event of loop) break;
    assert.equal(loop.active, false);
  });

  it("maintains joined rows and one progress boundary for an atomic batch", async () => {
    using kb = m.space();
    kb.add(S.person(S.ada), S.person(S.ada));
    using view = kb.live(S.person(V.name), S.age(V.name, V.age));
    const changes = view.changes()[Symbol.asyncIterator]();
    assert.equal((await changes.next()).value?.kind, "progress");
    {
      using atomic = m.atomic();
      kb.add(S.age(S.ada, 36), S.age(S.grace, 85), S.person(S.grace));
    }
    assert.equal(view.size, 3);
    assert.deepEqual(view.columns, ["name", "age"]);
    assert.equal(view.count({ name: S.ada, age: 36 }), 2);
    const deltas = [];
    for (let i = 0; i < 4; i++) deltas.push((await changes.next()).value!);
    assert.deepEqual(deltas.map((delta) => delta.kind), ["add", "add", "add", "progress"]);
    assert.equal(new Set(deltas.map((delta) => delta.generation)).size, 1);
    kb.delete(S.person(S.ada));
    assert.equal((await changes.next()).value?.kind, "remove");
    assert.equal((await changes.next()).value?.kind, "progress");
    assert.equal(view.count({ name: S.ada, age: 36 }), 1);
    await changes.return?.();
  });

  it("retains separate commit deltas and excludes rollback and speculation", async () => {
    using kb = m.space();
    using view = kb.live(S.item(V.n));
    const changes = view.changes()[Symbol.asyncIterator]();
    await changes.next();
    const generation = view.generation;
    assert.throws(() => {
      using atomic = m.atomic();
      m.run("(item 99) !(car-atom $unbound)", kb);
    });
    { using speculative = m.speculative(); kb.add(S.item(98)); }
    assert.equal(view.generation, generation);
    kb.add(S.item(1));
    kb.delete(S.item(1));
    const deltas = [];
    for (let i = 0; i < 4; i++) deltas.push((await changes.next()).value!);
    assert.deepEqual(deltas.map((delta) => delta.kind), ["add", "progress", "remove", "progress"]);
    assert.ok(deltas[0].generation < deltas[2].generation);
    assert.equal(view.size, 0);
    await changes.return?.();
  });

  it("keeps variable rows stable and special column names as own properties", async () => {
    using kb = m.space();
    kb.add(S.pair(V.a, V.a));
    using view = kb.live(S.pair(variable("__proto__"), V.other));
    assert.equal(Object.hasOwn(view.rows[0], "__proto__"), true);
    assert.equal(view.rows[0]["__proto__"], view.rows[0]["other"]);
    assert.equal(view.count({ ["__proto__"]: V.renamed, other: V.renamed }), 1);
    const changes = view.changes()[Symbol.asyncIterator]();
    await changes.next();
    await changes.next();
    kb.add(S.unrelated());
    assert.equal((await changes.next()).value?.kind, "progress");
    assert.equal(view.size, 1);
    await changes.return?.();
  });

  it("maintains a tabled call after additions and removals", async () => {
    m.run(`
      !(import! &self (library lib_tabling))
      (= (live-names) (match &self (live-person $name) $name))
      !(tabled (live-names))
      (live-person ada)
    `);
    assert.throws(() => m.self.liveEval(S.liveNames()), /shared answer trie cannot isolate/);
    m.catalog.add(S.cache(S.liveNames, [S.incremental, S.private]));
    using view = m.self.liveEval(S.liveNames());
    assert.deepEqual(view.rows.map((row) => String(row.value)), ["ada"]);
    m.self.add(S.livePerson(S.grace));
    assert.deepEqual(view.rows.map((row) => String(row.value)).sort(), ["ada", "grace"]);
    m.self.delete(S.livePerson(S.ada));
    assert.deepEqual(view.rows.map((row) => String(row.value)), ["grace"]);
    assert.throws(() => m.self.liveEval(S.addAtom(m.self, S.never())), /incremental_tabled_query/);
    assert.equal(m.self.has(S.never()), false);
  });

  it("reports transitive effects without executing the target", () => {
    using kb = m.space();
    m.run("(= (write-live $target) (add-atom $target (effect-written)))", kb);
    const plan = kb.effectPlan(S.writeLive(kb));
    assert.ok(plan.operations.some(([name, effect]) => name === "add-atom" && effect === "writesState"));
    assert.equal(kb.has(S.effectWritten()), false);
    assert.ok(Object.isFrozen(plan.operations));
  });

  it("closes failed subscriptions and delivers their failures to iteration", async () => {
    using kb = m.space();
    kb.release();
    assert.throws(() => subscribe(kb, S.item(V.n)), /released/);
    using target = m.space();
    const watch = subscribe(target, S.item(V.n), { onEvent: () => { throw new Error("delivery failed"); } });
    target.add(S.item(1));
    await watch.settled();
    await assert.rejects(async () => { for await (const _event of watch) {} }, /delivery failed/);
    assert.equal(watch.active, false);
  });

  it("rejects queue overflow and preserves a closed view's final snapshot", async () => {
    using kb = m.space();
    const view = kb.live(S.item(V.n));
    const changes = view.changes({ queueMax: 1 })[Symbol.asyncIterator]();
    await changes.next();
    kb.add(S.item(1), S.item(2));
    await assert.rejects(changes.next(), /queueMax/);
    const rows = view.rows;
    view.close();
    view.close();
    kb.add(S.item(3));
    assert.equal(view.rows, rows);
    assert.equal(view.size, 2);
    assert.throws(() => view.changes({ queueMax: 0 }), /positive safe integer/);
    await assert.rejects(view.changes().find(), /closed/);
    assert.equal(m.engine.once("aggregate_all(count, metta_node_live(_,_,_,_,_,_), Count)")["Count"], 0);
  });

  it("matches fresh engine joins through 150 generated mutations", async () => {
    using kb = m.space();
    using view = kb.live(S.left(V.key), S.right(V.key, V.value));
    const random = new Random(20260920);
    for (let step = 0; step < 150; step++) {
      const atom = random.between(0, 1) === 0
        ? S.left(random.between(0, 4)) : S.right(random.between(0, 4), random.between(0, 4));
      if (random.between(0, 2) === 0) kb.delete(atom);
      else kb.add(atom);
      const expected = await kb.match(S[","](S.left(V.key), S.right(V.key, V.value)));
      const render = (rows: readonly Readonly<Record<string, unknown>>[]) => rows.map((row) => `${row.key}:${row.value}`).sort();
      assert.deepEqual(render(view.rows), render(expected), `mutation ${step}`);
    }
  });

  it("cancels a waiting change consumer and retains the view", async () => {
    using kb = m.space();
    using view = kb.live(S.item(V.n));
    const abort = new AbortController();
    const changes = view.changes({ signal: abort.signal })[Symbol.asyncIterator]();
    await changes.next();
    const pending = changes.next();
    abort.abort(new Error("stop changes"));
    await assert.rejects(pending, /stop changes/);
    assert.equal(view.active, true);
    assert.equal(m.engine.once("aggregate_all(count, metta_node_live_buffer(_,_,_), Count)")["Count"], 0);
  });

  it("opens and closes observations independently of speculative writes", async () => {
    using kb = m.space();
    kb.add(S.item(1));
    {
      using policy = m.speculative();
      using view = kb.live(S.item(V.n));
      using watch = subscribe(kb, S.item(V.n));
      kb.add(S.item(2));
      assert.equal(view.size, 1);
      const changes = view.changes()[Symbol.asyncIterator]();
      assert.equal((await changes.next()).value?.kind, "add");
      await changes.return?.();
      watch.unsubscribe();
      await watch.settled();
    }
    assert.equal(m.engine.once("aggregate_all(count, metta_node_live(_,_,_,_,_,_), Count)")["Count"], 0);
  });

  it("closes an answer source once when cancellation precedes or follows its pull", async () => {
    for (const before of [true, false]) {
      const abort = new AbortController();
      let closed = 0;
      const answers = new Answers<number>("cancellation ownership", () => ({
        next: async () => { abort.abort(new Error("cancelled pull")); return { done: false, value: 1 }; },
        return: async () => { closed += 1; return { done: true, value: undefined }; },
      }), abort.signal);
      if (before) abort.abort(new Error("cancelled pull"));
      const iterator = answers[Symbol.asyncIterator]();
      await assert.rejects(iterator.next(), /cancelled pull/);
      await iterator.return?.();
      assert.equal(closed, 1);
    }
  });

  it("keeps consumers independent when one queue overflows", async () => {
    using kb = m.space();
    using view = kb.live(S.item(V.n));
    const slow = view.changes({ queueMax: 1 })[Symbol.asyncIterator]();
    const fast = view.changes()[Symbol.asyncIterator]();
    await slow.next();
    await fast.next();
    kb.add(S.item(1));
    assert.equal((await fast.next()).value?.kind, "add");
    assert.equal((await fast.next()).value?.kind, "progress");
    await assert.rejects(slow.next(), /queueMax/);
    kb.add(S.item(2));
    assert.equal((await fast.next()).value?.kind, "add");
    assert.equal((await fast.next()).value?.kind, "progress");
    assert.equal(view.size, 2);
    assert.throws(() => view.count({ absent: 2 }), /missing column n/);
    await fast.return?.();
  });

  it("reports a failed recomputation while other views see the committed write", () => {
    m.run(`
      (= (live-first) (match &self (live-list $xs) (car-atom $xs)))
      !(add-atom &metta (cache live-first (incremental private)))
      (live-list (a b))
    `);
    const failing = m.self.liveEval(S.liveFirst());
    using tracking = m.self.live(S.liveList(V.xs));
    assert.equal(String(failing.rows[0].value), "a");
    m.self.add(S.liveList(V.unbound));
    assert.equal(tracking.size, 2);
    assert.equal(m.self.has(S.liveList(V.any)), true);
    assert.throws(() => failing.rows);
    assert.equal(failing.active, false);
    failing.close();
  });
});
