/**
 * Purpose: the fold over a space's writes, and the provider capabilities the
 *   seam has beyond the first five.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  type Atom,
  CAPABILITIES,
  Fold,
  type MeTTa,
  S,
  SubscriberError,
  type Space,
  type SpaceProvider,
  V,
  capabilitiesOf,
  fold,
  metta,
  publish,
  requireCapability,
  stream,
} from "../src/index.ts";

let m: MeTTa;
let counter = 0;

const fresh = (): Space => {
  counter += 1;
  return m.space(`&folded${String(counter)}`);
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("a fold over writes", () => {
  it("steps once per matching write, in order", async () => {
    const kb = fresh();
    using counted = fold(kb, S.alarm(V.what), (seen: string[], event) => [...seen, event.atom.text], {
      initial: [] as string[],
    });
    assert.ok(counted instanceof Fold);
    publish(kb, S.alarm(S.fire));
    publish(kb, S.other(S.noise));
    publish(kb, S.alarm(S.flood));
    await counted.settled();
    assert.deepEqual(counted.state, ["(alarm fire)", "(alarm flood)"]);
    assert.equal(counted.steps, 2);
    assert.ok(counted.active);
    assert.match(String(counted), /^Fold\(\(alarm \$what\), 2 steps\)/);
  });

  it("keeps its state when a step throws", async () => {
    const kb = fresh();
    const failures: unknown[] = [];
    using counted = fold(
      kb,
      S.risky(V.n),
      (total: number, event) => {
        if (event.atom.text.includes("1")) throw new Error("no");
        return total + 1;
      },
      { initial: 0, onError: (error) => failures.push(error) },
    );
    publish(kb, S.risky(1));
    publish(kb, S.risky(2));
    await counted.settled();
    assert.equal(counted.state, 1, "the failing step left the state alone");
    assert.equal(counted.steps, 1);
    assert.equal(failures.length, 1);
  });

  it("re-raises an unhandled step failure from settled()", async () => {
    const kb = fresh();
    const failure = new Error("step blew up");
    using counted = fold(
      kb,
      S.risky(V.n),
      () => {
        throw failure;
      },
      { initial: 0 },
    );
    publish(kb, S.risky(1));
    await assert.rejects(
      () => counted.settled(),
      (error: unknown) => error instanceof SubscriberError && error.cause === failure,
    );
    assert.equal(counted.state, 0);
    assert.equal(counted.steps, 0);
    assert.ok(counted.active);
  });

  it("narrows to one edge, and counts a removal when asked", async () => {
    const kb = fresh();
    using removals = fold(kb, S.gone(V.n), (total: number) => total + 1, {
      initial: 0,
      on: "remove",
    });
    kb.add(S.gone(1));
    kb.delete(S.gone(1));
    await removals.settled();
    assert.equal(removals.state, 1);
  });

  it("hands the loop back, for a caller who would rather pull", async () => {
    const kb = fresh();
    const seen: string[] = [];
    const pulling = (async (): Promise<void> => {
      for await (const event of stream(kb, S.pulled(V.n))) {
        seen.push(event.atom.text);
        if (seen.length === 2) break;
      }
    })();
    publish(kb, S.pulled(1));
    publish(kb, S.pulled(2));
    await pulling;
    assert.deepEqual(seen, ["(pulled 1)", "(pulled 2)"]);
  });

  it("stops folding when its block ends", async () => {
    const kb = fresh();
    let held: Fold<number>;
    {
      using counted = fold(kb, S.brief(V.n), (total: number) => total + 1, { initial: 0 });
      held = counted;
      assert.ok(counted.active);
    }
    assert.ok(!held.active, "leaving the block ended it");
  });
});

describe("the rest of the provider seam", () => {
  it("names every capability the seam has", () => {
    assert.deepEqual([...CAPABILITIES].sort(), [
      "add",
      "add-many",
      "bounded",
      "clear",
      "enumerate",
      "match",
      "plan",
      "pushdown",
      "remove",
      "rules",
      "subscribe",
      "transactional",
    ]);
  });

  it("derives the new capabilities from the new methods", () => {
    const bulk: SpaceProvider = {
      *atoms() {
        yield S.a;
      },
      add() {},
      addMany() {},
      matchBounded() {
        return [];
      },
      pushdown: () => "exact",
      begin() {},
      commit() {},
      rollback() {},
    };
    const held = capabilitiesOf(bulk);
    assert.ok(held.includes("add-many"));
    assert.ok(held.includes("bounded"));
    // `pushdown` is the per-pattern filter classifier; `plan` is the engine's
    // word for the whole-conjunction join, which this provider does not have.
    assert.ok(held.includes("pushdown"));
    assert.ok(!held.includes("plan"));
    assert.ok(held.includes("transactional"));
    // Two of the three transaction verbs is not transactional.
    const partial: SpaceProvider = { begin() {}, commit() {} };
    assert.ok(!capabilitiesOf(partial).includes("transactional"));
  });

  it("takes a whole batch in one crossing when the provider has a bulk door", async () => {
    const held: Atom[] = [];
    let batches = 0;
    const store: SpaceProvider = {
      *atoms() {
        yield* held;
      },
      add(atom) {
        held.push(atom);
      },
      addMany(atoms) {
        batches += 1;
        held.push(...atoms);
        return atoms.length;
      },
    };
    const kb = m.attach("&bulk", store);
    kb.add(S.row(1), S.row(2), S.row(3));
    assert.equal(held.length, 3);
    assert.equal(batches, 1, "one crossing for three atoms");
    m.detach("&bulk");
  });

  it("refuses a capability it was asked to require and does not have", () => {
    const readOnlyProvider: SpaceProvider = {
      *atoms() {
        yield S.a;
      },
    };
    requireCapability(readOnlyProvider, "match");
    assert.throws(() => requireCapability(readOnlyProvider, "add"), /does not implement add/);
  });

  it("hands the caller's bound only to a provider that claimed it can use one", async () => {
    let boundedCalls = 0;
    let plainCalls = 0;
    const exact: SpaceProvider = {
      *atoms() {
        for (let at = 0; at < 5; at += 1) yield S.n(at);
      },
      *match() {
        plainCalls += 1;
        for (let at = 0; at < 5; at += 1) yield S.n(at);
      },
      *matchBounded(_pattern, limit) {
        boundedCalls += 1;
        for (let at = 0; at < limit; at += 1) yield S.n(at);
      },
      pushdown: () => "exact",
    };
    const kb = m.attach("&bounded", exact);
    // An UNBOUNDED query never reaches the bounded door.
    assert.equal((await kb.match(S.n(V.x)).toArray()).length, 5);
    assert.ok(plainCalls > 0, "the plain door answered the unbounded query");
    assert.equal(boundedCalls, 0);
    m.detach("&bounded");
  });
});
