/**
 * Purpose: MeTTa.registerProlog and MeTTa.unregisterProlog, the native-speed
 *   extension point: Prolog predicates registered as MeTTa functions through
 *   the engine's registration service, the one the Python seat's
 *   register_prolog calls, so these cases are that seat's own read through
 *   this one.
 * Guarantees:
 *   - inline source and a host file both become MeTTa functions, and a
 *     predicate's solutions are its answers [tested 2026-09-25T18:46:53+10:00: "turns inline
 *     source into a MeTTa function", "turns a host file into MeTTa
 *     functions", "answers every solution of a predicate"]
 *   - a builtin, a special form and a name another tier or source owns are
 *     refused before the source loads, a name no loaded predicate answers
 *     after it, and a list with one bad name registers none [tested 2026-09-25T18:46:53+10:00:
 *     "refuses a name with no predicate behind it", "refuses a builtin's
 *     name, and the builtin still works", "refuses a special form's name",
 *     "registers every name or none", "refuses a name another tier owns, in
 *     both directions", "refuses a rival source before it can replace the
 *     incumbent"]
 *   - a source declares its own exports or an extension, and an extension
 *     releases whole [tested 2026-09-25T18:46:53+10:00: "registers the names a file declares,
 *     types included", "releases an extension whole"]
 *   - a registration missing what its contract needs raises
 *     RegistrationError, whose `requires` says what to supply: the engine's,
 *     whose ground and remedy are the registration row's, for a source that
 *     names nothing and declares nothing, none of which loads, and for a
 *     rename from text; this seat's own for a call naming neither or both of
 *     `{ source }` and `{ path }` [tested 2026-09-25T18:46:53+10:00: "refuses a source that names
 *     nothing and declares nothing, naming all three routes", "refuses a
 *     source that names nothing and declares nothing, and loads none of it",
 *     "renames only a module, named by its file", "takes exactly one of
 *     source or path"]
 *   - a syntax error in a source raises, naming its line, and so does a
 *     determinism the engine does not know, as the Python seat raises them,
 *     although the load runs in an engine of its own [tested 2026-09-25T18:46:53+10:00: "names
 *     the line of a syntax error", "refuses a determinism it does not know"]
 *   - a function declared det raises where it leaves a choice point, and one
 *     declared nondet keeps every answer [tested 2026-09-25T18:46:53+10:00: "raises where a
 *     declared det function leaves a choice point", "keeps every answer of a
 *     declared nondet function"]
 *   - a mapping renames a module's exports, so two modules exporting one name
 *     both register [tested 2026-09-25T18:46:53+10:00: "registers two modules' one export under
 *     two names"]
 *   - a Prolog registration costs fewer inferences per call than the same
 *     operation registered as a TypeScript op [tested 2026-09-25T18:46:53+10:00: "costs fewer
 *     inferences per call than a TypeScript op"]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  type Atom,
  G,
  type MeTTa,
  MettaError,
  NameError,
  RegistrationError,
  S,
  SourceNotFoundError,
  TRUE,
  e,
  fn,
  metta,
} from "../src/index.ts";

let m: MeTTa;
let directory: string;

before(async () => {
  m = await metta();
  directory = mkdtempSync(join(tmpdir(), "tsmetta-register-"));
});

after(() => {
  m.dispose();
  rmSync(directory, { recursive: true, force: true });
});

/** A Prolog file written into this suite's directory, by its path. */
function prologFile(name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

/** A refusal whose message says what the pattern says. */
function refusal(pattern: RegExp): (error: unknown) => boolean {
  return (error) => MettaError.is(error) && pattern.test(error.message);
}

/**
 * The engine's registration refusal: `requires` says what the pattern says,
 * the remedy asks for exactly that, and the ground cites the registration
 * contract, as the Python seat's register_prolog refusals do.
 */
function registration(requires: RegExp): (error: unknown) => boolean {
  return (error) =>
    error instanceof RegistrationError &&
    requires.test(error.requires ?? "") &&
    error.remedy?.title === `give the registration ${error.requires}` &&
    error.ground?.citation.startsWith("HostLaws: engine/metta/interop.pl metta_register_prolog/3") === true;
}

describe("registerProlog", () => {
  it("turns inline source into a MeTTa function", async () => {
    const names = m.registerProlog({ source: "'rp-square'(X, Y) :- Y is X * X." }, ["rp-square"]);
    assert.deepEqual(names, ["rp-square"]);
    assert.deepEqual(await m.fn("rp-square")(7), [G(49)]);
  });

  it("turns a host file into MeTTa functions", async () => {
    const path = prologFile("rp_lib.pl", "'rp-triple'(X, Y) :- Y is X * 3.\n'rp-negate'(X, Y) :- Y is -X.\n");
    assert.deepEqual(m.registerProlog({ path }, ["rp-triple", S["rp-negate"]]), ["rp-triple", "rp-negate"]);
    assert.deepEqual(await m.fn("rp-triple")(14), [G(42)]);
    assert.deepEqual(await m.fn("rp-negate")(5), [G(-5)]);
  });

  it("answers every solution of a predicate", async () => {
    m.registerProlog({ source: "'rp-each'(_, X) :- member(X, [a, b, c])." }, ["rp-each"]);
    assert.deepEqual(await m.fn("rp-each")(0), [S.a.atom, S.b.atom, S.c.atom]);
  });

  it("refuses a name with no predicate behind it", () => {
    // Registered, the name would compile every call into a partial
    // application rather than fail, a silent wrong answer.
    assert.throws(
      () => m.registerProlog({ source: "'rp-present'(X, X)." }, ["rp-absent"]),
      refusal(/no predicate named/),
    );
  });

  it("refuses a source that names nothing and declares nothing, naming all three routes", () => {
    assert.throws(
      () => m.registerProlog({ source: "'rp-unnamed'(X, X)." }),
      registration(/the names to register[\s\S]*metta_export[\s\S]*metta_extension/),
    );
  });

  it("takes exactly one of source or path", () => {
    const path = prologFile("rp_either.pl", "'rp-either'(X, X).\n");
    for (const from of [{ source: "'rp-either'(X, X).", path }, {}]) {
      assert.throws(
        () => m.registerProlog(from as never, ["rp-either"]),
        (error) =>
          error instanceof RegistrationError && error.requires === "exactly one of { source } or { path }",
      );
    }
  });

  it("names a missing file as a missing source", () => {
    assert.throws(
      () => m.registerProlog({ path: join(directory, "none.pl") }, ["rp-x"]),
      (error) => error instanceof SourceNotFoundError,
    );
  });

  it("refuses a name that is neither a string nor a symbol", () => {
    assert.throws(
      () => m.registerProlog({ source: "'rp-ok'(X, X)." }, [42 as never]),
      (error) => error instanceof NameError && /a name as a string or a symbol/.test(error.message),
    );
  });

  it("refuses a builtin's name, and the builtin still works", async () => {
    // A consulted predicate replaces the engine's static one for the whole
    // process, so the refusal has to land before the source loads.
    assert.throws(
      () => m.registerProlog({ source: "'+'(_, _, R) :- R = shadowed." }, ["+"]),
      refusal(/is a builtin/),
    );
    assert.deepEqual(await m.fn.add(1, 2), [G(3)]);
    assert.throws(
      () => m.registerProlog({ source: "'car-atom'(_, R) :- R = shadowed." }, ["car-atom"]),
      refusal(/is a builtin/),
    );
    assert.deepEqual(await m.fn.carAtom(e(1, 2)), [G(1)]);
  });

  it("refuses a special form's name", async () => {
    assert.throws(
      () => m.registerProlog({ source: "'if'(_, _, _, R) :- R = shadowed." }, ["if"]),
      refusal(/is a special form/),
    );
    assert.deepEqual(await m.fn("if")(TRUE, 1, 2), [G(1)]);
  });

  it("keeps generated sources apart, each under a name hashed from its text", async () => {
    for (let at = 0; at < 4; at += 1) {
      m.registerProlog({ source: `'rp-gen${at}'(X, Y) :- Y is X + ${at}.\n` }, [`rp-gen${at}`]);
    }
    const answers = await Promise.all([0, 1, 2, 3].map(async (at) => m.fn(`rp-gen${at}`)(10)));
    assert.deepEqual(answers, [[G(10)], [G(11)], [G(12)], [G(13)]]);
  });

  it("reloads the same source rather than stacking its clauses", async () => {
    const source = "'rp-twice'(X, Y) :- Y is X + 1.\n";
    m.registerProlog({ source }, ["rp-twice"]);
    m.registerProlog({ source }, ["rp-twice"]);
    assert.deepEqual(await m.fn("rp-twice")(1), [G(2)]);
  });

  it("registers every name or none", () => {
    assert.throws(
      () => m.registerProlog({ source: "'rp-t1'(X, X).\n'rp-t2'(X, X).\n" }, ["rp-t1", "rp-t2", "rp-typo"]),
      refusal(/no predicate named/),
    );
    assert.equal(m.reducible(S["rp-t1"](1)), false);
    assert.equal(m.reducible(S["rp-t2"](1)), false);
  });

  it("refuses a name another tier owns, in both directions", async () => {
    m.op(
      function rpOwned(x: number): Atom {
        return e(S.typescript, x);
      },
      { effect: "pureStructural" },
    );
    assert.throws(
      () => m.registerProlog({ source: "'rp-owned'(X, R) :- R = [prolog, X]." }, ["rp-owned"]),
      refusal(/another extension tier/),
    );
    assert.deepEqual(await m.fn.rpOwned(1), [e(S.typescript, 1)]);

    m.registerProlog({ source: "'rp-mine'(X, R) :- R = [prolog, X]." }, ["rp-mine"]);
    assert.throws(
      () =>
        m.op(
          function rpMine(x: number): Atom {
            return e(S.typescript, x);
          },
          { effect: "pureStructural" },
        ),
      refusal(/another extension tier/),
    );
    assert.deepEqual(await m.fn.rpMine(1), [e(S.prolog, 1)]);
  });

  it("refuses a rival source before it can replace the incumbent", async () => {
    const first = prologFile("rp_norm_a.pl", "'rp-rival-norm'(_, 20).\n");
    const second = prologFile("rp_norm_b.pl", "'rp-rival-norm'(_, 30).\n");
    m.registerProlog({ path: first }, ["rp-rival-norm"]);
    assert.throws(() => m.registerProlog({ path: second }, ["rp-rival-norm"]), refusal(/already registered from/));
    // The incumbent is intact: the rival never loaded.
    assert.deepEqual(await m.fn("rp-rival-norm")(1), [G(20)]);

    // The same for a library declaring its own exports, which the engine
    // reads out of the source without running it.
    const declaration = ':- metta_export("(: rp-declared-norm (-> Number Number))").\n';
    const declaredFirst = prologFile("rp_dnorm_a.pl", `${declaration}'rp-declared-norm'(_, 20).\n`);
    const declaredSecond = prologFile("rp_dnorm_b.pl", `${declaration}'rp-declared-norm'(_, 30).\n`);
    assert.deepEqual(m.registerProlog({ path: declaredFirst }), ["rp-declared-norm"]);
    assert.throws(() => m.registerProlog({ path: declaredSecond }), refusal(/already registered from/));
    assert.deepEqual(await m.fn("rp-declared-norm")(1), [G(20)]);
  });

  it("names the line of a syntax error", () => {
    assert.throws(
      () => m.registerProlog({ source: "'rp-syntax'(X, Y) :- Y is X * ." }, ["rp-syntax"]),
      refusal(/:1:\d+: Syntax error/),
    );
  });

  it("costs fewer inferences per call than a TypeScript op", async () => {
    m.registerProlog({ source: "'rp-fast'(X, Y) :- Y is X + 1." }, ["rp-fast"]);
    m.op(
      function rpSlow(x: number): number {
        return x + 1;
      },
      { effect: "pureStructural" },
    );
    m.run(`
      (= (rp-drive $which $n)
         (if (> $n 0)
             (let $_ (case $which ((fast (rp-fast 1)) (slow (rp-slow 1))))
               (rp-drive $which (- $n 1)))
             done))
    `);
    const calls = 500;
    const perCall: Record<string, number> = {};
    for (const which of ["fast", "slow"]) {
      await m.fn("rp-drive")(S[which], 10);
      using counted = m.stats();
      await m.fn("rp-drive")(S[which], calls);
      perCall[which] = counted.inferences / calls;
    }
    assert.deepEqual(await m.fn("rp-fast")(41), await m.fn.rpSlow(41));
    // The direction and a wide margin rather than the ratio, which is
    // specific to one engine version.
    assert.ok((perCall["slow"] ?? 0) > (perCall["fast"] ?? 0) * 1.5, JSON.stringify(perCall));
  });
});

describe("a source that declares its own names", () => {
  const library = `
:- metta_extension(rp_demo, [version('0.1.0')]).
:- metta_export("
    (: rp-demo-scale (-> Number Number))
    (: rp-demo-shape (-> Atom Atom))
    (export rp-demo-plain 1)
").

'rp-demo-scale'(X, Y) :- Y is X * 10.
'rp-demo-shape'(X, [shape, X]).
'rp-demo-plain'(X, X).
'rp-demo-helper'(_, _, hidden).
`;
  let declared: string;

  before(() => {
    declared = prologFile("rp_demo.pl", library);
  });

  it("registers the names a file declares, types included", async () => {
    try {
      assert.deepEqual(m.registerProlog({ path: declared }).toSorted(), [
        "rp-demo-plain",
        "rp-demo-scale",
        "rp-demo-shape",
      ]);
      assert.deepEqual(await m.fn("rp-demo-scale")(3), [G(30)]);
      // The Atom type travelled with the name, so the argument arrives as
      // written from the first call site ever compiled.
      assert.deepEqual(await m.fn("rp-demo-shape")(fn.add(1, 2)), [e(S.shape, e(S["+"], 1, 2))]);
      // The helper shares the prefix and was not declared, so it is not one.
      assert.equal(m.reducible(S["rp-demo-helper"](1, 2)), false);
    } finally {
      m.unregisterProlog("rp_demo");
    }
  });

  it("declares its exports inline too", async () => {
    const inline = `
:- metta_extension(rp_inline, [version('0.1.0')]).
:- metta_export("
    (: rp-inline-scale (-> Number Number))
").
'rp-inline-scale'(X, Y) :- Y is X * 7.
`;
    try {
      assert.deepEqual(m.registerProlog({ source: inline }), ["rp-inline-scale"]);
      assert.deepEqual(await m.fn("rp-inline-scale")(3), [G(21)]);
    } finally {
      m.unregisterProlog(S.rp_inline);
    }
  });

  it("releases an extension whole", async () => {
    m.registerProlog({ path: declared });
    assert.deepEqual(m.unregisterProlog("rp_demo").toSorted(), ["rp-demo-plain", "rp-demo-scale", "rp-demo-shape"]);
    assert.equal(m.reducible(S["rp-demo-scale"](3)), false);
    assert.throws(() => m.unregisterProlog("rp_demo"), refusal(/does not exist/));
    // Registered again, it reports what it declares now.
    assert.deepEqual(m.registerProlog({ path: declared }).toSorted(), [
      "rp-demo-plain",
      "rp-demo-scale",
      "rp-demo-shape",
    ]);
    assert.deepEqual(await m.fn("rp-demo-scale")(3), [G(30)]);
    m.unregisterProlog("rp_demo");
  });

  it("reports a bare declaration's names, the same when registered again", async () => {
    const bare = prologFile(
      "rp_bare.pl",
      ':- metta_export("(: rp-bare-scale (-> Number Number))").\n' + "'rp-bare-scale'(X, Y) :- Y is X * 10.\n",
    );
    assert.deepEqual(m.registerProlog({ path: bare }), ["rp-bare-scale"]);
    assert.deepEqual(await m.fn("rp-bare-scale")(4), [G(40)]);
    assert.deepEqual(m.registerProlog({ path: bare }), ["rp-bare-scale"]);
  });

  it("accepts a provider-only file, which registers no function", async () => {
    const provider = prologFile(
      "rp_provider.pl",
      ":- metta_extension(rp_provider_demo, [spaces(['&rp-provider-demo'])]).\n" +
        ":- multifile seam:foreign_space/1.\n" +
        ":- multifile seam:foreign_capability/2.\n" +
        ":- multifile seam:foreign_atoms/2.\n" +
        "seam:foreign_space('&rp-provider-demo').\n" +
        "seam:foreign_capability('&rp-provider-demo', enumerate).\n" +
        "seam:foreign_atoms('&rp-provider-demo', [fact, a]).\n",
    );
    try {
      assert.deepEqual(m.registerProlog({ path: provider }), []);
      assert.deepEqual(await m.space(S["rp-provider-demo"]).atoms(), [e(S.fact, S.a)]);
    } finally {
      m.unregisterProlog("rp_provider_demo");
    }
  });

  it("refuses a source that names nothing and declares nothing, and loads none of it", async () => {
    // Refusing after the load taught an author that catching the error made
    // everything work, so nothing of it may load.
    const silent = prologFile(
      "rp_silent.pl",
      ":- multifile seam:foreign_space/1.\n" +
        ":- multifile seam:foreign_atoms/2.\n" +
        "seam:foreign_space('&rp-silent-demo').\n" +
        "seam:foreign_atoms('&rp-silent-demo', [fact, a]).\n",
    );
    assert.throws(() => m.registerProlog({ path: silent }), registration(/metta_extension/));
    assert.deepEqual(await m.space(S["rp-silent-demo"]).atoms(), []);
  });
});

describe("renaming a module's exports", () => {
  let rivalA: string;
  let rivalB: string;

  before(() => {
    rivalA = prologFile("rp_liba.pl", ":- module(rp_liba, ['norm'/2]).\n'norm'(X, Y) :- Y is abs(X).\n");
    rivalB = prologFile("rp_libb.pl", ":- module(rp_libb, ['norm'/2]).\n'norm'(X, Y) :- Y is X * X.\n");
  });

  it("registers two modules' one export under two names", async () => {
    assert.deepEqual(m.registerProlog({ path: rivalA }, { norm: "rp-liba-norm" }), ["rp-liba-norm"]);
    assert.deepEqual(m.registerProlog({ path: rivalB }, { norm: S["rp-libb-norm"] }), ["rp-libb-norm"]);
    // Neither is bound to the other's code, which SWI's own refusal of the
    // second import would have left.
    assert.deepEqual(await m.fn("rp-liba-norm")(-5), [G(5)]);
    assert.deepEqual(await m.fn("rp-libb-norm")(-5), [G(25)]);
  });

  it("refuses a rename of something the module does not export", () => {
    assert.throws(() => m.registerProlog({ path: rivalB }, { absent: "rp-absent" }), refusal(/does not export/));
  });

  it("renames only a module, named by its file", () => {
    assert.throws(
      () => m.registerProlog({ source: "'x'(1)." } as never, { x: "rp-x" }),
      registration(/^a file origin/),
    );
    const plain = prologFile("rp_plain.pl", "'plainly'(1, 1).\n");
    assert.throws(() => m.registerProlog({ path: plain }, { plainly: "rp-plainly" }), refusal(/not a Prolog module/));
  });
});

describe("a declared determinism", () => {
  const library = `
:- metta_extension(rp_det, [version('0.1.0')]).
:- metta_export("
    (: rp-det-clean (-> Number Number))
    (determinism rp-det-clean det)
    (: rp-det-leaky (-> Number Number))
    (determinism rp-det-leaky det)
    (: rp-det-many (-> Number Number))
    (determinism rp-det-many nondet)
").
'rp-det-clean'(X, Y) :- Y is X + 1.
'rp-det-leaky'(X, Y) :- member(Y, [X, X]).
'rp-det-many'(X, Y) :- member(Y, [X, X]).
`;

  before(() => {
    m.registerProlog({ path: prologFile("rp_det.pl", library) });
  });

  after(() => {
    m.unregisterProlog("rp_det");
  });

  it("answers a declared det function normally", async () => {
    assert.deepEqual(await m.fn("rp-det-clean")(1), [G(2)]);
  });

  it("raises where a declared det function leaves a choice point", async () => {
    // SWI's own det/1 does this, at the library's door rather than its
    // caller's, where the inference counter cannot see the leak at all.
    await assert.rejects(async () => m.fn("rp-det-leaky")(1), refusal(/deterministic procedure/));
  });

  it("keeps every answer of a declared nondet function", async () => {
    assert.deepEqual(await m.fn("rp-det-many")(1), [G(1), G(1)]);
  });

  it("refuses a determinism it does not know", () => {
    const bad = prologFile(
      "rp_det_bad.pl",
      ':- metta_export("(: rp-bad (-> Number Number))\\n(determinism rp-bad mostly)").\n' + "'rp-bad'(X, X).\n",
    );
    assert.throws(() => m.registerProlog({ path: bad }), refusal(/determinism/));
  });
});
