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
 *   - a JSON object that names one key twice is refused at BOTH ends, over the
 *     documents the engine's own codec suite reads, because `JSON.parse`
 *     collapses one silently where the Python seat answers 400
 *   - every operation refusal uses the protocol's one 4xx error shape without
 *     a dead classification branch [tested: "uses one protocol error status for every refusal";
 *     commit=d6342cff24b7c087b464d9cdb13b71a3d9a115a2]
 *   - a wide integer crosses as a JSON NUMBER even though booting the engine
 *     installs `BigInt.prototype.toJSON`, which is why the codec places each
 *     literal rather than filtering through a `JSON.stringify` replacer
 *     [tested: "writes a wide integer as a JSON number after the engine has booted";
 *     commit=45615fb15d8a1d041e3ce0698d789d4d1392a0eb]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  CapabilityError,
  type MeTTa,
  MettaError,
  type Space,
  S,
  V,
  metta,
  packageRoot,
  transportToJson,
} from "../src/index.ts";
import {
  BODY_LIMIT,
  type Gateway,
  PROTOCOL,
  RemoteSpace,
  type Transport,
  connect,
  httpTransport,
  readJson,
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

  // `JSON.parse`'s reviver runs after each object is BUILT, so a repeated key
  // has already collapsed to the last value; Python's object_pairs_hook is
  // handed every pair as it is read. The engine's codec refuses the object,
  // the Python gateway answers 400 for one, and these hold this end to it.
  // The documents are the ones the engine's own suite reads
  // [source: tests/prolog/suites/libraries/json_codec.plt, document/1].
  it("reads a repeated JSON key the way the engine's codec reads one", () => {
    const repeats: readonly [string, string][] = [
      ['{"a":1,"a":2}', "a"],
      ['{"a":1,"a":1}', "a"],
      // Two spellings of one key. The repeat is in the DECODED name, which a
      // check over the raw quoted text would miss.
      ['{"a":1,"\\u0061":2}', "a"],
      ['{"\\u00e9":1,"\u00e9":2}', "\u00e9"],
      ['{"a":{"b":1,"b":2}}', "b"],
      ['[{"ok":1},{"a":0,"a":1}]', "a"],
      ['{"outer":[1,2],"k":"}","k":2}', "k"],
      ['{"__proto__":1,"__proto__":2}', "__proto__"],
      ['{"":1,"":2}', ""],
      // An astral key, where a comparison over UTF-16 units would still see
      // the repeat but the message must name the whole character.
      ['{"\u{1D400}":1,"\u{1D400}":2}', "\u{1D400}"],
    ];
    for (const [text, key] of repeats) {
      assert.throws(
        () => readJson(text),
        (raised: unknown) => {
          assert.ok(raised instanceof MettaError, text);
          // The engine's own sentence, so one refusal reads the same in both
          // seats [source: extensions/python/metta/shim.pl,
          // metta_py_json_rethrow/1 on duplicate_key/1].
          assert.equal(raised.message, `JSON object repeats the key ${key}`, text);
          return true;
        },
        text,
      );
    }
    // Two objects each naming a key once is not a repeat, and neither is a
    // key that only LOOKS repeated because a value spelled it.
    const kept: readonly [string, unknown][] = [
      ['[{"a":1},{"a":2}]', [{ a: 1 }, { a: 2 }]],
      ['{"a":1,"b":2}', { a: 1, b: 2 }],
      ['{"a":"a"}', { a: "a" }],
      ['{"a":{"a":1}}', { a: { a: 1 } }],
      ['{"a":"{\\"b\\":1,\\"b\\":2}"}', { a: '{"b":1,"b":2}' }],
      ['{"a":["b","b"]}', { a: ["b", "b"] }],
      ["[]", []],
      ["3", 3],
    ];
    for (const [text, value] of kept) assert.deepEqual(readJson(text), value, text);
    // Malformed text keeps JSON.parse's own message rather than gaining one.
    assert.throws(() => readJson('{"a":1'), SyntaxError);
  });

  // `JSON.stringify` asks a value for `toJSON` BEFORE it reaches a replacer,
  // and booting the engine installs `BigInt.prototype.toJSON`, which answers
  // the decimal STRING. So a replacer never sees the bigint and this gateway
  // wrote `["n", "1"]` for the integer 1, a string where the grammar says a
  // number. Placing each literal in the structure is what ends that, and this
  // is where the case belongs: every test in this file runs after the `before`
  // hook has booted an engine, which is exactly the state the hazard needs
  // [source: extensions/node/src/wire.ts, transportToJson and literalised].
  it("writes a wide integer as a JSON number after the engine has booted", () => {
    assert.equal(
      typeof (BigInt.prototype as { toJSON?: unknown }).toJSON,
      "function",
      "the engine no longer installs BigInt.prototype.toJSON, so this case no "
        + "longer pins the replacer hazard and the reason for literalised is gone",
    );
    const wide = 170141183460469231731687303715884118073n;
    assert.equal(transportToJson(["n", wide]), `["n",${wide}]`);
    assert.equal(transportToJson({ atom: ["n", 1n] }), '{"atom":["n",1]}');
    // The float in the same document keeps its own literal, which is the other
    // half of what a replacer could not do.
    assert.equal(transportToJson(["n", 1]), '["n",1.0]');
  });

  it("refuses a body that names one key twice", async () => {
    const repeated = await fetch(`${gateway.url}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Last-wins would read this as `&served` and answer three users, which
      // is a different request from the one a reader of the first pair saw.
      body: '{"space":"&not-served","space":"&served","pattern":["e",[["s","user"],["v","id"],["v","who"]]]}',
    });
    assert.equal(repeated.status, 400);
    assert.deepEqual(await repeated.json(), { error: "JSON object repeats the key space" });

    const once = await fetch(`${gateway.url}/match`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"space":"&served","pattern":["e",[["s","user"],["v","id"],["v","who"]]]}',
    });
    assert.equal(once.status, 200);
  });

  it("refuses an answer that names one key twice", async () => {
    const answering = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"atoms":[],"atoms":[["s","smuggled"]]}');
    });
    await new Promise<void>((resume) => answering.listen(0, "127.0.0.1", resume));
    const port = (answering.address() as { port: number }).port;
    try {
      const transport = httpTransport(`http://127.0.0.1:${String(port)}`);
      // Both client reads go through the same door: the operation answer and
      // the health answer a mutation negotiates against.
      await assert.rejects(
        () => transport.post("/atoms", { space: "&served" }),
        /JSON object repeats the key atoms/,
      );
      await assert.rejects(() => transport.health(), /JSON object repeats the key atoms/);
    } finally {
      await new Promise<void>((resume) => answering.close(() => resume()));
    }
  });

  it("uses one protocol error status for every refusal", async () => {
    const failures: readonly Error[] = [
      new CapabilityError("the space lacks enumeration"),
      new Error("the provider failed unexpectedly"),
    ];
    for (const [at, failure] of failures.entries()) {
      const name = `&failing-${String(at)}`;
      const space = {
        name,
        get size(): number {
          return 0;
        },
        atoms(): never {
          throw failure;
        },
      } as unknown as Space;
      await using failed = await serve({ spaces: [space], port: 0 });
      const response = await fetch(`${failed.url}/atoms`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space: name }),
      });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: failure.message });
    }

    const source = readFileSync(join(packageRoot, "src", "remote.ts"), "utf8");
    assert.doesNotMatch(source, /instanceof CapabilityError\s*\?\s*400\s*:\s*400/);
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
