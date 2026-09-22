/**
 * Purpose: verify query notation, disposable ownership and native carriers.
 * Owns resources: one engine and explicitly disposed spaces and cursors.
 * Guarantees: prepared and traced queries agree with their native terms
 *   [tested: "preserves guards and limits when lowering a prepared generator query"; commit=94e5fc7eb685b895dde2878e7054332a0cb61c7d].
 */
import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import {
  ATOM_OF, type MeTTa, S, V, fn, metta, toAtom, variable,
} from "../src/index.ts";
import { counting, matchUnder, taggedFact, taggedRule } from "../src/algebra.ts";

describe("depth parity", () => {
  let m: MeTTa;
  before(async () => { m = await metta(); });
  after(() => { m.dispose(); });

  it("prepares a guarded join once and reads new facts on every solve", async () => {
    using kb = m.space();
    kb.add(S.person(S.ada), S.age(S.ada, 36), S.person(S.grace), S.age(S.grace, 17));
    const query = kb.prepare(S[","](S.person(V.name), S.age(V.name, V.age)), { where: fn.gte(V.age, 18) });
    assert.deepEqual(query.columns, ["name", "age"]);
    assert.ok(Object.isFrozen(query.columns));
    assert.deepEqual((await query.solve()).map((row) => row.name.text), ["ada"]);
    kb.delete(S.age(S.grace, 17));
    kb.add(S.age(S.grace, 85));
    assert.deepEqual((await query.solve()).map((row) => row.name.text).sort(), ["ada", "grace"]);
    const native = await kb.eval(query.term);
    assert.deepEqual(native.map(String).sort(), ["(ada 36)", "(grace 85)"]);
  });

  it("applies native limits after guards for rows and evaluated templates", async () => {
    using kb = m.space();
    kb.add(S.score(1), S.score(2), S.score(3), S.score(4));
    const options = { where: fn.gt(V.n, 2), limit: 1 };
    assert.deepEqual((await kb.match(S.score(V.n), options)).map((row) => row.n.text), ["3"]);
    assert.deepEqual((await kb.match(S.score(V.n), fn.mul(V.n, 2), options)).map(String), ["6"]);
    assert.equal(await kb.match(S.score(V.n), { where: false }).count(), 0);
    for (const limit of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => kb.prepare(S.score(V.n), { limit }), /positive safe integer/);
      assert.throws(() => kb.match(S.score(V.n), V.n, { limit }), /positive safe integer/);
    }
  });

  it("preserves guards and limits when lowering a prepared generator query", async () => {
    m.self.add(S.examScore(1), S.examScore(3), S.examScore(5));
    const query = m.prepare(S.examScore(V.n), { where: fn.gt(V.n, 2), limit: 1 });
    const accepted = m.define(function* acceptedScore() { const row = yield* query.solve(); yield row.n!; });
    assert.deepEqual((await accepted()).map(String), ["3"]);
  });

  it("keeps callable values inert and arbitrary column names own properties", async () => {
    using kb = m.space();
    m.run("(= (twice $x) (* $x 2))", kb);
    kb.add(S.uses(S.twice, 3));
    const row = await kb.prepare(S.uses(variable("__proto__"), V.n)).solve().one();
    assert.equal(Object.hasOwn(row, "__proto__"), true);
    assert.equal(row["__proto__"].text, "twice");
    assert.equal(row.n.text, "3");
    assert.deepEqual(await kb.prepare(S.uses(S.twice, 3)).solve(), [{}]);
  });

  it("cancels one prepared execution while keeping later executions usable", async () => {
    using kb = m.space();
    kb.add(S.item(1));
    const query = kb.prepare(S.item(V.n));
    const abort = new AbortController();
    abort.abort(new Error("cancel prepared execution"));
    await assert.rejects(query.solve({ signal: abort.signal }).toArray(), /cancel prepared execution/);
    assert.equal((await query.solve().one()).n.text, "1");
  });

  it("refuses a prepared execution after its space was released", async () => {
    const kb = m.space();
    const query = kb.prepare(S.item(V.n));
    kb.release();
    kb.release();
    await assert.rejects(query.solve().toArray(), /released/);
    assert.equal(m.engine.knownSpaces.has(kb.name), false);
    assert.equal(m.space(kb.handle).released, false);
    m.space(kb.handle).release();
  });

  it("uses spaces and mutable cells as their native atoms in every term position", async () => {
    using kb = m.space();
    const cell = m.state(1, { type: S.Number });
    assert.equal(toAtom(kb), kb.handle);
    assert.equal(toAtom(cell), cell[ATOM_OF]);
    assert.equal((await m.eval(fn["change-state!"](cell, 2)).one()).text, "true");
    assert.equal((await m.eval(fn.getState(cell)).one()).text, "2");
    m.runOne(fn.addAtom(kb, S.value(3)));
    assert.equal((await kb.match(S.value(V.n)).one()).n.text, "3");
    assert.equal(await kb.match(S.value(V.n), kb).one(), kb.handle);
  });

  it("keeps per-call transactions distinct from block transactions", () => {
    using kb = m.space();
    assert.throws(() => {
      using atomic = kb.atomic();
      kb.add(S.kept());
      m.run("(discarded) !(car-atom $unbound)", kb);
    });
    assert.equal(kb.has(S.kept()), true);
    assert.equal(kb.has(S.discarded()), false);
    assert.equal(m.engine.scopes.length, 0);
    { using policy = kb.speculative(); kb.add(S.provisional()); }
    assert.equal(kb.has(S.provisional()), false);
  });

  it("removes only the policy being disposed even out of nesting order", () => {
    using kb = m.space();
    const atomic = kb.atomic();
    const speculative = kb.speculative();
    atomic.release();
    kb.add(S.discarded());
    assert.equal(kb.has(S.discarded()), false);
    speculative.release();
    kb.add(S.kept());
    assert.equal(kb.has(S.kept()), true);
  });

  it("answers native weighted deductions", async () => {
    using kb = m.space();
    kb.add(taggedFact(2, S.edge(S.a, S.b)), taggedFact(3, S.edge(S.b, S.c)),
      taggedRule(1, S.path(V.a, V.b), S.edge(V.a, V.b)),
      taggedRule(1, S.path(V.a, V.c), S.edge(V.a, V.b), S.path(V.b, V.c)));
    const answer = await matchUnder(kb, S.path(S.a, S.c), "prob").one();
    assert.equal(answer.value.text, "(path a c)");
    assert.equal(answer.tag.text, "6");
    assert.equal((await matchUnder(kb, S.path(S.a, S.c), "counting").one()).tag.text, "1");
    const native = await kb.eval(fn.matchUnder(kb, S.prob, S.path(S.a, S.c))).one();
    assert.equal(native.text, "((path a c) 6)");
    assert.throws(() => matchUnder(kb, S.edge(V.a, V.b), counting), /engine carrier name/);
  });

  it("reaches a native fixpoint on a cyclic idempotent tagged program", async () => {
    using kb = m.space();
    kb.add(taggedFact(1, S.reach(S.a)), taggedRule(1, S.reach(S.b), S.reach(S.a)),
      taggedRule(1, S.reach(S.a), S.reach(S.b)));
    assert.deepEqual((await matchUnder(kb, S.reach(V.x), "set")).map((row) => row.value.text).sort(), ["(reach a)", "(reach b)"]);
  });

  it("scopes temporary facts to one solve and preserves existing occurrence tokens", async () => {
    using kb = m.space();
    kb.add(S.route(S.direct));
    const tokens = kb.blame(S.route(S.direct)).map(String);
    const query = kb.prepare(S.route(V.path));
    assert.equal(await query.solve({ given: [S.route(S.direct), S.route(S.detour)] }).count(), 3);
    assert.deepEqual((await query.solve()).map((row) => row.path.text), ["direct"]);
    assert.deepEqual(kb.blame(S.route(S.direct)).map(String), tokens);
    using view = kb.live(S.route(V.path));
    const generation = view.generation;
    await query.solve({ given: [S.route(S.detour)] }).take(1).toArray();
    assert.equal(view.generation, generation);
  });

  it("discards temporary facts and writes after an empty result or exception", async () => {
    using kb = m.space();
    for (const target of [S.Empty, fn.carAtom(V.unbound)]) {
      const answers = kb.withFacts([S.temp()], fn.progn(fn.addAtom(kb, S.sideEffect()), target));
      if (toAtom(target).text === "Empty") assert.deepEqual(await answers, []);
      else await assert.rejects(answers.toArray());
      assert.equal(kb.size, 0);
    }
    assert.throws(() => kb.withFacts([], () => 1), /TERM/);
  });

  it("allows async guards normally and refuses them in a native snapshot", async () => {
    using kb = m.space();
    m.op(async function depthGuard(n: number) { return n > 2; }, { effect: "readOnlyLookup" });
    kb.add(S.sample(1), S.sample(3));
    const query = kb.prepare(S.sample(V.n), { where: S.depthGuard(V.n), limit: 1 });
    assert.equal((await query.solve().one()).n.text, "3");
    await assert.rejects(query.solve({ given: [] }).toArray(), /cannot suspend/);
  });

  it("treats incompatible deterministic and streamed callback results as logical failure", async () => {
    const values = [false, true, 7, S.pair(2)];
    m.op(function depthReply(value: unknown) { return value; }, { raw: true });
    m.op(async function depthAsyncReply(value: unknown) { return value; }, { raw: true });
    m.op(function* depthReplyStream() { yield* values; });
    m.op(async function* depthAsyncReplies() { yield* values; });
    for (const target of values) {
      for (const call of [S.depthReply(target), S.depthAsyncReply(target)]) {
        assert.deepEqual((await m.eval(fn.let(target, call, S.accepted))).map(String), ["accepted"]);
        assert.deepEqual(await m.eval(fn.let(S.absent, call, S.accepted)), []);
      }
    }
    for (const call of [S.depthReplyStream(), S.depthAsyncReplies()]) {
      for (const target of values) {
        assert.deepEqual((await m.eval(fn.let(target, call, S.accepted))).map(String), ["accepted"]);
      }
      assert.deepEqual(await m.eval(fn.let(S.absent, call, S.accepted)), []);
    }
  });

  it("composes native product and formula carriers without host evaluation", async () => {
    using kb = m.space();
    kb.add(taggedFact(0.5, S.a()), taggedFact(0.2, S.b()), taggedRule(1, S.c(), S.a(), S.b()));
    const product = await matchUnder(kb, S.c(), S.product(S.prob, S.counting)).one();
    assert.equal(product.tag.text, "(pair 0.1 1)");
    assert.equal((await matchUnder(kb, S.c(), S.formula(S.prob)).one()).tag.text, "0.1");
  });

  it("checks overlapping native proof probabilities against exhaustive events", async () => {
    for (const a of [0.25, 0.5, 0.75]) for (const b of [0.25, 0.5, 0.75]) for (const c of [0.25, 0.5, 0.75]) {
      using kb = m.space();
      kb.add(taggedFact(a, S.a()), taggedFact(b, S.b()), taggedFact(c, S.c()),
        taggedRule(1, S.goal(), S.a(), S.b()), taggedRule(1, S.goal(), S.a(), S.c()));
      let expected = 0;
      for (let mask = 0; mask < 8; mask++) {
        if ((mask & 1) === 0 || (mask & 6) === 0) continue;
        expected += [a, b, c].reduce((p, weight, bit) => p * ((mask & (1 << bit)) ? weight : 1 - weight), 1);
      }
      const actual = Number((await matchUnder(kb, S.goal(), S.formula(S.prob)).one()).tag.text);
      assert.ok(Math.abs(actual - expected) < 1e-12, `${a},${b},${c}: ${actual} != ${expected}`);
    }
  });
});
