/**
 * Purpose: the transport's own tests against a live engine: the boot
 *   inventory, the codec through the engine's reader and writer, the program
 *   runner, and the lazy answer surface.
 * Assumes:
 *   - swipl-wasm is installed; `npm ci` fetches it
 * Guarantees:
 *   - Number and BigInt cross the signed-i64 boundary without losing a digit
 *   - an abandoned stream leaves the rest of an unbounded generator uncomputed
 *   - nothing the engine says reaches the host's console
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Grounded,
  type MeTTa,
  MettaError,
  S,
  SpaceHandle,
  Superpose,
  V,
  atomFromWire,
  isError,
  metta,
  packageRoot,
  space,
  sym,
  wireFromAtom,
} from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  assert.deepEqual(m.drainStderr(), [], "the engine wrote to standard error after booting");
  m.dispose();
});

describe("boot", () => {
  it("reads what this build does without from the engine's own census", () => {
    assert.deepEqual(
      m.refusals.map(({ capability }) => capability).sort(),
      ["concurrency", "deadlines", "subprocess"],
    );
  });

  it("names the library each absence needs, and what it costs", () => {
    for (const refusal of m.refusals) {
      assert.match(refusal.requires, /^library\(\w+\)$/);
      assert.ok(
        refusal.costs.length > 20,
        `${refusal.capability} says nothing about what it costs`,
      );
    }
  });
});

describe("running a program", () => {
  it("answers a directive below the definition it calls", () => {
    const groups = m.run("(= (twice $x) (* $x 2))\n!(twice 21)");
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0]?.texts, ["42"]);
    assert.deepEqual(wireFromAtom(groups[0]!.answers[0]!), ["n", 42n]);
  });

  it("registers a signature before any form runs, so a pragma may look down", () => {
    // The import is part of the case rather than assumed: without lib_memo
    // loaded `memoize` is an unreduced expression and the assertion would pass
    // while testing that the pragma did nothing.
    m.run("!(import! &self (library lib_memo))");
    const groups = m.run("!(memoize thrice)\n(= (thrice $x) (* $x 3))\n!(thrice 7)");
    assert.deepEqual(groups.map((group) => group.texts), [["True"], ["21"]]);
  });

  it("answers a call to a definition below it unreduced, as the engine does", () => {
    // prepare_parsed_forms/1 registers the signature, which is what lets the
    // pragma above name a function defined lower down; it does not compile the
    // clauses early. Evaluation follows LeaTTa's evalSequentialRun: a bang sees
    // only the preceding prefix, so the call stays data.
    assert.deepEqual(
      m.run("!(below 1)\n(= (below $x) $x)").map((group) => group.texts),
      [["(below 1)"]],
    );
  });

  it("keeps one group per directive, in source order", () => {
    assert.deepEqual(m.run("!(+ 1 2)\n!(+ 3 4)").map((group) => group.texts), [["3"], ["7"]]);
  });

  it("reports a directive with no answers as an empty group", () => {
    assert.deepEqual(m.run("!(empty)").map((group) => group.texts), [[]]);
  });

  it("interpolates a built term into the string rung", () => {
    m.load`(= (limit) ${100})`;
    assert.deepEqual(m.run("!(limit)").map((group) => group.texts), [["100"]]);
  });

  it("runs a .metta file from disk", () => {
    const groups = m.loadFile(join(packageRoot, "examples", "streaming.metta"));
    assert.deepEqual(groups.map((group) => group.texts), [["(1 2 3)"]]);
  });

  it("replaces a file's definitions on a reload rather than doubling them", () => {
    // The claim the engine's own loader buys, and the reason loadFile goes
    // through the engine's load door rather than reading the text here and
    // calling run(): a second load of one file replaces what it put there.
    const directory = mkdtempSync(join(tmpdir(), "metta-node-reload-"));
    const file = join(directory, "program.metta");

    writeFileSync(file, "(= (reloaded) 1)\n!(collapse (reloaded))\n");
    assert.deepEqual(m.loadFile(file)[0]?.texts, ["(1)"]);
    assert.deepEqual(m.loadFile(file)[0]?.texts, ["(1)"], "the load doubled");

    writeFileSync(file, "(= (reloaded) 2)\n!(collapse (reloaded))\n");
    assert.deepEqual(m.loadFile(file)[0]?.texts, ["(2)"], "the edit did not replace");
    assert.deepEqual(m.run("!(collapse (reloaded))")[0]?.texts, ["(2)"]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("raises when the source does not parse", () => {
    assert.throws(() => m.run("!(unclosed"), /missing '\)'/);
  });

  it("raises an error rather than printing it", () => {
    // swipl-wasm writes every Prolog exception to the host's console before
    // handing it back and has no switch for it, so bridge.pl catches inside and
    // the outcome crosses as data. Without that the caller sees the same
    // failure twice, once raised and once written over its own output.
    const written: string[] = [];
    const { log, error } = console;
    console.log = (...parts: unknown[]) => written.push(parts.join(" "));
    console.error = (...parts: unknown[]) => written.push(parts.join(" "));
    try {
      assert.throws(() => m.run("!(unclosed"), MettaError);
      assert.throws(() => m.run("!(car-atom $u)"), MettaError);
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.deepEqual(written, []);
  });

  it("buffers what a program prints instead of writing it out", () => {
    m.drainOutput();
    m.run('!(println! "from the program")');
    assert.deepEqual(m.drainOutput(), ['"from the program"']);
    assert.deepEqual(m.drainOutput(), []);
  });
});

describe("the codec, through the engine", () => {
  it("tells a MeTTa integer from a MeTTa float", () => {
    const integer = m.run("!(+ 1 1)")[0]!.answers[0]!;
    const float = m.run("!(+ 1.0 1.0)")[0]!.answers[0]!;
    assert.deepEqual(wireFromAtom(integer), ["n", 2n]);
    assert.deepEqual(wireFromAtom(float), ["n", 2]);
    assert.equal(m.run("!(+ 1 1)")[0]!.texts[0], "2");
    assert.equal(m.run("!(+ 1.0 1.0)")[0]!.texts[0], "2.0");
    // The engine's `==` PROMOTES: numeric equality is by value across the
    // integer/float constructors, following LeaTTa's Ground.equiv
    // [source: engine/metta/operators.pl, '=='/3]. What tells the two apart is
    // IDENTITY, and identity is what a codec has to preserve.
    assert.equal(m.run("!(== 2 2.0)")[0]!.texts[0], "True", "equality promotes");
    assert.equal(m.run("!(=alpha 2 2.0)")[0]!.texts[0], "False", "identity does not");
    assert.equal(
      m.run("!(case 2 ((2.0 float) ($_ other)))")[0]!.texts[0],
      "other",
      "a pattern tells them apart",
    );
    assert.equal(
      m.run("!(subtraction-atom (2 2.0) (2))")[0]!.texts[0],
      "(2.0)",
      "a multiset difference tells them apart",
    );
  });

  it("carries an integer past the exact JavaScript range", () => {
    const answer = m.run("!(* 1000000000000 1000000000000)")[0]!.answers[0]!;
    assert.ok(answer instanceof Grounded);
    assert.equal(answer.value, 1000000000000000000000000n);
  });

  it("carries Number and BigInt across the signed-i64 boundary", () => {
    const boundaries: readonly (readonly [string, string])[] = [
      ["-9223372036854775809", "BigInt"],
      ["-9223372036854775808", "Number"],
      ["9223372036854775807", "Number"],
      ["9223372036854775808", "BigInt"],
      ["170141183460469231731687303715884118073", "BigInt"],
    ];
    for (const [digits, type] of boundaries) {
      const read = m.parse(digits);
      assert.deepEqual(wireFromAtom(read), ["n", BigInt(digits)]);
      assert.equal(m.roundTrip(read), read, `${digits} did not round trip`);
      assert.equal(m.run(`!(get-type ${digits})`)[0]!.texts[0], type);
    }
  });

  it("carries the non-finite floats", () => {
    const positive = m.run("!(/ 1.0 0.0)")[0]!.answers[0]!;
    const negative = m.run("!(/ -1.0 0.0)")[0]!.answers[0]!;
    assert.ok(positive instanceof Grounded && negative instanceof Grounded);
    assert.equal(positive.value, Infinity);
    assert.equal(negative.value, -Infinity);
  });

  it("round trips every leaf shape through the engine", () => {
    for (const atom of [
      sym("foo"),
      S["car-atom"].atom,
      m.parse('"a \\"quoted\\" string"'),
      m.parse("True"),
      m.parse("0"),
      m.parse("-0.5"),
      m.parse("()"),
      m.parse("(f 1 \"s\")"),
    ]) {
      assert.equal(m.roundTrip(atom), atom, `${String(atom)} did not round trip`);
    }
  });

  it("reads a space reference back as an interned handle", () => {
    const read = m.parse("&self");
    assert.ok(read instanceof SpaceHandle);
    assert.equal(read, space("&self"));
    assert.equal(m.text(space("&kb")), "&kb");
  });

  it("keeps the sign of negative zero, which String(-0) loses", () => {
    assert.equal(m.text(m.parse("-0.0")), "-0.0");
    const back = m.roundTrip(m.parse("-0.0"));
    assert.ok(back instanceof Grounded);
    assert.ok(Object.is(back.value, -0));
  });

  it("reads one variable payload as one variable", () => {
    // The payload is an identity within its term, not a display name, so
    // (f $x $x) and (f $x $y) are different terms and the codec keeps them
    // apart in both directions.
    assert.equal(m.text(m.parse("(f $x $x)")), "(f $_0 $_0)");
    assert.equal(m.text(m.parse("(f $x $y)")), "(f $_0 $_1)");
  });

  it("keeps the anonymous payload fresh at every occurrence", () => {
    assert.equal(m.text(m.parse("(f $_ $_)")), "(f $_0 $_1)");
  });
});

describe("the answer stream", () => {
  it("hands over answers one at a time", async () => {
    const seen: string[] = [];
    for await (const answer of m.eval(Superpose([1, 2, 3]))) seen.push(String(answer));
    assert.deepEqual(seen, ["1", "2", "3"]);
  });

  it("ends on an expression with no answers", async () => {
    assert.deepEqual(await m.eval(S.empty()), []);
  });

  it("leaves an abandoned stream's remaining answers uncomputed", async () => {
    m.run(`
      (= (seen $n) (let $ignored (add-atom &abandoned (at $n)) $n))
      (= (forever $n) (superpose ((seen $n) (forever (+ $n 1)))))
    `);
    const pulled: string[] = [];
    for await (const answer of m.eval(S.forever(1))) {
      pulled.push(String(answer));
      if (pulled.length === 2) break;
    }
    assert.deepEqual(pulled, ["1", "2"]);
    assert.deepEqual(
      m.run("!(collapse (get-atoms &abandoned))")[0]?.texts,
      ["((at 1) (at 2))"],
      "the generator ran past the answers that were asked for",
    );
  });

  it("takes only what take() asked for", async () => {
    m.run("(= (forever $n) (superpose ($n (forever (+ $n 1)))))");
    assert.deepEqual((await m.eval(S.forever(1)).take(3)).map(String), ["1", "2", "3"]);
  });

  it("lets two streams interleave", async () => {
    const left = m.eval(Superpose([S.a, S.b, S.c]))[Symbol.asyncIterator]();
    const right = m.eval(Superpose([S.x, S.y, S.z]))[Symbol.asyncIterator]();
    const order: string[] = [];
    order.push(String((await left.next()).value));
    order.push(String((await right.next()).value));
    order.push(String((await left.next()).value));
    order.push(String((await right.next()).value));
    await left.return?.(undefined);
    await right.return?.(undefined);
    assert.deepEqual(order, ["a", "x", "b", "y"]);
  });

  it("closes a cursor that is abandoned before its first pull", async () => {
    const stream = m.eval(Superpose([1, 2, 3]))[Symbol.asyncIterator]();
    await stream.return?.(undefined);
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  it("keeps a source variable's own name in the answer and in the text", () => {
    // The engine's plain reader answers a term whose variables carry no record
    // of what the source called them, so a row keyed by a pattern's variables
    // would be keyed by the writer's counter. The reader that keeps the names
    // is what makes `m.q("(likes ada $drink)")` answer a `drink`.
    assert.equal(String(m.parse("(likes ada $drink)")), "(likes ada $drink)");
    assert.equal(String(m.parse("(f $x $x)")), "(f $x $x)");
    assert.match(String(m.parse("(g $_ $_)")), /^\(g \$_\d+ \$_\d+\)$/);
  });

  it("refuses a host operation reached where the engine cannot suspend", async () => {
    // A dispatch clause yields, and a yield needs an engine with a suspension
    // point. Reached inside a transaction or speculate scope there is none,
    // and SWI's own diagnostic names a virtual machine instruction, which
    // tells an author of TypeScript nothing.
    m.op(function needsTheHost(): number {
      return 1;
    }, { effect: "pureStructural" });
    await assert.rejects(
      () => m.speculate(S["needs-the-host"]()).one(),
      (error: MettaError) =>
        /the engine has no suspension point/.test(error.message) &&
        /transaction or speculate scope/.test(error.message),
    );
  });

  it("ends a stream whose expression will not even open", async () => {
    const stream = m.eval(S["car-atom"](V.u))[Symbol.asyncIterator]();
    await assert.rejects(() => stream.next(), MettaError);
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  it("runs nothing until something consumes", async () => {
    const before = m.counters.crossings;
    const ask = m.eval(S["+"](1, 1));
    assert.equal(m.counters.crossings, before, "building an ask cost a crossing");
    assert.equal(String(await ask.one()), "2");
    assert.ok(m.counters.crossings > before);
  });

  it("prints as the ask it is, never as a half-consumed object", () => {
    assert.equal(String(m.eval(S["+"](1, 1))), "Answers((+ 1 1))");
  });

  it("stops when a signal is already aborted", async () => {
    m.run("(= (forever $n) (superpose ($n (forever (+ $n 1)))))");
    const signal = AbortSignal.abort(new Error("enough"));
    await assert.rejects(() => m.eval(S.forever(1)).until(signal).toArray(), /enough/);
  });

  it("stops at a deadline, which a synchronous pull would otherwise starve", async () => {
    // The engine is in this process and a pull is synchronous, so an ask that
    // carries a signal yields one event-loop turn per answer. Without that the
    // timer behind the deadline never gets to fire and the loop runs until the
    // process dies [measured 2026-08-27].
    m.run("(= (forever $n) (superpose ($n (forever (+ $n 1)))))");
    const started = Date.now();
    await assert.rejects(
      () => m.eval(S.forever(1)).until(AbortSignal.timeout(60)).toArray(),
      (error: Error) => error.name === "TimeoutError",
    );
    assert.ok(Date.now() - started < 5000, "the deadline did not stop the pull");
    assert.equal(String(await m.eval(S["+"](1, 1)).one()), "2", "the engine did not survive it");
  });
});

describe("exactly one, and at most one", () => {
  it("answers the one answer", async () => {
    assert.equal(String(await m.eval(S["+"](20, 22)).one()), "42");
  });

  it("refuses zero and more than one, with a code each", async () => {
    await assert.rejects(
      () => m.eval(S.empty()).one(),
      (error: MettaError) => error.code === "ERR_METTA_ABSENT",
    );
    await assert.rejects(
      () => m.eval(Superpose([1, 2])).one(),
      (error: MettaError) => error.code === "ERR_METTA_AMBIGUOUS",
    );
  });

  it("answers undefined for at most one, so ?? composes", async () => {
    assert.equal(await m.eval(S.empty()).find(), undefined);
    assert.equal(String((await m.eval(S.empty()).find()) ?? sym("none")), "none");
    assert.equal(String(await m.eval(Superpose([7, 8])).find()), "7");
  });
});

describe("errors are data, and interruption is opt-in", () => {
  // One definition, for every case here. Defining it per case would ADD a
  // clause each time, because coexisting equations are MeTTa's own law, and
  // the second case would then see two error atoms where it asked for one.
  before(() => {
    m.run("(= (bad $n) (car-atom ()))");
  });

  it("answers an error atom per failing branch, beside the branches that worked", async () => {
    const answers = await m.eval(Superpose([S.bad(1), S["+"](1, 1)]));
    assert.equal(answers.length, 2);
    assert.equal(answers.filter(isError).length, 1);
    assert.deepEqual(answers.filter((answer) => !isError(answer)).map(String), ["2"]);
  });

  it("raises one branch's own error, and the platform's AggregateError for several", async () => {
    await assert.rejects(
      () => m.eval(S.bad(1)).orThrow(),
      (error: unknown) => error instanceof MettaError && !(error instanceof AggregateError),
    );
    await assert.rejects(
      () => m.eval(Superpose([S.bad(1), S.bad(2)])).orThrow(),
      (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
    );
  });

  it("keeps the error ATOM as the cause, so reporting one never loses it", async () => {
    try {
      await m.eval(S.bad(1)).orThrow();
      assert.fail("expected a refusal");
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause;
      assert.ok(isError(cause), "the atom did not ride along");
      assert.match(String(cause), /^\(Error \(car-atom \(\)\)/);
    }
  });

  it("answers everything when nothing failed", async () => {
    assert.deepEqual((await m.eval(Superpose([1, 2])).orThrow()).map(String), ["1", "2"]);
  });
});

describe("the atom door and the engine's own writer agree", () => {
  it("renders what this host renders, for everything with a text spelling", () => {
    for (const source of ["(parent tom bob)", '"text"', "42", "2.0", "True", "()"]) {
      const atom = m.parse(source);
      assert.equal(m.text(atom), String(atom), `${source} renders differently on the two sides`);
      assert.equal(atomFromWire(wireFromAtom(atom)), atom);
    }
  });
});
