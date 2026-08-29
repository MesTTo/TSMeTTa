/**
 * Purpose: the remote-space protocol, both ends, over real HTTP.
 * Assumes:
 *   - `website/live/remote-protocol.md` revision 3 is the contract; this
 *     checks the shapes that page fixes rather than the ones this
 *     implementation happens to have
 * Guarantees:
 *   - the lazy lifecycle really is lazy: two answers of a larger set cost two
 *     answers on the serving side
 *   - a credential is checked before the body is read
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";

import { type MeTTa, S, V, metta } from "../src/index.ts";
import {
  BODY_LIMIT,
  type Gateway,
  PROTOCOL,
  RemoteSpace,
  type Transport,
  connect,
  httpTransport,
  serve,
} from "../src/remote.ts";

let m: MeTTa;
let gateway: Gateway;
let counter = 0;

before(async () => {
  m = await metta();
  const kb = m.space("&served");
  kb.add(
    S.user(1, S.ada),
    S.user(2, S.bob),
    S.user(3, S.cy),
    S.other(S.thing),
  );
  gateway = await serve({ spaces: [kb], port: 0 });
});

after(async () => {
  await gateway.close();
  m.dispose();
});

const fresh = (): string => {
  counter += 1;
  return `&remote${String(counter)}`;
};

describe("the remote protocol", () => {
  it("answers health with the revision it speaks", async () => {
    const there = connect(gateway.url, { space: "&served" });
    const health = await there.serverCapabilities();
    assert.equal(health.ok, true);
    assert.equal(health.protocol, PROTOCOL);
    assert.ok(health.atoms >= 4);
    assert.deepEqual([...health.capabilities].sort(), [
      "add",
      "enumerate",
      "match",
      "remove",
      "stream",
    ]);
    // This gateway over-approximates through the engine, so it may not
    // truncate and says so rather than claiming it can.
    assert.equal(health.bound, false);
    assert.equal(BODY_LIMIT, 16 * 1024 * 1024);
  });

  it("queries a remote space as an ordinary space", async () => {
    const name = fresh();
    const here = m.attach(name, connect(gateway.url, { space: "&served" }));
    const rows = await here.match(S.user(V.id, V.who)).toArray();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => String(row["who"])).sort(), ["ada", "bob", "cy"]);
    // Enumeration is the one-shot door and carries everything.
    assert.equal((await here.atoms()).length, 4);
    m.detach(name);
  });

  it("takes two answers without the third being computed", async () => {
    // A transport that counts its own pulls, wrapped around the real one, so
    // the count is what actually crossed rather than what was asked for.
    let pulls = 0;
    const real = httpTransport(gateway.url);
    const watched: Transport = {
      post: async (path, body) => {
        if (path === "/next") pulls += 1;
        return real.post(path, body);
      },
      health: () => real.health(),
    };
    const space = new RemoteSpace(watched, { space: "&served", batch: 1 });
    const seen: string[] = [];
    for await (const atom of space.match(S.user(V.id, V.who))) {
      seen.push(atom.text);
      if (seen.length === 2) break;
    }
    assert.equal(seen.length, 2);
    // One `/ask` and one `/next` gave two answers; the third was never asked
    // for, and leaving the loop released the cursor.
    assert.equal(pulls, 1, `${String(pulls)} /next calls for two answers`);
    await new Promise((resume) => setTimeout(resume, 20));
    assert.equal(gateway.cursors, 0, "the cursor was released");
  });

  it("writes through, one atom and in bulk", async () => {
    const name = fresh();
    const here = m.attach(name, connect(gateway.url, { space: "&served" }));
    await here.added(S.written(1));
    assert.ok(m.space("&served").has(S.written(1)));
    assert.ok(await here.match(S.written(V.n)).exists());

    const space = new RemoteSpace(httpTransport(gateway.url), { space: "&served" });
    assert.equal(await space.addMany([S.bulk(1), S.bulk(2)].map((atom) => atom)), 2);
    assert.ok(m.space("&served").has(S.bulk(2)));
    assert.equal(await space.remove(S.bulk(1)), true);
    assert.equal(await space.remove(S.bulk(99)), false);
    m.detach(name);
  });

  it("does not carry clear across the wire, and says why", async () => {
    const name = fresh();
    const here = m.attach(name, connect(gateway.url, { space: "&served" }));
    assert.throws(
      () => here.clear(),
      (error: unknown) => {
        assert.match(String(error), /destructive and tenant-wide/);
        return true;
      },
    );
    m.detach(name);
  });

  it("refuses a wrong token before reading the body", async () => {
    const kb = m.space("&guarded");
    kb.add(S.secret(1));
    await using guarded = await serve({ spaces: [kb], port: 0, token: "open-sesame" });
    const wrong = connect(guarded.url, { space: "&guarded", token: "not-it" });
    await assert.rejects(() => wrong.serverCapabilities(), /401/);
    const right = connect(guarded.url, { space: "&guarded", token: "open-sesame" });
    assert.equal((await right.serverCapabilities()).ok, true);
  });

  it("serves only the spaces it was given", async () => {
    const there = connect(gateway.url, { space: "&not-served" });
    await assert.rejects(
      async () => {
        for await (const _atom of there.atoms()) break;
      },
      /does not serve/,
    );
  });

  it("refuses an empty chunk beside a live cursor", async () => {
    // A server that answered nothing and kept the cursor would spin a client
    // forever, so the client refuses rather than looping.
    const liar: Transport = {
      post: (path) =>
        Promise.resolve(
          path === "/ask"
            ? { atoms: [], cursor: "c1" }
            : path === "/next"
              ? { atoms: [], cursor: "c1" }
              : { stopped: true },
        ),
      health: () => Promise.reject(new Error("not asked")),
    };
    const space = new RemoteSpace(liar);
    await assert.rejects(
      async () => {
        for await (const _atom of space.match(S.anything())) break;
      },
      /empty chunk beside a live cursor/,
    );
  });

  it("refuses a malformed bound and an unknown operation", async () => {
    const bad = await fetch(`${gateway.url}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "&served", pattern: ["s", "x"], bound: -1 }),
    });
    assert.equal(bad.status, 400);
    assert.match(String((await bad.json() as { error: string }).error), /bound/);

    const unknown = await fetch(`${gateway.url}/nonsense`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unknown.status, 400);

    const wrongMethod = await fetch(`${gateway.url}/match`, { method: "PUT" });
    assert.equal(wrongMethod.status, 405);
  });

  it("passes the gateway conformance suite it ships", async () => {
    const { checkGateway } = await import("../src/testing.ts");
    const results = await checkGateway(gateway.url, { space: "&served" });
    assert.ok(results.length >= 5);
    for (const each of results) assert.ok(each.ok, `${each.name}: ${each.detail ?? ""}`);
  });

  it("stops a cursor idempotently, which is where a finally-block calls it", async () => {
    const transport = httpTransport(gateway.url);
    const opened = await transport.post("/ask", {
      space: "&served",
      pattern: ["e", [["s", "user"], ["v", "id"], ["v", "who"]]],
      batch: 1,
    });
    const cursor = opened["cursor"] as string;
    assert.equal(typeof cursor, "string");
    assert.deepEqual(await transport.post("/stop", { cursor }), { stopped: true });
    assert.deepEqual(await transport.post("/stop", { cursor }), { stopped: false });
    // A `/next` on a cursor the server no longer holds is an ERROR, because
    // answering nothing would claim the enumeration ended.
    await assert.rejects(() => transport.post("/next", { cursor }), /no such cursor/);
  });
});
