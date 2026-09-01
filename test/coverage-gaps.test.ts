/**
 * Purpose: exercise the public doors whose implementation branches previously
 *   had no caller in the Node suite: signed literal lowering, composed theory
 *   marks, manifest validation and execution, and live collection writes.
 * Assumes: npm runs this file from `extensions/node`, so a manifest-file
 *   fixture can live under the checkout's ignored `ai-tmp/` directory.
 * Guarantees:
 *   - unary minus over number and bigint literals remains literal data after
 *     lowering [tested: "folds unary minus over number and bigint literals into literal atoms";
 *     commit=cb81a53d7e040cea283df784b097f95f2868a866]
 *   - decorator composition, each manifest directive family, and Map, array
 *     and plain-object writes are driven through the same exported doors a
 *     package consumer uses [tested: npm run build --silent && node --test
 *     build/test/coverage-gaps.test.js;
 *     commit=cb81a53d7e040cea283df784b097f95f2868a866]
 *   - the README names only the three theory marks this package exports
 *     [tested: "documents the three theory marks the package exports";
 *     commit=cb81a53d7e040cea283df784b097f95f2868a866]
 * Owns resources: the suite disposes its engine after the file, closes the
 *   manifest gateway with `Symbol.asyncDispose`, and removes its manifest-file
 *   fixture in a `finally` block.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  Expression,
  type MeTTa,
  S,
  UnsupportedError,
  V,
  equation,
  grounded,
  hostValue,
  metta,
  named,
} from "../src/index.ts";
import { boot } from "../src/manifest.ts";
import { connect } from "../src/remote.ts";

let m: MeTTa;
let sequence = 0;

const fresh = (stem: string): string => {
  sequence += 1;
  return `&coverage-${stem}-${String(sequence)}`;
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("literal lowering", () => {
  it("folds unary minus over number and bigint literals into literal atoms", async () => {
    const negativeNumber = m.define(function negativeNumber(): number {
      return -1;
    });
    const negativeBigint = m.define(function negativeBigint(): bigint {
      return -9007199254740993n;
    });

    const numberEquation = negativeNumber.equations[0] as Expression;
    const bigintEquation = negativeBigint.equations[0] as Expression;
    assert.equal(hostValue(numberEquation.items[2]!), -1);
    assert.equal(hostValue(bigintEquation.items[2]!), -9007199254740993n);
    assert.equal(hostValue(await negativeNumber().one()), -1);
    assert.equal(hostValue(await negativeBigint().one()), -9007199254740993n);
  });
});

describe("theory marks", () => {
  it("composes equation, grounded, and named marks on one method", async () => {
    class MarkedTheory {
      @equation
      @grounded
      @named("absolute-exact")
      absolute(value: number): number {
        return Math.abs(value);
      }

      @equation
      @named("identity-exact")
      identity(value: number): number {
        return value;
      }

      helper(): number {
        return 0;
      }
    }

    const installed = m.theory(MarkedTheory);
    assert.deepEqual(installed.map((one) => one.head), ["absolute-exact", "identity-exact"]);
    assert.equal(String(await m.eval(S["absolute-exact"](-7)).one()), "7");
    assert.equal(String(await m.eval(S["identity-exact"](11)).one()), "11");
    assert.equal(m.effectOf("absolute-exact"), "oracleIO");
  });

  it("refuses a theory decorator applied to a non-method context", () => {
    assert.throws(
      () => equation((value: number) => value, { kind: "field", name: "value" }),
      (error: unknown) => error instanceof UnsupportedError && /not a field/.test(error.message),
    );
  });

  it("documents the three theory marks the package exports", () => {
    const readme = readFileSync(resolve(process.cwd(), "README.md"), "utf8");
    const theory = readme.slice(readme.indexOf("## Theories"), readme.indexOf("## Coordination"));
    assert.match(theory, /@equation/);
    assert.match(theory, /@grounded/);
    assert.match(theory, /@named\("exact-head"\)/);
    assert.doesNotMatch(theory, /@tabled/);
  });
});

describe("a manifest's remaining branches", () => {
  it("reports malformed wrappers, attachments, bridges, and servers before performing", async () => {
    const before = m.self.size;
    await assert.rejects(
      () =>
        boot(
          [
            '(load "not-wrapped.metta")',
            "(boot (attach local 7))",
            "(boot (bridge &edges edge kv))",
            "(boot (serve () 70000))",
          ].join("\n"),
          { metta: m },
        ),
      (error: unknown) => {
        const said = String(error);
        assert.match(said, /is not a \(boot \(\.\.\.\)\) form/);
        assert.match(said, /attach takes a space symbol/);
        assert.match(said, /bridge takes a space symbol and two shapes/);
        assert.match(said, /serve's first argument is a nonempty list/);
        assert.match(said, /serve's second argument is a port number/);
        return true;
      },
    );
    assert.equal(m.self.size, before, "an invalid manifest performed a preceding form");
  });

  it("performs attachments and repeated bridge declarations in source order", async () => {
    const firstRemote = fresh("remote-default");
    const secondRemote = fresh("remote-explicit");
    const bridged = fresh("bridge");
    m.add(S["stored-edge"](S.a, S.b));
    m.add(S["stored-arc"](S.c, S.d));

    const assembled = await boot(
      [
        `(boot (attach ${firstRemote} "http://127.0.0.1:1"))`,
        `(boot (attach ${secondRemote} "http://127.0.0.1:1" &elsewhere))`,
        `(boot (bridge ${bridged} (edge $a $b) (stored-edge $a $b)))`,
        `(boot (bridge ${bridged} (arc $a $b) (stored-arc $a $b)))`,
      ].join("\n"),
      { metta: m, token: "manifest-test-token" },
    );
    try {
      assert.equal(assembled.performed.length, 4);
      assert.equal(assembled.gateways.length, 0);
      assert.equal(String(assembled), "Boot(4 forms, 0 gateways)");
      assert.deepEqual(
        (await m.space(bridged).match(S.edge(V.from, V.to))).map((row) =>
          [String(row["from"]), String(row["to"])],
        ),
        [["a", "b"]],
      );
      assert.deepEqual(
        (await m.space(bridged).match(S.arc(V.from, V.to))).map((row) =>
          [String(row["from"]), String(row["to"])],
        ),
        [["c", "d"]],
      );
      const bridge = m.space(bridged);
      bridge.add(S.arc(S.e, S.f));
      assert.equal(m.self.has(S["stored-arc"](S.e, S.f)), true);
      assert.equal(bridge.delete(S.arc(S.e, S.f)), true);
      assert.equal(m.self.has(S["stored-arc"](S.e, S.f)), false);
      for (const form of assembled.performed) assert.equal(m.self.has(form), true);
    } finally {
      await assembled[Symbol.asyncDispose]();
      m.detach(firstRemote);
      m.detach(secondRemote);
      m.detach(bridged);
    }
  });

  it("reads a manifest file and closes the gateway it serves", async () => {
    const scratchRoot = resolve(process.cwd(), "..", "..", "ai-tmp");
    mkdirSync(scratchRoot, { recursive: true });
    const directory = mkdtempSync(join(scratchRoot, "job85717-manifest-"));
    const path = join(directory, "gateway.metta");
    const rules = join(directory, "rules.metta");
    writeFileSync(rules, "(= (coverage-loaded) 42)\n");
    writeFileSync(path, `(boot (load "${rules}"))\n(boot (serve (&self) 0))\n`);
    try {
      await using assembled = await boot(path, {
        metta: m,
        host: "127.0.0.1",
        token: "manifest-gateway-token",
      });
      assert.equal(assembled.gateways.length, 1);
      assert.equal(String(assembled), "Boot(2 forms, 1 gateways)");
      assert.equal(String(await m.eval(S["coverage-loaded"]()).one()), "42");
      const remote = connect(assembled.gateways[0]!.url, { token: "manifest-gateway-token" });
      assert.equal((await remote.serverCapabilities()).ok, true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses a bridge write admitted by more than one declaration", async () => {
    const bridged = fresh("ambiguous-bridge");
    const assembled = await boot(
      [
        `(boot (bridge ${bridged} (item $x) (stored-one $x)))`,
        `(boot (bridge ${bridged} (item $x) (stored-two $x)))`,
      ].join("\n"),
      { metta: m },
    );
    try {
      assert.throws(
        () => m.space(bridged).add(S.item(S.x)),
        /admitted by 2 bridge shapes.*invent an occurrence/,
      );
      assert.equal(m.self.has(S["stored-one"](S.x)), false);
      assert.equal(m.self.has(S["stored-two"](S.x)), false);
      assert.throws(() => m.space(bridged).add(S.other(S.x)), /does not fit this view's bridge shapes/);
    } finally {
      await assembled.close();
      m.detach(bridged);
    }
  });
});

describe("live collection writes", () => {
  it("adds and removes Map members through an attached space", () => {
    const name = fresh("map");
    const backing = new Map<string, unknown>();
    const live = m.attach(name, backing);
    try {
      live.add(S.kv(S.ada, 37));
      assert.equal(backing.get("ada"), 37);
      assert.equal(live.delete(S.kv(S.ada, 37)), true);
      assert.equal(backing.has("ada"), false);
    } finally {
      m.detach(name);
    }
  });

  it("adds and removes array members through an attached space", () => {
    const name = fresh("array");
    const backing = ["zero"];
    const live = m.attach(name, backing);
    try {
      live.add(S.kv(1, "one"));
      assert.deepEqual(backing, ["zero", "one"]);
      assert.equal(live.delete(S.kv(0, "zero")), true);
      assert.deepEqual(backing, ["one"]);
    } finally {
      m.detach(name);
    }
  });

  it("adds and removes plain-object members through an attached space", () => {
    const name = fresh("object");
    const backing: Record<string, unknown> = {};
    const live = m.attach(name, backing);
    try {
      live.add(S.kv(S.score, 42));
      assert.equal(backing["score"], 42);
      assert.equal(live.delete(S.kv(S.score, 42)), true);
      assert.equal(Object.hasOwn(backing, "score"), false);
    } finally {
      m.detach(name);
    }
  });
});
