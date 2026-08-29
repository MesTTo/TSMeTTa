/**
 * Purpose: the second wave of the Python-parity surface — the image
 *   vocabulary, entry-point discovery, wrapping and host reflection, the
 *   embedding store, host-owned matching, and a definition's own facts.
 * Guarantees:
 *   - each door is exercised against a live engine where it needs one
 *   - the custom-match seam is shown to be ABSENT until something registers,
 *     which is the property that keeps it free for programs that never use it
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  type Atom,
  CUSTOM_MATCH,
  capabilitiesOf,
  type CustomMatch,
  G,
  IMAGES,
  type MeTTa,
  S,
  type Space,
  type Term,
  UNIT,
  V,
  autoImage,
  customMatchers,
  definitionFacts,
  docOf,
  ensureRegistered,
  expr,
  imageOf,
  hostValue,
  metta,
  project,
  registerCustomMatch,
  registerToken,
  registerType,
  spanOf,
  sym,
  tokens,
  toAtom,
  construct,
  unregisterCustomMatch,
  unregisterToken,
  unregisterType,
} from "../src/index.ts";
import { TO_ATOM, build } from "../src/convert.ts";
import type { PlanClaim, SpaceProvider } from "../src/provider.ts";
import { EmbeddingStore } from "../src/arrays.ts";
import {
  ENTRY_POINT_GROUP,
  GROUPS,
  LIBRARIES_GROUP,
  SPACES_GROUP,
  discover,
  entryPoints,
  facts,
  installReflectionOps,
  loadEntryPoint,
  reflect,
  registerReflector,
  unregisterReflector,
  wrapCallable,
  wrapObject,
} from "../src/integrate.ts";
import { type AgendaPolicy, RegistryImage } from "../src/vocabularies.ts";

let m: MeTTa;
let counter = 0;
const roots: string[] = [];

const fresh = (): Space => {
  counter += 1;
  return m.space(`&cov${String(counter)}`);
};

/** A throwaway package tree, in the repository rather than in shared memory. */
const packageTree = (packages: Readonly<Record<string, unknown>>): string => {
  const scratch = join(import.meta.dirname, "..", "ai-tmp");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(join(scratch, "tree-"));
  roots.push(root);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "host", dependencies: Object.fromEntries(
      Object.keys(packages).map((name) => [name, "1.0.0"]),
    ) }),
  );
  for (const [name, manifest] of Object.entries(packages)) {
    const at = join(root, "node_modules", name);
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, "package.json"), JSON.stringify({ name, ...(manifest as object) }));
  }
  return root;
};

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("the image a type crosses under", () => {
  it("takes the four words from the engine's own vocabulary", () => {
    assert.deepEqual([...IMAGES].sort(), Object.values(RegistryImage).sort());
    assert.deepEqual([...IMAGES].sort(), ["expression", "handle", "operations", "symbol"]);
  });

  it("crosses a symbol-image type as a bare name, both ways", () => {
    class Colour {
      readonly name: string;
      constructor(name: string) {
        this.name = name;
      }
    }
    const known = new Map([["Red", new Colour("Red")], ["Green", new Colour("Green")]]);
    registerType(Colour, {
      name: "Colour",
      image: "symbol",
      toAtom: (colour) => [colour.name],
      fromAtom: (name: string) => known.get(name),
    });
    try {
      assert.equal(project(new Colour("Red")).text, "Red", "no wrapper expression");
      assert.equal(imageOf(new Colour("Red")), "symbol");
      // And back: a bare symbol is offered to every symbol-image registration.
      assert.equal(build(sym("Green")), known.get("Green"));
      assert.equal(build(sym("Nothing")), "Nothing", "an unclaimed name is still its name");
    } finally {
      unregisterType(Colour);
    }
    assert.equal(build(sym("Green")), "Green", "unregistering stops the claim");
  });

  it("crosses a handle-image type by reference even though it is registered", () => {
    class Session {
      readonly id: number;
      constructor(id: number) {
        this.id = id;
      }
    }
    registerType(Session, {
      name: "Session",
      image: "handle",
      toAtom: (session) => [session.id],
      fromAtom: (id: number) => new Session(id),
    });
    try {
      const held = new Session(7);
      const atom = project(held);
      assert.equal(build(atom), held, "the very same object");
      assert.equal(imageOf(held), "handle");
    } finally {
      unregisterType(Session);
    }
  });

  it("refuses an image outside the vocabulary", () => {
    class Odd {}
    assert.throws(
      () =>
        registerType(Odd, {
          name: "Odd",
          image: "transparent" as never,
          toAtom: () => [],
          fromAtom: () => new Odd(),
        }),
      /image must be one of/,
    );
  });

  it("answers the registration a class projects through, or says there is none", () => {
    class Plain {}
    assert.throws(() => ensureRegistered(Plain), /has no image/);
    registerType(Plain, { name: "Plain", toAtom: () => [], fromAtom: () => new Plain() });
    try {
      assert.deepEqual(ensureRegistered(Plain), {
        name: "Plain",
        image: "expression",
        explicit: true,
      });
    } finally {
      unregisterType(Plain);
    }
    // A class that projects itself needs no registration, and the default is
    // recorded rather than worked out twice.
    class Own {
      [TO_ATOM](): Term {
        return sym("own");
      }
    }
    assert.equal(ensureRegistered(Own).explicit, false);
    assert.equal(ensureRegistered(Own), ensureRegistered(Own), "recorded, not rebuilt");
  });

  it("decides transparency in constant time, and keeps an iterator opaque", () => {
    assert.equal(autoImage(1), "transparent");
    assert.equal(autoImage("text"), "transparent");
    assert.equal(autoImage(null), "transparent");
    assert.equal(autoImage([1, 2, 3]), "transparent");
    assert.equal(autoImage(new Map([[1, 2]])), "transparent");
    assert.equal(autoImage({ a: 1 }), "transparent");
    assert.equal(autoImage(Array.from({ length: 500 }, (_, at) => at)), "opaque");
    assert.equal(autoImage(new Set(Array.from({ length: 500 }, (_, at) => at))), "opaque");
    // A generator is a LINEAR source: measuring it would drain it, so it stays
    // a reference however short it is.
    function* two(): Generator<number> {
      yield 1;
      yield 2;
    }
    assert.equal(autoImage(two()), "opaque");
    assert.equal(autoImage([1, 2, 3][Symbol.iterator]()), "opaque");
    assert.equal(autoImage(new Date()), "opaque");
  });
});

describe("what a package advertises", () => {
  it("names the three groups the ecosystem uses", () => {
    assert.deepEqual([...GROUPS], ["integrations", "spaces", "libraries"]);
    assert.equal(ENTRY_POINT_GROUP, "integrations");
    assert.equal(SPACES_GROUP, "spaces");
    assert.equal(LIBRARIES_GROUP, "libraries");
  });

  it("answers advertised names without importing anything", () => {
    const root = packageTree({
      "duck-space": { metta: { spaces: { duck: "./duck.js#makeDuck" } } },
      "nars-lib": { metta: { libraries: { nars: "./metta" } } },
      quiet: { version: "1.0.0" },
    });
    const spaces = entryPoints(SPACES_GROUP, root);
    assert.deepEqual([...spaces.keys()], ["duck"]);
    assert.deepEqual(spaces.get("duck"), {
      name: "duck",
      package: "duck-space",
      specifier: "./duck.js",
      export: "makeDuck",
    });
    assert.deepEqual([...entryPoints(LIBRARIES_GROUP, root).keys()], ["nars"]);
    assert.equal(entryPoints(SPACES_GROUP, root).get("nars"), undefined);
  });

  it("refuses two packages advertising one name", () => {
    const root = packageTree({
      first: { metta: { spaces: { duck: "./a.js" } } },
      second: { metta: { spaces: { duck: "./b.js" } } },
    });
    assert.throws(() => entryPoints(SPACES_GROUP, root), /advertise duck/);
  });

  it("loads one advertised name, and lists what is installed for a typo", async () => {
    const root = packageTree({ "duck-space": { metta: { spaces: { duck: "./duck.mjs#make" } } } });
    writeFileSync(
      join(root, "node_modules", "duck-space", "duck.mjs"),
      "export const make = (size) => ({ kind: 'duck', size });\n",
    );
    assert.deepEqual(await loadEntryPoint("duck", { from: root, args: [3] }), {
      kind: "duck",
      size: 3,
    });
    await assert.rejects(
      () => loadEntryPoint("dcuk", { from: root }),
      /no package advertises dcuk under spaces; installed: duck/,
    );
  });

  it("installs an integration after what it requires, and refuses a cycle", () => {
    const ordered = discover(
      packageTree({
        top: { metta: { integrations: "./top.js", requires: ["base"] } },
        base: { metta: "./base.js" },
      }),
    );
    assert.deepEqual(ordered.map((each) => each.name), ["base", "top"]);
    assert.deepEqual(ordered[1]?.requires, ["base"]);

    assert.throws(
      () =>
        discover(
          packageTree({
            a: { metta: { integrations: "./a.js", requires: ["b"] } },
            b: { metta: { integrations: "./b.js", requires: ["a"] } },
          }),
        ),
      /require each other in a cycle: a, b/,
    );
    assert.throws(
      () => discover(packageTree({ lonely: { metta: { integrations: "./x.js", requires: ["gone"] } } })),
      /requires the integration gone/,
    );
  });
});

describe("wrapping a host thing", () => {
  it("takes one function, and named methods of one object", async () => {
    const doubled = wrapCallable(m, "cov-double", (n: number) => n * 2);
    assert.equal(String(await doubled(4).one()), "8");

    class Connection {
      rows: string[] = [];
      execute(sql: string): number {
        this.rows.push(sql);
        return this.rows.length;
      }
      close(): void {
        this.rows = [];
      }
      secret(): string {
        return "not asked for";
      }
    }
    const connection = new Connection();
    const installed = wrapObject(m, "db", connection, { execute: "db-query!", close: "db-close!" });
    assert.deepEqual(installed.map((each) => each.head), ["db-query!", "db-close!"]);
    await m.eval(S["db-query!"]("select 1")).one();
    assert.deepEqual(connection.rows, ["select 1"]);
    assert.equal(m.effectOf("db-query!"), "oracleIO");
    // Only what was listed crossed.
    assert.equal(m.effectOf("db-secret"), "unknown");
    // The object itself is readable as data.
    assert.ok(m.catalog.has(expr(sym("wrapped"), sym("db"), G(connection))));
    for (const each of installed) each.forget();

    assert.throws(() => wrapObject(m, "db", connection, ["nope"]), /has no method nope/);
  });

  it("derives a spelling when it is given a list rather than a map", async () => {
    const holder = { readBack: (): number => 41 };
    const [defined] = wrapObject(m, "cov", holder, ["readBack"]);
    assert.equal(defined?.head, "cov-read-back");
    assert.equal(String(await m.eval(S["cov-read-back"]()).one()), "41");
    defined?.forget();
  });
});

describe("reasoning about a host object", () => {
  it("reads one property, and enumerates every field as the same shape", async () => {
    const installed = installReflectionOps(m);
    assert.deepEqual(installed.map((each) => each.head), ["js-attr", "js-field"]);
    const kb = fresh();
    kb.add(S.config(G({ depth: 3, name: "deep" })));

    const one = await kb
      .match(S.config(V.c), expr(sym("js-attr"), V.c, sym("depth")))
      .toArray();
    assert.deepEqual(one.map(String), ["3"]);

    const bound = await kb.match(S.config(V.c), expr(sym("js-field"), V.c, sym("depth"))).toArray();
    assert.deepEqual(bound.map(String), ["(depth 3)"], "the bound mode answers a pair");

    const every = await kb.match(S.config(V.c), expr(sym("js-field"), V.c, V.f)).toArray();
    assert.deepEqual(every.map(String).sort(), ['(depth 3)', '(name "deep")']);
    for (const each of installed) each.forget();
  });

  it("lowers an object into facts, by whichever reflector claims it", () => {
    const kb = fresh();
    const surface = m;
    assert.equal(reflect(surface, "settings", { depth: 3, name: "deep" }), 2);
    assert.ok(surface.catalog.has(S.field(S.settings, S.depth, G(3))));
    assert.equal(reflect(surface, "list", ["a", "b", "c"]), 3);

    class Opaque {}
    assert.throws(() => reflect(surface, "x", new Opaque()), /no reflector claims Opaque/);

    const claims = (value: unknown): boolean => value instanceof Opaque;
    const lower = (): number => 99;
    registerReflector(claims, lower);
    assert.equal(reflect(surface, "x", new Opaque()), 99, "the latest registration wins");
    assert.ok(unregisterReflector(claims, lower));
    assert.ok(!unregisterReflector(claims, lower), "forgetting twice answers false");
    assert.throws(() => reflect(surface, "x", new Opaque()), /no reflector claims/);
    void kb;
  });

  it("writes many atoms at once and says how many", () => {
    const before2 = m.self.size;
    assert.equal(facts(m, [S.bulk(1), S.bulk(2)]), 2);
    assert.equal(m.self.size, before2 + 2);
    assert.equal(facts(m, []), 0);
  });
});

describe("vectors by key", () => {
  it("stores, replaces in place, and ranks by cosine similarity", () => {
    using store = new EmbeddingStore(m, { name: "cov-emb", mirror: false });
    store.add(S.dog, new Float64Array([1, 0]));
    store.add(S.cat, new Float64Array([0.9, 0.1]));
    store.add(S.fish, [0, 1]);
    assert.equal(store.size, 3);
    assert.equal(store.width, 2);

    const found = store.search([1, 0], 2);
    assert.deepEqual(found.map((each) => each.key.text), ["dog", "cat"]);
    assert.ok((found[0]?.score ?? 0) > 0.999);

    // Map semantics: replacing keeps the first-seen position.
    store.add(S.dog, new Float64Array([0, 1]));
    assert.equal(store.size, 3);
    assert.deepEqual([...store.keys].map(String), ["dog", "cat", "fish"]);
    assert.deepEqual(store.search([1, 0], 1).map((each) => each.key.text), ["cat"]);
    assert.match(String(store), /^EmbeddingStore\(3 x 2\)/);
  });

  it("copies what it is given, so a reused buffer does not rewrite the store", () => {
    using store = new EmbeddingStore(m, { name: "cov-copy", mirror: false });
    const buffer = new Float64Array([1, 0]);
    store.add(S.first, buffer);
    buffer[0] = 0;
    buffer[1] = 1;
    store.add(S.second, buffer);
    assert.deepEqual([...(store.get(S.first) ?? [])], [1, 0]);
  });

  it("refuses a vector cosine similarity has no answer for", () => {
    using store = new EmbeddingStore(m, { name: "cov-bad", mirror: false });
    assert.throws(() => store.add(S.a, [0, 0]), /zero vector has none/);
    assert.throws(() => store.add(S.a, [1, Number.NaN]), /are finite/);
    store.add(S.a, [1, 0]);
    assert.throws(() => store.add(S.b, [1, 0, 0]), /width 2/);
    assert.throws(() => store.search([1, 0], 0), /positive whole number/);
    assert.throws(() => store.search([1, 0], 1.5), /positive whole number/);
  });

  it("answers from MeTTa, and mirrors what it holds when asked", async () => {
    const kb = fresh();
    using store = new EmbeddingStore(m, { name: "cov-live", space: kb });
    store.add(S.dog, [1, 0]);
    store.add(S.fish, [0, 1]);
    assert.ok(kb.has(S.embedding(S.dog, G(store.get(S.dog) as Float64Array))));

    const nearest = await m.eval(S["cov-live-knn"](G(new Float64Array([0.9, 0.1])), 1)).toArray();
    assert.deepEqual(nearest.map(String), ["dog"]);
    const stored = await m.eval(S["cov-live-embed"](S.fish)).one();
    assert.deepEqual([...(hostValue(stored) as Float64Array)], [0, 1]);

    assert.ok(store.remove(S.dog));
    assert.ok(!store.remove(S.dog));
    assert.ok(!kb.has(S.embedding(S.dog, G(new Float64Array([1, 0])))));
    store.clear();
    assert.equal(store.size, 0);
  });
});

describe("a host value that owns its matching", () => {
  class Range implements CustomMatch {
    readonly low: number;
    readonly high: number;
    constructor(low: number, high: number) {
      this.low = low;
      this.high = high;
    }
    *[CUSTOM_MATCH](other: Atom): Iterable<Term> {
      const held = hostValue(other);
      if (typeof held === "number" && held >= this.low && held <= this.high) yield other;
    }
  }

  const held = new Range(1, 10);
  const asks = (left: Term, right: Term): Promise<Atom[]> =>
    m.eval(expr(sym("unify"), toAtom(left), toAtom(right), sym("yes"), sym("no"))).toArray();

  it("is not consulted at all until a class registers", async () => {
    assert.equal(customMatchers(m.engine).size, 0);
    // With no registration the value is an ordinary opaque handle, so it
    // matches only itself and a number is simply not it.
    assert.deepEqual((await asks(G(held), G(5))).map(String), ["no"]);
  });

  it("decides its own matches once it is registered, in either operand order", async () => {
    registerCustomMatch(m.engine, Range);
    try {
      assert.ok(customMatchers(m.engine).has(Range));
      assert.deepEqual((await asks(G(held), G(5))).map(String), ["yes"], "5 is in the range");
      assert.deepEqual((await asks(G(5), G(held))).map(String), ["yes"], "and either way round");
      assert.deepEqual((await asks(G(held), G(50))).map(String), ["no"], "50 is not");
      assert.deepEqual((await asks(G(held), G("text"))).map(String), ["no"], "nor is text");
      // A variable binds the value WHOLE, without consulting it at all.
      const bound = await m.eval(expr(sym("unify"), G(held), V.x, V.x, sym("no"))).one();
      assert.equal(hostValue(bound), held);
    } finally {
      assert.ok(unregisterCustomMatch(m.engine, Range));
    }
    assert.equal(customMatchers(m.engine).size, 0);
    assert.deepEqual((await asks(G(held), G(5))).map(String), ["no"], "the seam is off again");
    assert.ok(!unregisterCustomMatch(m.engine, Range));
  });

  it("refuses a class that does not carry the method", () => {
    class Nothing {}
    assert.throws(
      () => registerCustomMatch(m.engine, Nothing),
      /has no \[CUSTOM_MATCH\]\(\) method/,
    );
  });
});

describe("what a space declares about itself", () => {
  it("hashes its content, independently of insertion order", () => {
    const one = m.space("&dig1");
    const other = m.space("&dig2");
    one.add(S.user(1, S.ada), S.user(2, S.bob));
    other.add(S.user(2, S.bob), S.user(1, S.ada));
    assert.match(one.digest(), /^[0-9a-f]{64}$/);
    assert.equal(one.digest(), other.digest(), "same atoms, any order, same digest");
    other.add(S.user(3, S.cy));
    assert.notEqual(one.digest(), other.digest());
  });

  it("refuses to hash a space holding a live host reference", () => {
    const held = m.space("&dig3");
    held.add(S.holds(G(new Map([[1, 2]]))));
    assert.throws(() => held.digest(), /a live host object/);
  });

  it("declares fidelity, coverage, atomicity and answer order", () => {
    const kb = m.space("&declared");
    assert.equal(
      kb.handles(S.user(V.id, V.name), "Exact").text,
      "(handles &declared (user $id $name) Exact)",
    );
    assert.equal(kb.covers("writesState").text, "(covers &declared writesState)");
    assert.equal(kb.writes("transactional").text, "(writes &declared transactional)");
    assert.equal(kb.emits("best-first").text, "(emits &declared best-first)");
    assert.equal(
      kb.handles(S.scan(V.x), "Refuse", { det: "nondet" }).text,
      "(handles &declared (scan $x) Refuse nondet)",
    );
  });

  it("keeps one handles row PER SHAPE, because routing needs more than one", async () => {
    const kb = m.space("&shapes");
    kb.handles(S.user(V.id, V.name), "Exact");
    kb.handles(S.scan(V.x), "Refuse");
    const rows = await m.catalog
      .match(expr(sym("handles"), sym("&shapes"), V.shape, V.fidelity), V.fidelity)
      .toArray();
    assert.deepEqual(rows.map(String).sort(), ["Exact", "Refuse"], "both survive");
  });

  it("REPLACES a declaration rather than accumulating one", async () => {
    const kb = m.space("&redeclared");
    kb.writes("transactional");
    kb.writes("best-effort");
    // Two rows saying different things about one space is not a stronger
    // claim, it is an unanswerable one.
    const rows = await m.catalog.match(S.writes(S["&redeclared"], V.a), V.a).toArray();
    assert.deepEqual(rows.map(String), ["best-effort"]);
  });

  it("bounds a space, through the engine's own admission gate", async () => {
    const pool = m.space("&bounded");
    pool.add(S.seed(0));
    assert.equal(pool.capacity(2).text, "(capacity &bounded 2)");
    pool.add(S.a(1));
    // The gate is the ENGINE's, so it holds for every write path in.
    assert.throws(() => pool.add(S.a(2)), /pool-at-capacity/);
    assert.equal((await pool.atoms()).length, 2);
    assert.throws(() => pool.capacity(0), /positive whole number/);
    assert.throws(() => pool.capacity(1.5), /positive whole number/);
  });

  it("registers a directory of sources under an alias import! can name", () => {
    const root = join(import.meta.dirname, "..", "ai-tmp-lib", "greet");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "greet.metta"), '(= (greet $who) (format-args "hello {}" ($who)))\n');
    try {
      m.libraryPath(root, "greet");
      m.run("!(import! &self (library greet greet.metta))");
      assert.deepEqual(m.run("!(greet world)")[0]?.texts, ['"hello world"']);
      // A directory the engine could never reach is refused HERE, where the
      // caller can still act on it, rather than at the import that needed it.
      assert.throws(() => m.libraryPath("/nowhere/at/all", "x"), /directory that exists/);
    } finally {
      rmSync(join(root, ".."), { recursive: true, force: true });
    }
  });

  it("refuses a word outside the vocabulary, naming the ones there are", () => {
    const kb = m.space("&badwords");
    assert.throws(() => kb.covers("nonsense" as never), /effect is one of pureStructural/);
    assert.throws(() => kb.writes("maybe" as never), /atomicity is one of transactional/);
    assert.throws(() => kb.emits("random" as never), /policy is one of depth/);
    assert.throws(() => kb.handles(S.a, "Perhaps" as never), /fidelity is one of Exact/);
    assert.throws(
      () => kb.handles(S.a, "Exact", { det: "maybe" as never }),
      /det is one of det, semidet, nondet/,
    );
  });
});

describe("a reaction, and which one fires first", () => {
  it("runs an operation when a matching atom lands, under the match's bindings", async () => {
    const alarms = m.space("&alarms");
    const log = m.space("&alarmlog");
    const declared = alarms.reacts(S.alert(V.w), S.insert(sym("&alarmlog"), S.all(V.w)));
    assert.equal(declared.text, "(on &alarms (alert $w) (insert &alarmlog (all $w)))");
    alarms.add(S.alert(S.fire));
    assert.deepEqual((await log.atoms()).map(String), ["(all fire)"]);
    // A write that does not match the pattern reacts to nothing.
    alarms.add(S.other(S.noise));
    assert.equal((await log.atoms()).length, 1);
  });

  it("needs no install call from this host, because the ROW installs the hook", async () => {
    // The engine acts on the declaration itself, the way it does for a
    // capacity row, so a binding writes the row and nothing else.
    const alarms = m.space("&rowonly");
    const log = m.space("&rowlog");
    m.catalog.add(
      expr(sym("on"), sym("&rowonly"), S.alert(V.w), S.insert(sym("&rowlog"), S.saw(V.w))),
    );
    alarms.add(S.alert(S.flood));
    assert.deepEqual((await log.atoms()).map(String), ["(saw flood)"]);
  });

  it("orders a conflict set by the policy, provably rather than by luck", async () => {
    // BOTH reactions carry a priority, so the engine's raw enumeration is
    // declaration order and the policy is the only thing that can change it.
    // Without that the test passes under every policy: a reaction with a
    // priority is a five-item row and one without is a four-item row, and the
    // engine reads the five-item rows first, so a mixed pair is already in
    // priority order before any policy runs.
    const fired = async (policy: AgendaPolicy, at: number): Promise<string[]> => {
      const alarms = m.space(`&agenda${String(at)}`);
      const log = m.space(`&agendalog${String(at)}`);
      alarms.reacts(S.alert(V.w), S.insert(sym(`&agendalog${String(at)}`), S.low()), {
        priority: 1,
      });
      alarms.reacts(S.alert(V.w), S.insert(sym(`&agendalog${String(at)}`), S.high()), {
        priority: 9,
      });
      alarms.agenda(policy);
      alarms.add(S.alert(S.fire));
      return (await log.atoms()).map(String);
    };
    assert.deepEqual(await fired("declaration", 1), ["(low)", "(high)"], "as written");
    assert.deepEqual(await fired("priority", 2), ["(high)", "(low)"], "highest number first");
    assert.deepEqual(await fired("recency", 3), ["(high)", "(low)"], "last declared first");
  });

  it("keeps one policy per space and refuses a word it does not have", async () => {
    const alarms = m.space("&agendaone");
    alarms.agenda("recency");
    alarms.agenda("specificity");
    const rows = await m.catalog
      .match(expr(sym("agenda"), sym("&agendaone"), V.p), V.p)
      .toArray();
    assert.deepEqual(rows.map(String), ["specificity"], "one policy, not two");
    assert.throws(() => alarms.agenda("nonsense" as never), /policy is one of declaration/);
    assert.throws(() => alarms.agenda("user"), /names the MeTTa function that scores/);
    assert.throws(() => alarms.agenda("priority", { by: "score" }), /no other policy takes one/);
    assert.equal(alarms.agenda("user", { by: "score" }).text, "(agenda &agendaone user score)");
  });

  it("refuses a priority that is not a whole number", () => {
    const alarms = m.space("&agendatwo");
    assert.throws(
      () => alarms.reacts(S.alert(V.w), S.insert(sym("&x"), S.y()), { priority: 1.5 }),
      /priority is a whole number/,
    );
  });
});

describe("a notation of the host's own", () => {
  it("parses a lexeme of its own into whatever the host says", () => {
    registerToken(m.engine, "#[0-9a-f]{6}", (lexeme) => G(parseInt(lexeme.slice(1), 16)));
    try {
      assert.deepEqual([...tokens(m.engine).keys()], ["#[0-9a-f]{6}"]);
      // The constructor receives the COMPLETE matched lexeme.
      assert.deepEqual(m.run("!(colour #ff8800)")[0]?.texts, ["(colour 16746496)"]);
      assert.equal(String(construct(m.engine, "#[0-9a-f]{6}", "#0000ff")), "255");
    } finally {
      assert.ok(unregisterToken(m.engine, "#[0-9a-f]{6}"));
    }
    // Once removed the lexeme is an ordinary symbol again.
    assert.deepEqual(m.run("!(colour #ff8800)")[0]?.texts, ["(colour #ff8800)"]);
    assert.ok(!unregisterToken(m.engine, "#[0-9a-f]{6}"));
  });

  it("replaces a pattern's meaning, for future parses only", () => {
    const held = m.run("!(mark @1)");
    void held;
    registerToken(m.engine, "@[0-9]+", () => G("first"));
    try {
      assert.deepEqual(m.run("!(mark @1)")[0]?.texts, ['(mark "first")']);
      registerToken(m.engine, "@[0-9]+", () => G("second"));
      assert.deepEqual(m.run("!(mark @1)")[0]?.texts, ['(mark "second")']);
      assert.equal(tokens(m.engine).size, 1, "one class, not two");
    } finally {
      unregisterToken(m.engine, "@[0-9]+");
    }
  });

  it("takes a RegExp as readily as a string, and refuses one carrying flags", () => {
    registerToken(m.engine, /~[a-z]+/, (lexeme) => G(lexeme.slice(1).toUpperCase()));
    try {
      assert.deepEqual(m.run("!(shout ~hello)")[0]?.texts, ['(shout "HELLO")']);
    } finally {
      unregisterToken(m.engine, /~[a-z]+/);
    }
    assert.throws(() => registerToken(m.engine, /~[a-z]+/gi, () => G(1)), /carries no flags/);
    assert.throws(() => registerToken(m.engine, "", () => G(1)), /cannot be empty/);
  });
});

describe("a transaction", () => {
  it("commits every write together, and rolls them back on an empty answer", async () => {
    const kb = m.space("&txtest");
    assert.deepEqual(kb.transaction(S["add-atom"](kb.handle, S.kept(1))).map(String), ["()"]);
    assert.deepEqual((await kb.atoms()).map(String), ["(kept 1)"]);
    // An EMPTY answer set is the engine's own rollback law for the form.
    // `(superpose ())` is the empty answer set, which is the rollback signal.
    kb.transaction(S.chain(S["add-atom"](kb.handle, S.gone(1)), V.ignored, S.superpose(UNIT)));
    assert.deepEqual((await kb.atoms()).map(String), ["(kept 1)"], "the write did not survive");
  });

  it("refuses a host callable, and says why it cannot be one", () => {
    const kb = m.space("&txrefuse");
    assert.throws(
      () => kb.transaction((() => 1) as never),
      /a TERM rather than a callable/,
    );
    // A NAME is callable too and is not refused, because it carries an atom.
    assert.deepEqual(kb.transaction(S["add-atom"](kb.handle, S.viaName(1))).map(String), ["()"]);
  });
});

describe("a provider that claims a whole conjunction", () => {
  const EDGES: readonly (readonly [number, number])[] = [[1, 2], [2, 3], [3, 1]];

  /** The triangle join, answered by the provider itself. */
  const joining = (options: { readonly claim: readonly number[] }): SpaceProvider & {
    calls: number;
  } => {
    const held = {
      calls: 0,
      *atoms(): Generator<Atom> {
        for (const [from, to] of EDGES) yield S.edge(from, to);
      },
      plan(patterns: readonly Atom[]): PlanClaim | undefined {
        held.calls += 1;
        if (patterns.length < 2) return undefined;
        const rows: Atom[][] = [];
        for (const [a, b] of EDGES) {
          for (const [c, d] of EDGES) {
            if (b === c) rows.push([S.edge(a, b), S.edge(c, d)]);
          }
        }
        return {
          claimed: options.claim,
          rows: rows.map((row) => options.claim.map((at) => row[at] as Atom)),
        };
      },
    };
    return held;
  };

  it("answers a conjunction over a provider needing two live enumerations at once", async () => {
    // The regression this seat lost answers to. A conjunction opens an inner
    // enumeration while the outer one is suspended; a host that held ONE
    // iterator let the inner replace the outer, and the query answered its
    // first row and stopped. A native space answered all three throughout,
    // which is what made it silent.
    let enumerations = 0;
    const provider: SpaceProvider = {
      *atoms(): Generator<Atom> {
        enumerations += 1;
        for (const [from, to] of EDGES) yield S.edge(from, to);
      },
    };
    m.attach("&nested", provider);
    const answered = m.run("!(match &nested (, (edge $x $y) (edge $y $z)) ($x $y $z))");
    assert.deepEqual(answered[0]?.texts, ["(1 2 3)", "(2 3 1)", "(3 1 2)"]);
    assert.equal(enumerations, 4, "one outer enumeration and one inner per outer row");

    const native = m.space("&nativecmp");
    for (const [from, to] of EDGES) native.add(S.edge(from, to));
    assert.deepEqual(
      m.run("!(match &nativecmp (, (edge $x $y) (edge $y $z)) ($x $y $z))")[0]?.texts,
      answered[0]?.texts,
      "a provider answers what a native space does",
    );
    m.detach("&nested");
  });

  it("keeps a stream that was cut from spoiling the next one", async () => {
    // A stream the engine abandons part way is not drained, so the host still
    // holds it. Taking one answer and then asking again must not resume the
    // abandoned one.
    let opened = 0;
    const provider: SpaceProvider = {
      *atoms(): Generator<Atom> {
        opened += 1;
        for (let at = 0; at < 50; at += 1) yield S.n(at);
      },
    };
    const kb = m.attach("&cut", provider);
    // `take(1)` ABANDONS the stream, which is the shape this is about: `one()`
    // would drain it to prove there is exactly one answer.
    assert.deepEqual((await kb.match(S.n(V.k), V.k).take(1).toArray()).map(String), ["0"]);
    assert.deepEqual(
      (await kb.match(S.n(V.k), V.k).take(1).toArray()).map(String),
      ["0"],
      "the second ask starts afresh",
    );
    assert.equal((await kb.match(S.n(V.k), V.k).toArray()).length, 50);
    assert.ok(opened >= 3);
    m.detach("&cut");
  });

  it("derives plan from the plan method and pushdown from the pushdown one", () => {
    // The engine's `plan` is the JOIN planner; a per-pattern filter classifier
    // is a different seam and has its own word. The whole vocabulary is
    // asserted in events.test.ts, which is its home.
    assert.deepEqual(capabilitiesOf({ pushdown: () => "exact" }), ["pushdown"]);
    assert.deepEqual(capabilitiesOf({ plan: () => undefined }), ["plan"]);
    // `rules` is a promise about content, so it is declared and not derived.
    assert.deepEqual(capabilitiesOf({ rules: true }), ["rules"]);
  });

  it("claims a whole conjunction and answers its own join", async () => {
    const provider = joining({ claim: [0, 1] });
    m.attach("&joined", provider);
    const answered = m.run("!(match &joined (, (edge $x $y) (edge $y $z)) ($x $y $z))");
    assert.equal(provider.calls, 1, "offered the conjunction whole, once");
    assert.deepEqual(answered[0]?.texts, ["(1 2 3)", "(2 3 1)", "(3 1 2)"]);
    m.detach("&joined");
  });

  it("leaves what it did not claim to the engine", async () => {
    // A PARTIAL claim: the provider takes the first pattern and the engine
    // plans the second, which is what keeps the seam from being all-or-nothing.
    const provider = joining({ claim: [0] });
    m.attach("&half", provider);
    const answered = m.run("!(match &half (, (edge $x $y) (edge $y $z)) ($x $y $z))");
    assert.deepEqual(answered[0]?.texts, ["(1 2 3)", "(2 3 1)", "(3 1 2)"]);
    m.detach("&half");
  });

  it("declines, and the engine plans it exactly as it always did", async () => {
    const declining: SpaceProvider = {
      *atoms(): Generator<Atom> {
        for (const [from, to] of EDGES) yield S.edge(from, to);
      },
      plan: () => undefined,
    };
    m.attach("&declined", declining);
    const answered = m.run("!(match &declined (, (edge $x $y) (edge $y $z)) ($x $y $z))");
    assert.deepEqual(answered[0]?.texts, ["(1 2 3)", "(2 3 1)", "(3 1 2)"]);
    m.detach("&declined");
  });

  it("refuses a claim that names a position twice or one nobody offered", async () => {
    for (const [claim, complaint] of [
      [[0, 0], /claimed position 0 twice/],
      [[0, 9], /claimed position 9 of 2 patterns/],
    ] as const) {
      const provider = joining({ claim: [0, 1] });
      const bad: SpaceProvider = { ...provider, plan: () => ({ claimed: claim, rows: [] }) };
      m.attach("&badclaim", bad);
      assert.throws(
        () => m.run("!(match &badclaim (, (edge $x $y) (edge $y $z)) ($x $y $z))"),
        complaint,
      );
      m.detach("&badclaim");
    }
  });

  it("holds a planner's claim to the join it would have replaced", async () => {
    const { checkSpaceProvider } = await import("../src/testing.ts");
    const honest = joining({ claim: [0, 1] });
    const kb = m.attach("&checked", honest);
    const results = await checkSpaceProvider(kb, honest, [], {
      conjunctions: [[S.edge(V.x, V.y), S.edge(V.y, V.z)]],
    });
    const claim = results.find((each) => each.name.startsWith("the planner's claim is exact"));
    assert.ok(claim?.ok, claim?.detail ?? "no planner check ran");
    m.detach("&checked");

    // A provider that claims and answers something else is caught, because a
    // claim means answering EXACTLY and there is no cheap re-check for a join.
    const lying: SpaceProvider = {
      *atoms(): Generator<Atom> {
        for (const [from, to] of EDGES) yield S.edge(from, to);
      },
      plan: (patterns) => ({ claimed: patterns.map((_, at) => at), rows: [] }),
    };
    const other = m.attach("&lying", lying);
    const caught = await checkSpaceProvider(other, lying, [], {
      conjunctions: [[S.edge(V.x, V.y), S.edge(V.y, V.z)]],
    });
    const failed = caught.find((each) => each.name.startsWith("the planner's claim is exact"));
    assert.equal(failed?.ok, false);
    assert.match(failed?.detail ?? "", /not exact/);
    m.detach("&lying");

    // And a provider that declares plan with nothing to check it against says
    // so rather than reading as covered.
    const unchecked = await checkSpaceProvider(m.self, { plan: () => undefined }, []);
    assert.equal(unchecked[0]?.ok, false);
    assert.match(unchecked[0]?.detail ?? "", /no conjunction was offered/);
  });
});

describe("a definition's own facts", () => {
  it("reads them without defining it", () => {
    const before2 = m.self.size;
    const read = definitionFacts(m, function twice(n: number): number {
      return n * 2;
    });
    assert.deepEqual(read.freeVariables, []);
    assert.equal(read.effect, "pureStructural");
    assert.ok(read.pure);
    assert.equal(m.self.size, before2, "nothing was written");
    assert.equal(read.span.startLine, 1);
    assert.ok(read.span.source.startsWith("function twice"));
  });

  it("names every head the body reaches, and joins their effects", () => {
    m.run("(= (cov-helper $x) $x)");
    const read = definitionFacts(m, function outer(n: number): number {
      return covHelper(n) + addAtom(n);
    });
    assert.deepEqual([...read.freeVariables], ["addAtom", "covHelper"]);
    // `add-atom` writes, so the join is a write however pure the arithmetic is.
    assert.equal(read.effect, "writesState");
    // `cov-helper` is defined by an equation, so the engine declares no effect
    // for it and it is named rather than counted.
    assert.deepEqual([...read.unresolved], ["covHelper"]);
    assert.ok(!read.pure);
  });

  it("does not claim purity for a head it could not resolve", () => {
    // The engine declares an effect for an operation and a builtin, and none
    // for a head defined by equations, so an unresolved head is reported
    // rather than guessed at in either direction.
    const read = definitionFacts(m, function reaches(n: number): number {
      return neverHeardOfThis(n);
    });
    assert.deepEqual([...read.unresolved], ["neverHeardOfThis"]);
    assert.equal(read.effect, "pureStructural", "nothing known says otherwise");
    assert.ok(!read.pure, "and it was not SHOWN pure");

    // A name the CALLER supplied is a value rather than a head: it declares
    // nothing and is not unresolved either.
    const scoped = definitionFacts(
      m,
      function usesScope(n: number): number {
        return n + limit;
      },
      { scope: { limit: 3 } },
    );
    assert.deepEqual([...scoped.unresolved], []);
    assert.ok(scoped.pure);
  });

  it("puts a span where the caller says the text came from", () => {
    const span = spanOf("function f() {\n  return 1;\n}", { path: "/src/f.ts", line: 40, column: 2 });
    assert.deepEqual(span, {
      path: "/src/f.ts",
      startLine: 40,
      startColumn: 2,
      endLine: 42,
      endColumn: 1,
      source: "function f() {\n  return 1;\n}",
    });
  });

  it("recovers a block comment the body carries", () => {
    assert.equal(docOf("function f() {\n  /** What it does.\n   * More. */\n  return 1;\n}"),
      "What it does.\nMore.");
    assert.equal(docOf("function f() { return 1; }"), undefined);
  });
});

declare function covHelper(n: number): number;
declare function addAtom(n: number): number;
declare function neverHeardOfThis(n: number): number;
declare const limit: number;
