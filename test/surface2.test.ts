/**
 * Purpose: the last of the surface — the settings, the version, the row table,
 *   the ambient space, the rendering registry, the constant atoms, and the
 *   testing helpers a program uses to hold its own MeTTa to account.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { inspect } from "node:util";
import { after, before, describe, it } from "node:test";

import {
  ATOM_TYPE,
  Config,
  FALSE,
  G,
  In,
  type MeTTa,
  MettaError,
  Rows,
  S,
  TRUE,
  UNDEFINED,
  UNIT,
  V,
  config,
  isTransportError,
  metta,
  registerRepr,
  unregisterRepr,
  version,
} from "../src/index.ts";
import {
  checkMintedHandles,
  checkReplay,
  checkTwin,
  measureCounters,
  names,
  recordReplay,
  Random,
} from "../src/testing.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("the settings and the version", () => {
  it("reads a setting from the environment, and refuses a bad one", () => {
    const fromEnvironment = new Config({ METTA_DISPLAY_ROWS: "5" });
    assert.equal(fromEnvironment.displayRows, 5);
    assert.equal(fromEnvironment.declarationLimit, 512, "the code's default stands");
    assert.throws(() => new Config({ METTA_DISPLAY_ROWS: "many" }), /positive integer/);
    assert.throws(() => new Config({ METTA_STACK_LIMIT: "-1" }), /positive integer/);
  });

  it("has no stack ceiling of its own, because this build is 32-bit", () => {
    // The Python default is eight gigabytes and a WebAssembly SWI cannot
    // represent it; unset means the build's own.
    assert.equal(new Config({}).stackLimit, undefined);
  });

  it("freezes a startup setting once an engine exists", () => {
    assert.ok(config.started, "an engine booted in `before`");
    assert.throws(() => config.configure({ heartbeatInterval: 12_345 }), /cannot change after/);
    // A setting read at each use may still change.
    config.configure({ displayRows: 7 });
    assert.equal(config.displayRows, 7);
    config.configure({ displayRows: 100 });
    assert.deepEqual(Object.keys(config.toJSON()).sort(), [
      "declarationLimit",
      "displayRows",
      "heartbeatInterval",
    ]);
    assert.match(String(config), /^Config\(/);
  });

  it("answers the version its manifest declares", () => {
    assert.match(version(), /^\d+\.\d+\.\d+/);
    assert.equal(version(), version(), "read once and remembered");
  });
});

describe("the row table", () => {
  it("knows its own columns, and shows them", async () => {
    m.add(S.parent(S.tom, S.bob), S.parent(S.bob, S.ann));
    const rows = await m.match(S.parent(V.parent, V.child)).rows();
    assert.ok(rows instanceof Rows);
    assert.deepEqual(rows.columns, ["parent", "child"]);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.column("child").map(String), ["bob", "ann"]);
    assert.throws(() => rows.column("nobody"), /no column nobody/);
    assert.match(rows.toTable(), /^parent {2}child\n------ {2}-----\ntom {5}bob/);
    // An ordinary array underneath: mapping one answers a plain array, because
    // the columns belong to the query rather than to whatever it mapped into.
    assert.ok(Array.isArray(rows.map((row) => row["child"])));
    assert.ok(!(rows.map((row) => row["child"]) instanceof Rows));
    assert.match(inspect(rows), /parent {2}child/);
    assert.match(String(new Rows(["a"], [])), /^Rows\(0 x a\)/);
  });
});

describe("the ambient space", () => {
  it("answers the engine's own default outside any evaluation", () => {
    assert.equal(m.currentSpace().name, "&self");
  });

  it("answers the calling program's space inside a host operation", async () => {
    let seen = "";
    m.op(function whereAmI(): number {
      seen = m.currentSpace().name;
      return 1;
    });
    const kb = m.space("&elsewhere");
    await kb.eval(S.whereAmI()).one();
    assert.equal(seen, "&elsewhere", "the operation ran in its caller's space");
  });
});

describe("rendering a host type", () => {
  it("shows what a caller said, and stops when the saying is withdrawn", () => {
    assert.match(String(G(new Date(0))), /^\(js Date\)$/);
    registerRepr(Date, (when) => `(date "${when.toISOString()}")`);
    assert.equal(String(G(new Date(0))), '(date "1970-01-01T00:00:00.000Z")');
    assert.ok(unregisterRepr(Date));
    assert.match(String(G(new Date(0))), /^\(js Date\)$/);
    assert.ok(!unregisterRepr(Date), "forgetting twice answers false");
  });
});

describe("the constant atoms", () => {
  it("are the atoms a program would otherwise spell by hand", () => {
    assert.equal(TRUE.text, "True");
    assert.equal(FALSE.text, "False");
    assert.equal(UNIT.text, "()");
    assert.equal(UNDEFINED.text, "%Undefined%");
    assert.equal(ATOM_TYPE.text, "Atom");
    assert.equal(In(S.x, S.set).text, "(in x set)");
    // The engine agrees about the two it can decide.
    assert.equal(String(G(true)), TRUE.text);
  });

  it("tells a transport failure from a refusal", () => {
    assert.ok(!isTransportError(new MettaError("plain")));
  });
});

describe("the testing helpers", () => {
  it("holds two implementations to the same answers", async () => {
    const results = await checkTwin(
      [1, 2, 3],
      (n) => [S.answer(n * 2)],
      (n) => [S.answer(n + n)],
    );
    assert.ok(results.every((each) => each.ok));

    const differing = await checkTwin([1], (n) => [S.answer(n)], () => [S.answer(99)]);
    assert.equal(differing[0]?.ok, false);
    assert.match(differing[0]?.detail ?? "", /left answered/);
  });

  it("compares answers as multisets up to alpha equivalence", async () => {
    const results = await checkTwin(
      ["one"],
      () => [S.f(V.x), S.g(1)],
      () => [S.g(1), S.f(V.y)],
    );
    assert.ok(results[0]?.ok, results[0]?.detail ?? "");
  });

  it("records answers and holds a later run to them", async () => {
    m.run("(= (twice $n) (* 2 $n))");
    const recorded = await recordReplay([
      ["twice 3", () => m.eval(S.twice(3)).toArray()],
      ["twice 4", () => m.eval(S.twice(4)).toArray()],
    ]);
    assert.deepEqual(recorded[0], { asked: "twice 3", answered: ["6"] });
    const replayed = await checkReplay(recorded, (asked) => {
      const at = Number(asked.split(" ")[1]);
      return m.eval(S.twice(at)).toArray();
    });
    assert.ok(replayed.every((each) => each.ok));

    const drifted = await checkReplay(recorded, () => [S.wrong()]);
    assert.equal(drifted[0]?.ok, false);
    assert.match(drifted[0]?.detail ?? "", /recorded 6, now \(wrong\)/);
  });

  it("measures what a stretch of work cost", async () => {
    const { value, spent } = await measureCounters(m.engine.counters, async () => {
      await m.eval(S.twice(21)).one();
      return "done";
    });
    assert.equal(value, "done");
    assert.ok(spent.crossings > 0, "an ask crosses");
    assert.ok(spent.inferences > 0, "and the engine did work");
  });

  it("refuses a provider that fabricates a space identity", async () => {
    // The engine mints space identities; a backend answers INTO spaces. A
    // fabricated one is a reference nobody can resolve.
    const honest = await checkMintedHandles(
      { *atoms() { yield S.row(S.a, S["&known"]); } },
      ["&known"],
    );
    assert.ok(honest.every((each) => each.ok), honest[0]?.detail ?? "");

    const inventing = await checkMintedHandles({ *atoms() { yield S.row(S["&made-up"]); } });
    assert.equal(inventing[0]?.ok, false);
    assert.match(inventing[0]?.detail ?? "", /never minted/);
    assert.match(inventing[0]?.detail ?? "", /&made-up/);
  });

  it("draws plausible names, reproducibly", () => {
    const random = new Random(3);
    const source = names();
    const drawn = Array.from({ length: 5 }, () => source.generate(random, 0));
    assert.equal(drawn.length, 5);
    assert.deepEqual(
      Array.from({ length: 5 }, () => source.generate(new Random(3), 0))[0],
      Array.from({ length: 5 }, () => source.generate(new Random(3), 0))[0],
    );
  });
});
