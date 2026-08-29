/**
 * Purpose: the coordination verbs on the platform's own concurrency — the
 *   race, the merge, the bounded map, the interval, the mailbox and the task.
 * Guarantees:
 *   - cancelling one cancels the work under it
 *   - a bounded channel makes its sender wait rather than dropping
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import {
  Channel,
  type MeTTa,
  MettaError,
  S,
  Task,
  V,
  answersOf,
  every,
  merge,
  metta,
  parMap,
  race,
  spawn,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
  m.add(S.seed(1), S.seed(2), S.seed(3));
});

after(() => {
  m.dispose();
});

describe("coordination", () => {
  it("cancels the losing branches", async () => {
    let losersPulled = 0;
    const slow = answersOf("slow", [1, 2, 3]).map<number | string>(async (value) => {
      losersPulled += 1;
      await new Promise((resume) => setTimeout(resume, 50));
      return value;
    });
    const quick = answersOf<number | string>("quick", ["first"]);
    assert.equal(await race([slow, quick]), "first");
    // The loser's later answers are never computed: `race` aborts its
    // siblings, and abandoning an ask closes the cursor behind it.
    const pulledAtTheEnd = losersPulled;
    await new Promise((resume) => setTimeout(resume, 80));
    assert.ok(losersPulled - pulledAtTheEnd <= 1, "the loser stopped being pulled");
  });

  it("refuses a race with nothing in it", async () => {
    await assert.rejects(() => race([]), MettaError);
  });

  it("merges several asks, ending when every branch has", async () => {
    const merged = merge(answersOf("a", [1, 2]), answersOf("b", [3]));
    const seen = await merged.toArray();
    assert.deepEqual(seen.slice().sort(), [1, 2, 3]);
  });

  it("maps with a bound on how many run at once, in input order", async () => {
    let running = 0;
    let peak = 0;
    const answers = await parMap(
      [1, 2, 3, 4, 5, 6, 7, 8],
      async (item) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resume) => setTimeout(resume, 5));
        running -= 1;
        return item * 2;
      },
      { concurrency: 3 },
    );
    assert.deepEqual(answers, [2, 4, 6, 8, 10, 12, 14, 16]);
    assert.ok(peak <= 3, `peak concurrency was ${String(peak)}`);
  });

  it("stops mapping when its signal aborts", async () => {
    const controller = new AbortController();
    const work = parMap(
      [1, 2, 3, 4],
      async (item) => {
        if (item === 2) controller.abort(new MettaError("enough"));
        await new Promise((resume) => setTimeout(resume, 1));
        return item;
      },
      { concurrency: 1, signal: controller.signal },
    );
    await assert.rejects(() => work, MettaError);
  });

  it("repeats on an interval until its signal aborts", async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    let at = 0;
    for await (const value of every(
      1,
      () => {
        at += 1;
        if (at >= 3) controller.abort();
        return at;
      },
      { signal: controller.signal },
    )) {
      seen.push(value);
    }
    assert.deepEqual(seen, [1, 2, 3]);
  });

  it("carries values through a mailbox, and makes a full one wait", async () => {
    const jobs = new Channel<number>({ max: 2 });
    await jobs.send(1);
    await jobs.send(2);
    assert.equal(jobs.size, 2);
    let sent = false;
    const blocked = jobs.send(3).then(() => {
      sent = true;
    });
    await new Promise((resume) => setImmediate(resume));
    assert.ok(!sent, "a full channel makes its sender wait rather than dropping");
    assert.equal(await jobs.receive(), 1);
    await blocked;
    assert.ok(sent);
    jobs.close();
    assert.ok(jobs.closed);
    await assert.rejects(() => jobs.send(4), MettaError);
  });

  it("iterates a mailbox until it closes", async () => {
    const jobs = new Channel<string>();
    await jobs.send("a");
    await jobs.send("b");
    jobs.close();
    const seen: string[] = [];
    for await (const job of jobs) seen.push(job);
    assert.deepEqual(seen, ["a", "b"]);
    assert.equal(await jobs.receive(), undefined);
  });

  it("starts work now and hands back a handle that awaits and cancels", async () => {
    const job = spawn(m.match(S.seed(V.n)));
    assert.ok(job instanceof Task);
    const answers = await job;
    assert.equal(answers.length, 3);
    assert.ok(job.settled);

    const cancelled = spawn(m.match(S.seed(V.n)));
    cancelled.cancel();
    await assert.rejects(() => Promise.resolve(cancelled));
  });
});

describe("taking from a channel without waiting", () => {
  it("answers what is queued, and nothing when nothing is", async () => {
    const channel = new Channel<number>();
    assert.equal(channel.tryReceive(), undefined, "nothing queued yet");
    assert.equal(channel.queued, 0);
    await channel.send(1);
    await channel.send(2);
    assert.equal(channel.queued, 2);
    assert.equal(channel.tryReceive(), 1);
    assert.equal(channel.tryReceive(), 2);
    assert.equal(channel.tryReceive(), undefined, "drained");
    // Empty and closed both answer nothing, because neither has a value;
    // `closed` is what tells them apart.
    channel.close();
    assert.equal(channel.tryReceive(), undefined);
    assert.ok(channel.closed);
  });

  it("releases a sender that a full channel had blocked", async () => {
    const channel = new Channel<number>({ max: 1 });
    await channel.send(1);
    let sent = false;
    const blocked = channel.send(2).then(() => {
      sent = true;
    });
    await new Promise((resume) => setImmediate(resume));
    assert.ok(!sent, "the second send is waiting on a full channel");
    assert.equal(channel.tryReceive(), 1);
    await blocked;
    assert.ok(sent, "taking one let it through");
  });
});
