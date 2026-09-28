/**
 * Purpose: hold the examples lane's own rules to their guarantees: what counts
 *   as a claim, what the source scan refuses, how a program is classified,
 *   what a DIVERGENCE may declare and how one is written, when a twin agrees
 *   with its original, and how the corpus is presented to a run.
 * Assumes: it runs from the corpus root, where it writes its planted programs
 *   under ai-tmp/scan-test/ and its planted corpora under ai-tmp/root-test/.
 * Guarantees: each rule has a case that must fail as well as one that must pass,
 *   so a rule that stopped firing would turn this red [tested 2026-09-28T19:11:58+10:00: node
 *   tools/examples.mjs].
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";

import { type Atom, type Form, S, toTransport, transportToJson, wireFromAtom } from "tsmetta";

// The counting module's default export is called the way a twin calls
// node:assert/strict's, members and all, which is the path this test proves.
/* oxlint-disable import/no-named-as-default-member */
import counted, { claims, deepEqual, ok } from "./assert.ts";
import {
  type Divergence,
  type Residue,
  SEAT,
  checkedDivergence,
  checkedResidue,
  coverage,
  isTwin,
  originalOf,
  twinOf,
} from "./corpus.ts";
import { declared } from "./declare.ts";
import {
  type Difference,
  agree,
  generalize,
  keptProgram,
  mergeVolatile,
  storedDifference,
  surplus,
  walkForms,
} from "./lane.ts";
import { attributeFor, scan } from "./scan.ts";
import { presentRoot } from "./root.ts";
import type { Report } from "./side.ts";

test("counts every way a program can reach an assertion", () => {
  const before = claims();
  counted(true);
  counted.equal(1, 1);
  counted.strict.deepEqual([1], [1]);
  deepEqual({ a: 1 }, { a: 1 });
  ok(true);
  assert.equal(claims() - before, 5);
  assert.throws(() => counted.equal(1, 2), counted.AssertionError);
  assert.equal(claims() - before, 6, "a failing assertion is still a claim made");
});

test("names the attribute a bracket door should have been", () => {
  assert.equal(attributeFor("S", "parent"), "parent");
  assert.equal(attributeFor("S", "car-atom"), "carAtom");
  assert.equal(attributeFor("fn", "lib_he"), "lib_he");
  assert.equal(attributeFor("S", "prime?"), undefined);
  assert.equal(attributeFor("S", "="), undefined);
  assert.equal(attributeFor("S", "isPrime"), undefined, "the map would send isPrime to is-prime");
  assert.equal(attributeFor("V", "x"), "x");
  assert.equal(attributeFor("V", "my-var"), undefined);
});

/** One scanned program, written as both its source and its compiled form. */
function write(name: string, body: string): [string, string] {
  mkdirSync("ai-tmp/scan-test", { recursive: true });
  writeFileSync(`ai-tmp/scan-test/${name}.ts`, body);
  writeFileSync(`ai-tmp/scan-test/${name}.js`, body);
  return [`ai-tmp/scan-test/${name}.ts`, `ai-tmp/scan-test/${name}.js`];
}

test("scans a twin for source text and exact doors where the attribute reaches the atom", () => {
  const [cleanTs, cleanJs] = write(
    "clean",
    'import { S, V, fn } from "tsmetta";\nS.parent(S.tom, V.x); S["prime?"]; S["="](S.f(), 1); fn.carAtom(S.x); S("isPrime");\n',
  );
  assert.deepEqual(scan(cleanTs, cleanJs), []);
  const [dirtyTs, dirtyJs] = write(
    "dirty",
    'import assert from "node:assert";\nimport { S, V, fn } from "tsmetta";\n' +
      'm.run("(= (f) 1)"); S("parent"); S["car-atom"]; V("x"); S("="); fn.parse("(f)"); m.loadFile("examples/a.metta");\n' +
      'm.fn.sread(G("(f a)")); kb.fn.parseCommand("(f"); S["&self"];\n',
  );
  const findings = scan(dirtyTs, dirtyJs);
  assert.equal(findings.length, 11, findings.join("\n"));
  const [readerTs, readerJs] = write(
    "reader",
    '// reads MeTTa text: the original is about the reader\nimport { fn } from "tsmetta";\nm.parse("(f a)"); fn.parse("(f)"); m.fn.parse(G("(g)"));\n',
  );
  assert.deepEqual(scan(readerTs, readerJs), []);
});

/** A program reaching the engine with MeTTa text every way the scan knows, after READS. */
const program = (reads: string): string =>
  reads +
  'import { S, fn, metta } from "tsmetta";\nimport { run } from "tsmetta/ambient";\nimport { lint } from "tsmetta/lint";\n' +
  "const m = await metta();\nconst space = m.space();\nconst source = String(42);\n" +
  "m.run(source); space.parse(source); this.forms(source); m.engine.read(source);\n" +
  // tsc's output for a top-level `using held = await metta()`.
  "var held;\nheld = __addDisposableResource(env_1, await metta(), false);\nheld.q(source);\n" +
  "run(source); await lint(m, source);\n" +
  'm.fn.traceSource(m.self, source, [], 10); fn["observe-source"](m.self, "f", source); m.fn("sread")(source);\n' +
  'fn["write-file!"]("p.metta", "(= (package name) example)"); const typed = "(: f (-> Number Number))"; const bang = `!(f 1)`;\n' +
  'm.run("(= (f) 1)");\n';

test("scans a twin for MeTTa text however it reaches the engine", () => {
  const [dirtyTs, dirtyJs] = write("text-dirty", program(""));
  const findings = scan(dirtyTs, dirtyJs);
  assert.deepEqual(
    findings.map((finding) => finding.replace(/^line \d+: /, "")).toSorted(),
    [
      ".forms(...) is handed MeTTa source text; build the terms instead",
      ".parse(...) is handed MeTTa source text; build the terms instead",
      ".q(...) is handed MeTTa source text; build the terms instead",
      ".read(...) is the Engine's reader, handed MeTTa source text; build the terms instead",
      ".run(...) is handed MeTTa source text; build the terms instead",
      ".run(...) is handed MeTTa source text; build the terms instead",
      // The exact-name rule reads the two doors a head's attribute reaches.
      'fn["observe-source"] is fn.observeSource',
      "lint(...) reads MeTTa source text; build the terms instead",
      'm.fn("sread") is m.fn.sread',
      "run(...) reads MeTTa source text; build the terms instead",
      'the reader head fn["observe-source"] is handed MeTTa text; only a twin of a reading example may',
      'the reader head m.fn("sread") is handed MeTTa text; only a twin of a reading example may',
      "the reader head m.fn.traceSource is handed MeTTa text; only a twin of a reading example may",
      'the string "!(f 1)" is a MeTTa program; build the terms instead',
      'the string "(: f (-> Number Number))" is a MeTTa program; build the terms instead',
      'the string "(= (package name) example)" is a MeTTa program; build the terms instead',
    ],
    findings.join("\n"),
  );
  // The marker lets a program read text; it spells its doors as any twin does.
  const [markedTs, markedJs] = write(
    "text-marked",
    program("// reads MeTTa text: the planted program's subject is its source\n"),
  );
  assert.deepEqual(
    scan(markedTs, markedJs)
      .map((finding) => finding.replace(/^line \d+: /, ""))
      .toSorted(),
    ['fn["observe-source"] is fn.observeSource', 'm.fn("sread") is m.fn.sread'],
  );
  // Another library's parse and run are not the engine's, a term built with S
  // is data, and an assertion's string is a value compared.
  const [cleanTs, cleanJs] = write(
    "text-clean",
    'import assert from "node:assert/strict";\nimport { S, metta } from "tsmetta";\n' +
      'const { z } = await import("zod").catch(() => process.exit(0));\n' +
      "const m = await metta();\nconst Person = z.object({});\nPerson.parse({}); insert.run({ name: 1 });\n" +
      'export const DIVERGENCE = { originalOnly: { "&self": ["(= (f) 1)"] }, twinOnly: {}, reason: "planted" };\n' +
      'S.type(S.parse(S.Number)); assert.equal(m.text(S.f()), "(= (f) 1)");\n',
  );
  assert.deepEqual(scan(cleanTs, cleanJs), []);
});

test("reads every fn door by fnHead", () => {
  assert.equal(attributeFor("fn", "*"), "mul");
  assert.equal(attributeFor("fn", ">="), "gte");
  assert.equal(attributeFor("fn", "pow-math"), "pow");
  assert.equal(attributeFor("fn", "mul"), undefined, "fn.mul is *, so only a call spells mul");
  assert.equal(attributeFor("S", "mul"), "mul");
  const [cleanTs, cleanJs] = write(
    "asking-clean",
    'import { S } from "tsmetta";\nm.fn("mul")(1, 2); m.fn.carAtom(S.x); space.fn["p.map-value"](2); m.fn("isPrime")(7); m.fn["NARS.Config.MaxSteps"]();\n',
  );
  assert.deepEqual(scan(cleanTs, cleanJs), []);
  const [dirtyTs, dirtyJs] = write(
    "asking-dirty",
    'import { fn } from "tsmetta";\nm.fn("p.map-value")(2); m.fn["car-atom"](1); space.fn("parent"); fn["*"](1, 2); m.self.fn["mul"](1, 2);\n',
  );
  assert.deepEqual(scan(dirtyTs, dirtyJs).toSorted(), [
    'line 2: fn["*"] is fn.mul',
    'line 2: m.fn("p.map-value") is the bracket door m.fn["p.map-value"]; the call door is for a name the map would change',
    'line 2: m.fn["car-atom"] is m.fn.carAtom',
    'line 2: m.self.fn["mul"] is m.self.fn.mul',
    'line 2: space.fn("parent") is space.fn.parent',
  ]);
});

const ran = (report: Partial<Report>): Report => ({
  ok: true,
  claims: 0,
  ...report,
});

test("agree: a twin must cover the original's claims, heads and atoms", () => {
  const original = ran({
    claims: 2,
    heads: ["f/1"],
    spaces: { "&self": ["(= (f $_alpha0) 1)"] },
    inferences: 50,
  });
  const twin = ran({
    claims: 2,
    exported: true,
    heads: ["f/1"],
    spaces: { "&self": ["(= (f $_alpha0) 1)"] },
    inferences: 10,
  });
  assert.deepEqual(agree(original, twin, { declined: 0, idle: 0 }), []);
  assert.equal(agree(original, { ...twin, claims: 1 }, { declined: 0, idle: 0 }).length, 1);
  assert.deepEqual(agree(original, { ...twin, claims: 1 }, { declined: 1, idle: 0 }), []);
  assert.equal(agree(original, { ...twin, heads: [] }, { declined: 0, idle: 0 }).length, 1);
  assert.equal(
    agree(original, twin, { declined: 0, idle: 10 }).length,
    1,
    "no more than an idle engine spent",
  );
  assert.equal(agree(original, { ...twin, exported: false }, { declined: 0, idle: 0 }).length, 1);
  assert.equal(agree(ran({ ok: false, error: "boom" }), twin, { declined: 0, idle: 0 }).length, 1);
});

test("agree: a refused form that now runs is stale", () => {
  const twin = ran({ claims: 1, exported: true, heads: [], spaces: {}, inferences: 10 });
  const original = ran({ claims: 1, heads: [], spaces: {}, inferences: 50 });
  assert.deepEqual(agree({ ...original, runsNow: [] }, twin, { declined: 0, idle: 0 }), []);
  assert.deepEqual(agree({ ...original, runsNow: [4, 9] }, twin, { declined: 0, idle: 0 }), [
    "residue.json refuses form 4, 9, which now runs without error; delete it from its entry",
  ]);
});

test("agree: stored atoms differ only as declared, in both directions", () => {
  const original = ran({
    claims: 0,
    spaces: { "&self": ["(a)", "(a)", "(b)"] },
  });
  const twin = ran({
    claims: 0,
    exported: true,
    spaces: { "&self": ["(a)", "(c)"] },
    inferences: 1,
  });
  assert.deepEqual(surplus(["(a)", "(a)", "(b)"], ["(a)", "(c)"]), ["(a)", "(b)"]);
  assert.deepEqual(storedDifference(original, twin), {
    originalOnly: { "&self": ["(a)", "(b)"] },
    twinOnly: { "&self": ["(c)"] },
    volatile: {},
  });
  assert.equal(agree(original, twin, { declined: 0, idle: 0 }).length, 1);
  const divergence = {
    originalOnly: { "&self": ["(b)", "(a)"] },
    twinOnly: { "&self": ["(c)"] },
    reason: "planted",
  };
  assert.deepEqual(agree(original, twin, { declined: 0, idle: 0, divergence }), []);
  assert.equal(
    agree(
      original,
      { ...twin, spaces: original.spaces ?? {} },
      { declined: 0, idle: 0, divergence },
    ).length,
    1,
    "a declared difference the runs no longer show is stale",
  );
});

/** One form as the engine's reader answers it. */
const form = (kind: string, text: string, atom: Atom): Form => ({ kind, text, atom });

test("keeps an original's forms, less exactly the ! forms this build refuses", () => {
  const forms = [
    form(
      "runnable",
      "(import! &self (library lib_x))",
      S["import!"](S["&self"], S.library(S.lib_x)),
    ),
    form("function", "(= (f) 1)", S["="](S.f(), 1)),
    form("runnable", "(test (f) 1)", S.test(S.f(), 1)),
    form("expression", "(: f Number)", S[":"](S.f, S.Number)),
    form("runnable", "(test (g) 2)", S.test(S.g(), 2)),
  ];
  assert.deepEqual(keptProgram(forms, new Set()), {
    text: "!(import! &self (library lib_x))\n(= (f) 1)\n!(test (f) 1)\n(: f Number)\n!(test (g) 2)",
    claims: 2,
    dropped: [],
  });
  assert.deepEqual(keptProgram(forms, new Set([3])), {
    text: "!(import! &self (library lib_x))\n(= (f) 1)\n!(test (f) 1)\n(: f Number)",
    claims: 1,
    dropped: [
      {
        at: 3,
        text: "!(test (g) 2)",
        before: "!(import! &self (library lib_x))\n(= (f) 1)\n!(test (f) 1)\n(: f Number)",
        after: "",
      },
    ],
  });
  // A refused form carries the kept program on each side of it, which is
  // where the lane restores it to ask whether it still fails.
  assert.deepEqual(keptProgram(forms, new Set([2])).dropped, [
    {
      at: 2,
      text: "!(test (f) 1)",
      before: "!(import! &self (library lib_x))\n(= (f) 1)",
      after: "(: f Number)\n!(test (g) 2)",
    },
  ]);
  // Refusing the first form leaves nothing before it and the whole kept
  // program after it.
  assert.deepEqual(keptProgram(forms, new Set([1, 3])).dropped, [
    {
      at: 1,
      text: "!(import! &self (library lib_x))",
      before: "",
      after: "(= (f) 1)\n!(test (f) 1)\n(: f Number)",
    },
    {
      at: 3,
      text: "!(test (g) 2)",
      before: "(= (f) 1)\n!(test (f) 1)\n(: f Number)",
      after: "",
    },
  ]);
  assert.throws(
    () => keptProgram(forms, new Set([4])),
    /refuses form 4, and the original has 3 ! forms/,
  );
});

test("walks an original refused whole", async () => {
  const forms = [
    form(
      "runnable",
      "(import! &self (library lib_x))",
      S["import!"](S["&self"], S.library(S.lib_x)),
    ),
    form("runnable", "(bind! &p (start))", S["bind!"](S["&p"], S.start())),
    form("function", "(= (f) 1)", S["="](S.f(), 1)),
    form("runnable", "(test (wait &p) 0)", S.test(S.wait(S["&p"]), 0)),
    form("runnable", "(test (f) 1)", S.test(S.f(), 1)),
  ];
  // This build cannot start a process, so the bind fails, and so does every
  // form naming what it would have bound.
  const tried: [number, string][] = [];
  const walk = await walkForms(forms, (at, before, text) => {
    tried.push([at, before]);
    return Promise.resolve(!text.includes("(start)") && !text.includes("&p"));
  });
  assert.deepEqual(walk, { claims: [4], fails: [2, 3] });
  // Each form is tried after the forms kept before it: the definition stays,
  // and a form that failed is left out of what follows it.
  const kept = "!(import! &self (library lib_x))\n(= (f) 1)";
  assert.deepEqual(tried, [
    [1, ""],
    [2, "!(import! &self (library lib_x))"],
    [3, kept],
    [4, kept],
  ]);
  // When every form runs, nothing fails and every claim is reported.
  assert.deepEqual(await walkForms(forms, () => Promise.resolve(true)), {
    claims: [3, 4],
    fails: [],
  });
  // When the first form fails, so does every form after it here, and no claim runs.
  assert.deepEqual(
    await walkForms(forms, (_at, before) => Promise.resolve(before.includes("import!"))),
    { claims: [], fails: [1, 2, 3, 4] },
  );
});

test("refuses a residue table that says one thing twice or nothing at all", () => {
  const example = "examples/ch08-data/08-03-the-shipped-libraries/14-reflect_lib.metta";
  const entry = (kind: Residue["kind"], forms?: readonly number[]): Residue => ({
    kind,
    example,
    ...(forms === undefined ? {} : { forms }),
    missing: "m",
    waits: "w",
    detail: "d",
  });
  const fine = [entry("refused", [25, 26]), entry("declined", [3]), entry("friction", [4])];
  assert.deepEqual(checkedResidue(fine), fine);
  assert.deepEqual(checkedResidue([entry("declined")]), [entry("declined")]);
  assert.deepEqual(checkedResidue([entry("refused")]), [entry("refused")]);
  assert.throws(
    () => checkedResidue([entry("refused"), entry("declined")]),
    /a refused entry and a declined entry for the whole of/,
  );
  assert.throws(() => checkedResidue([entry("refused", [])]), /names at least one/);
  assert.throws(() => checkedResidue([entry("declined", [0])]), /counted from 1/);
  assert.throws(() => checkedResidue([entry("declined", [1.5])]), /counted from 1/);
  assert.throws(
    () => checkedResidue([entry("refused", [2, 5]), entry("declined", [5])]),
    /form 5 of .* in a refused entry and again in a declined entry/,
  );
  assert.throws(
    () => checkedResidue([entry("refused", [7, 7])]),
    /form 7 of .* in a refused entry and again in a refused entry/,
  );
  assert.throws(
    () => checkedResidue([entry("declined"), entry("friction", [1])]),
    /covers .* whole in a declined entry and also has a friction entry/,
  );
});

/** A side's report of one space holding these atoms, texts and structure both. */
const holding = (atoms: readonly Atom[], report: Partial<Report> = {}): Report =>
  ran({
    claims: 0,
    exported: true,
    inferences: 1,
    spaces: { "&metadata": atoms.map(String).toSorted() },
    wires: {
      "&metadata": Object.fromEntries(
        atoms.map((atom) => [String(atom), transportToJson(toTransport(wireFromAtom(atom)))]),
      ),
    },
    ...report,
  });

test("agree: a head the original defines only in a declared difference is not hidden", () => {
  // The original's selected keeps a continuation helper the twin's generator
  // has no need of; both answer alike.
  const helper = S["="](S["selected--after-yield-1"](), S.Done);
  const shared = S["="](S.selected(1), S.Done);
  const original = holding([shared, helper], {
    heads: ["selected/1", "selected--after-yield-1/0"],
  });
  const twin = holding([shared], { heads: ["selected/1"] });
  const options = { declined: 0, idle: 0 };
  assert.deepEqual(
    agree(original, twin, options).filter((finding) => finding.includes("does not define")),
    [
      "the twin's &self does not define selected--after-yield-1/0, which the original makes matchable",
    ],
  );
  const divergence = {
    originalOnly: { "&metadata": [String(helper)] },
    twinOnly: {},
    reason: "planted",
  };
  assert.deepEqual(agree(original, twin, { ...options, divergence }), []);
  // A declaration naming some other atom leaves the head hidden.
  const elsewhere = { ...divergence, originalOnly: { "&metadata": [String(S.other(1))] } };
  assert.ok(
    agree(original, twin, { ...options, divergence: elsewhere }).some((finding) =>
      finding.includes("does not define selected--after-yield-1/0"),
    ),
  );
});

test("generalizes two atoms to what they share, one variable per differing pair", () => {
  assert.equal(generalize(S.modified(1), S.modified(1)), S.modified(1));
  assert.equal(String(generalize(S.modified(1), S.modified(2))), "(modified $volatile0)");
  assert.equal(String(generalize(S.at(1, 1), S.at(2, 2))), "(at $volatile0 $volatile0)");
  assert.equal(String(generalize(S.at(1, 2), S.at(2, 1))), "(at $volatile0 $volatile1)");
  assert.equal(String(generalize(S.f(S.a), S.g(S.a, S.b))), "$volatile0");
});

/** A difference's volatile shapes as the lane prints them, per space. */
const printed = (difference: Difference) =>
  Object.fromEntries(
    Object.entries(difference.volatile).map(([name, shapes]) => [
      name,
      shapes.map(({ pattern }) => pattern),
    ]),
  );

test("agree: an atom the original changes from run to run is owed only in shape", () => {
  const original = holding([S.size(5), S.modified(1.25)]);
  const again = holding([S.size(5), S.modified(2.5)]);
  const twin = holding([S.size(5), S.modified(3.75)]);
  const options = { declined: 0, idle: 0 };
  assert.equal(agree(original, twin, options).length, 1, "without a second run it is a difference");
  assert.deepEqual(agree(original, twin, { ...options, again }), []);
  assert.deepEqual(printed(storedDifference(original, twin, again)), {
    "&metadata": ["(modified $volatile0)"],
  });
  // A twin atom of another shape does not fill the slot, and a stable atom
  // the twin lacks is still owed exactly.
  const bogus = storedDifference(original, holding([S.size(5), S.bogus(3)]), again);
  assert.deepEqual(
    [bogus.originalOnly, bogus.twinOnly, printed(bogus)],
    [
      { "&metadata": ["(modified 1.25)"] },
      { "&metadata": ["(bogus 3)"] },
      { "&metadata": ["(modified $volatile0)"] },
    ],
  );
  assert.deepEqual(storedDifference(original, holding([S.modified(3.75)]), again).originalOnly, {
    "&metadata": ["(size 5)"],
  });
  // Two original runs that agree mean the difference is the twin's.
  assert.equal(agree(original, twin, { ...options, again: original }).length, 1);
  assert.equal(
    agree(original, twin, { ...options, again: ran({ ok: false, error: "boom" }) }).filter(
      (finding) => finding.includes("second time"),
    ).length,
    1,
  );
});

test("agree: a declared volatile shape is owed only in shape in every run", () => {
  const original = holding([S.size(5), S.modified(1.25)]);
  const again = holding([S.size(5), S.modified(2.5)]);
  const twin = holding([S.size(5), S.modified(3.75)]);
  const options = { declined: 0, idle: 0 };
  const { volatile } = storedDifference(original, twin, again);
  const divergence = {
    originalOnly: {},
    twinOnly: {},
    volatile,
    reason: "a clock reading",
  };
  // Once declared, the shape holds even where the two original runs stored the
  // same reading and so could not tell it apart, and where there was no second run.
  assert.deepEqual(agree(original, twin, { ...options, again: original, divergence }), []);
  assert.deepEqual(agree(original, twin, { ...options, divergence }), []);
  // A twin atom of another shape is still a difference.
  assert.equal(
    agree(original, holding([S.size(5), S.bogus(3)]), { ...options, divergence }).length,
    1,
  );
  // A declared shape the original no longer stores is stale.
  assert.deepEqual(agree(holding([S.size(5)]), holding([S.size(5)]), { ...options, divergence }), [
    "DIVERGENCE declares volatile shapes the original no longer stores: &metadata (modified $volatile0)",
  ]);
  // A shape whose printed text and wire disagree is refused.
  const [shape] = volatile["&metadata"] ?? [];
  assert.ok(shape !== undefined);
  assert.throws(
    () =>
      storedDifference(original, twin, undefined, {
        "&metadata": [{ ...shape, pattern: "(modified 0)" }],
      }),
    /DIVERGENCE declares the volatile shape \(modified 0\), and its wire reads \(modified \$volatile0\)/,
  );
  // Declaring keeps each printed shape once, and a shape a later run did not
  // tell apart stays declared.
  assert.deepEqual(mergeVolatile({ "&metadata": [shape] }, volatile), volatile);
  assert.deepEqual(mergeVolatile({ "&metadata": [shape] }, {}), volatile);
});

/** A residue entry covering one planted example whole. */
function coveredWhole(example: string): Residue {
  return { kind: "refused", example, missing: "planted", waits: "planted", detail: "planted" };
}

test("classifies a program by its path", () => {
  assert.equal(
    twinOf("examples/ch05-a/05-01-b/01-identity.metta"),
    "ch05-a/05-01-b/01-identity.ts",
  );
  assert.equal(
    originalOf("ch05-a/05-01-b/01-identity.ts"),
    "examples/ch05-a/05-01-b/01-identity.metta",
  );
  assert.equal(isTwin("ch05-a/05-01-b/01-identity.ts"), true);
  assert.equal(
    isTwin("ch05-a/05-01-b/routing_equations.ts"),
    false,
    "a hand-written name has no number",
  );
  assert.equal(isTwin(`${SEAT}/21-01-a/01-seat.ts`), false, "the seat's chapter has no originals");
});

test("coverage: every original is twinned or covered whole, and a twin mirrors an original", () => {
  const twinned = "examples/ch01-a/01-one.metta";
  const covered = "examples/ch01-a/02-two.metta";
  const missing = "examples/ch01-a/03-three.metta";
  const both = "examples/ch01-a/04-four.metta";
  const wholly = new Map([
    [covered, coveredWhole(covered)],
    [both, coveredWhole(both)],
  ]);
  const twins = ["ch01-a/01-one.ts", "ch01-a/04-four.ts", "ch01-a/05-stray.ts"];
  assert.deepEqual(coverage([twinned, covered, missing, both], twins, wholly), [
    `${missing}: no twin at ch01-a/03-three.ts and no residue entry covering the whole example`,
    `${both}: residue.json's refused entry covers the whole example, and ch01-a/04-four.ts exists`,
    "ch01-a/05-stray.ts: twins no original under examples/",
  ]);
});

/** A declaration as a twin exports it. */
const clock: Divergence = {
  originalOnly: { "&self": ["(= (f) 1)"] },
  twinOnly: {},
  volatile: {
    "&metta-space-1": [
      { pattern: "(modified $volatile0)", wire: '["e",[["s","modified"],["v","volatile0"]]]' },
    ],
  },
  reason: "a clock reading",
};

test("reads a twin's DIVERGENCE as exactly the fields a declaration has", () => {
  assert.deepEqual(checkedDivergence(clock, "ch01-a/01-one.ts"), clock);
  const refused: [unknown, RegExp][] = [
    [[], /is not an object/],
    [{ ...clock, example: "examples/x.metta" }, /has fields no declaration has: example/],
    [{ ...clock, originalOnly: { "&self": [1] } }, /has no originalOnly/],
    [{ ...clock, twinOnly: undefined }, /has no twinOnly/],
    [{ ...clock, volatile: { "&metta-space-1": [{ pattern: "p" }] } }, /has a volatile/],
    [{ ...clock, reason: " " }, /states no reason/],
  ];
  for (const [value, why] of refused) {
    assert.throws(() => checkedDivergence(value, "ch01-a/01-one.ts"), why);
  }
});

test("declares a divergence in the twin's own source", async () => {
  const plain = 'import { metta } from "tsmetta";\n\nexport const m = await metta();\n';
  const declaring = await declared("ch01-a/01-one.ts", plain, clock);
  assert.ok(declaring.startsWith(plain + "\nexport const DIVERGENCE = {\n"));
  assert.equal(await declared("ch01-a/01-one.ts", declaring, clock), declaring);
  assert.equal(await declared("ch01-a/01-one.ts", declaring, undefined), plain);
  assert.equal(await declared("ch01-a/01-one.ts", plain, undefined), plain);
  const buried = declaring + "\nconsole.log(m);\n";
  await assert.rejects(
    declared("ch01-a/01-one.ts", buried, clock),
    /declares DIVERGENCE somewhere other than its last statement/,
  );
});

test("holds a program to tsmetta, node:* and its own fixtures", () => {
  const guard =
    '.catch((error) => { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; console.log("SKIP: zod is not installed; npm install zod"); process.exit(0); });\n';
  const [cleanTs, cleanJs] = write(
    "imports-clean",
    'import assert from "node:assert/strict";\nimport { metta } from "tsmetta";\nimport { lint } from "tsmetta/lint";\nimport page from "./_fixtures/page.js";\n' +
      `const { z } = await import("zod")${guard}` +
      `const [{ Client }] = await Promise.all([import("@modelcontextprotocol/sdk/client/index.js")])${guard}`,
  );
  assert.deepEqual(scan(cleanTs, cleanJs), []);
  const [dirtyTs, dirtyJs] = write(
    "imports-dirty",
    'import express from "express";\nexport * from "../shared.js";\nconst { z } = await import("zod");\nconst name = "rxjs";\nawait import(name);\n',
  );
  assert.deepEqual(scan(dirtyTs, dirtyJs).toSorted(), [
    "line 1: imports express; a program imports only tsmetta, node:* and its own _fixtures/, and loads any other package through a guarded import(...)",
    "line 2: imports ../shared.js; a program imports only tsmetta, node:* and its own _fixtures/, and loads any other package through a guarded import(...)",
    'line 3: import("zod") is not guarded; load it inside a .catch that names what to install and exits',
    "line 5: import(...) of a computed specifier, which no reader can know to install",
  ]);
  // A whole `import type` declaration leaves nothing in the compiled program,
  // so the scan reads it from the source.
  mkdirSync("ai-tmp/scan-test", { recursive: true });
  writeFileSync(
    "ai-tmp/scan-test/imports-typed.ts",
    'import type {\n  Tensor,\n} from "@tensorflow/tfjs";\nexport const x = 1;\n',
  );
  writeFileSync("ai-tmp/scan-test/imports-typed.js", "export const x = 1;\n");
  assert.deepEqual(scan("ai-tmp/scan-test/imports-typed.ts", "ai-tmp/scan-test/imports-typed.js"), [
    "line 1 of the source: imports types from @tensorflow/tfjs; a program names only tsmetta, node:* and its own _fixtures/",
  ]);
});

/** Run git in a planted repository, as a commit needs no identity from the host. */
function git(tree: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-C", tree, "-c", "user.name=lane", "-c", "user.email=lane@example.invalid", ...args],
    { encoding: "utf8" },
  );
}

/** Every file under a directory, relative to it, sorted; links and directories left out. */
function filesUnder(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[])
    .filter((path) => lstatSync(`${directory}/${path}`).isFile())
    .toSorted();
}

test("presents the corpus with examples/ the given MeTTa corpus, less what its repository ignores", () => {
  const base = "ai-tmp/root-test";
  rmSync(base, { recursive: true, force: true });
  // A MeTTa corpus: a tracked original, a script, an object its own
  // .gitignore names as built, an original not yet added, and a tracked file
  // deleted from the working tree.
  const metta = `${base}/metta`;
  mkdirSync(`${metta}/ch19/c`, { recursive: true });
  git(metta, "init", "-q");
  writeFileSync(`${metta}/README.md`, "the corpus\n");
  writeFileSync(`${metta}/ch19/.gitignore`, "*/*.so\n");
  writeFileSync(`${metta}/ch19/c/01-c.metta`, "!(test 1 1)\n");
  writeFileSync(`${metta}/ch19/build.sh`, "#!/bin/sh\n");
  chmodSync(`${metta}/ch19/build.sh`, 0o755);
  writeFileSync(`${metta}/ch19/c/gone.metta`, "!(test 0 0)\n");
  git(metta, "add", ".");
  git(metta, "commit", "-qm", "corpus");
  rmSync(`${metta}/ch19/c/gone.metta`);
  writeFileSync(`${metta}/ch19/c/cstore.so`, "built for a native host\n");
  writeFileSync(`${metta}/ch19/c/02-new.metta`, "!(test 2 2)\n");
  // A corpus root: a chapter with a fixture, git's metadata, and the older
  // MeTTa corpus it pins at examples/.
  const corpus = `${base}/corpus`;
  mkdirSync(`${corpus}/ch19/_fixtures`, { recursive: true });
  mkdirSync(`${corpus}/examples`, { recursive: true });
  writeFileSync(`${corpus}/examples/README.md`, "the pinned copy\n");
  writeFileSync(`${corpus}/.git`, "gitdir: elsewhere\n");
  writeFileSync(`${corpus}/residue.json`, "{}\n");

  const root = `${base}/root`;
  const digest = presentRoot(corpus, metta, root);
  assert.deepEqual(readdirSync(root).toSorted(), ["ch19", "examples", "residue.json"]);
  assert.ok(lstatSync(`${root}/ch19`).isSymbolicLink());
  assert.equal(realpathSync(`${root}/ch19`), realpathSync(`${corpus}/ch19`));
  writeFileSync(`${root}/ch19/_fixtures/written`, "through the root\n");
  assert.equal(readFileSync(`${corpus}/ch19/_fixtures/written`, "utf8"), "through the root\n");
  assert.ok(lstatSync(`${root}/examples`).isDirectory());
  assert.deepEqual(filesUnder(`${root}/examples`), [
    "README.md",
    "ch19/.gitignore",
    "ch19/build.sh",
    "ch19/c/01-c.metta",
    "ch19/c/02-new.metta",
  ]);
  assert.equal(readFileSync(`${root}/examples/README.md`, "utf8"), "the corpus\n");
  assert.equal(statSync(`${root}/examples/ch19/build.sh`).mode & 0o777, 0o755);
  assert.match(digest, /^sha256-/);

  // The digest follows the corpus's content and nothing else.
  assert.equal(presentRoot(corpus, metta, `${base}/again`), digest);
  writeFileSync(`${metta}/ch19/c/01-c.metta`, "!(test 1 2)\n");
  assert.notEqual(presentRoot(corpus, metta, `${base}/edited`), digest);
  assert.throws(() => presentRoot(corpus, metta, root), /already holds something/);

  // A link or a submodule is refused, naming it, rather than copied partly.
  symlinkSync("README.md", `${metta}/linked.md`);
  assert.throws(
    () => presentRoot(corpus, metta, `${base}/linked`),
    /linked\.md is a symbolic link/,
  );
  rmSync(`${metta}/linked.md`);
  const commit = git(metta, "rev-parse", "HEAD").trim();
  git(metta, "update-index", "--add", "--cacheinfo", `160000,${commit},nested`);
  assert.throws(() => presentRoot(corpus, metta, `${base}/nested`), /nested is a submodule/);
});
