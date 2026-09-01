/**
 * Purpose: standing queries and the live view built on one.
 * Guarantees:
 *   - a subscription is a resource, and leaving its block ends it
 *   - a live view counts multiplicity, because a space is a multiset
 *   - a live view maintains that total through seeding, updates, removals,
 *     and clear, so repeated size reads never scan its count map
 *     [tested: "maintains total multiplicity through seed, updates, removals, and clear",
 *     "reads size without scanning the multiplicity map"; commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  LiveView,
  type MeTTa,
  S,
  type Space,
  SubscriberError,
  V,
  metta,
  subscribe,
} from "../src/index.ts";

let m: MeTTa;
let counter = 0;

const fresh = (): Space => {
  counter += 1;
  return m.space(`&watched${String(counter)}`);
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("standing queries", () => {
  it("delivers each matching write to a handler", async () => {
    const kb = fresh();
    const seen: string[] = [];
    using watch = subscribe(kb, S.alarm(V.what), {
      onEvent: ({ edge, atom }) => {
        seen.push(`${edge} ${atom.text}`);
      },
    });
    kb.add(S.alarm(S.fire));
    kb.add(S.other(S.noise));
    kb.delete(S.alarm(S.fire));
    await watch.settled();
    assert.deepEqual(seen, ["add (alarm fire)", "remove (alarm fire)"]);
    assert.ok(watch.active);
  });

  it("settles on the engine's own queue rather than on a sleep", async () => {
    // `settled()` used to wait a fixed 20 milliseconds. Both halves of this
    // are DETERMINISTIC rather than load-sensitive, which is what a timing
    // defect's regression has to be: a poll interval longer than that sleep,
    // and a handler slower than it.
    const kb = fresh();
    const seen: string[] = [];
    using slowPoll = subscribe(kb, S.alarm(V.what), {
      pollMs: 200,
      onEvent: ({ atom }) => {
        seen.push(atom.text);
      },
    });
    kb.add(S.alarm(S.fire));
    await slowPoll.settled();
    assert.deepEqual(seen, ["(alarm fire)"], "a poll slower than the old sleep");

    const handled: string[] = [];
    using slowHandler = subscribe(kb, S.siren(V.what), {
      onEvent: async ({ atom }) => {
        await new Promise((resume) => setTimeout(resume, 120));
        handled.push(atom.text);
      },
    });
    kb.add(S.siren(S.loud));
    await slowHandler.settled();
    assert.deepEqual(handled, ["(siren loud)"], "a handler slower than the old sleep");
  });

  it("queues events when nothing handles them, and drains on demand", async () => {
    const kb = fresh();
    const watch = subscribe(kb, S.alarm(V.what));
    kb.add(S.alarm(S.flood));
    await watch.settled();
    assert.equal(watch.pending, 1);
    const drained = watch.drain();
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.atom.text, "(alarm flood)");
    assert.equal(watch.pending, 0);
    watch.unsubscribe();
    assert.ok(!watch.active);
    // Ending it twice is not an error.
    watch.unsubscribe();
  });

  it("narrows to one edge when asked", async () => {
    const kb = fresh();
    using watch = subscribe(kb, S.alarm(V.what), { on: "add" });
    kb.add(S.alarm(S.smoke));
    kb.delete(S.alarm(S.smoke));
    await watch.settled();
    const drained = watch.drain();
    assert.deepEqual(drained.map((event) => event.edge), ["add"]);
  });

  it("refuses to grow a queue nobody drains", async () => {
    const kb = fresh();
    const watch = subscribe(kb, S.noisy(V.n), { queueMax: 2 });
    for (let at = 0; at < 5; at += 1) kb.add(S.noisy(at));
    await watch.settled();
    assert.throws(() => watch.drain(), SubscriberError);
    assert.ok(!watch.active, "a refused subscription ends rather than growing");
  });

  it("keeps a handler's own failure from stopping the subscription", async () => {
    const kb = fresh();
    const failures: unknown[] = [];
    using watch = subscribe(kb, S.risky(V.n), {
      onEvent: (event) => {
        if (event.atom.text.includes("1")) throw new Error("handler failed");
      },
      onError: (error) => failures.push(error),
    });
    kb.add(S.risky(1));
    kb.add(S.risky(2));
    await watch.settled();
    assert.equal(failures.length, 1);
    assert.ok(watch.active);
  });
});

describe("a live view", () => {
  it("seeds with stored atoms rather than reductions of the pattern", async () => {
    const kb = fresh();
    m.run("(= (score ada) 42)");
    kb.add(S.score(S.ada));

    using view = await LiveView.open(kb, S.score(V.who));

    assert.deepEqual([...view].map(String), ["(score ada)"]);
    assert.ok(view.has(S.score(S.ada)));
    assert.ok(!view.has(42));
  });

  it("maintains total multiplicity through seed, updates, removals, and clear", async () => {
    const kb = fresh();
    kb.add(S.alarm(S.fire));
    kb.add(S.alarm(S.fire));
    kb.add(S.other(S.noise));
    using view = await LiveView.open(kb, S.alarm(V.what));
    assert.equal(view.size, 2);
    assert.equal(view.count(S.alarm(S.fire)), 2);
    assert.ok(view.has(S.alarm(S.fire)));

    kb.add(S.alarm(S.fire));
    kb.add(S.alarm(S.flood));
    await view.settled();
    // A space is a MULTISET: the same atom twice counts twice.
    assert.equal(view.count(S.alarm(S.fire)), 3);
    assert.equal(view.size, 4);
    assert.equal([...view].length, 2, "distinct atoms, once each");

    kb.delete(S.alarm(S.fire));
    await view.settled();
    assert.equal(view.count(S.alarm(S.fire)), 2);
    assert.equal(view.size, 3);
    assert.ok(view.has(S.alarm(S.fire)));

    kb.clear();
    await view.settled();
    assert.equal(view.size, 0);
    assert.equal(view.count(S.alarm(S.fire)), 0);
    assert.deepEqual([...view], []);
  });

  it("reads size without scanning the multiplicity map", async () => {
    const kb = fresh();
    for (let at = 0; at < 256; at += 1) kb.add(S.signal(at));
    using view = await LiveView.open(kb, S.signal(V.value));

    const original = Map.prototype.values;
    let scans = 0;
    Map.prototype.values = function counted<K, V>(this: Map<K, V>): MapIterator<V> {
      scans += 1;
      return original.call(this) as MapIterator<V>;
    } as typeof Map.prototype.values;
    try {
      for (let read = 0; read < 1_024; read += 1) assert.equal(view.size, 256);
    } finally {
      Map.prototype.values = original;
    }
    assert.equal(scans, 0, "LiveView.size scanned the count map");
  });
});
