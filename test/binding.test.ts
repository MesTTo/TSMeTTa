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
 *   - `byStandardOrder` sorts the portable ground image exactly as SWI `msort`
 *     while variables and opaque values retain one host-stable order across
 *     engine sessions [tested: "sorts the portable ground image exactly as the
 *     engine's msort", "keeps host-only order stable across reverse engine
 *     allocation"; commit=WORKTREE]
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
  Expression,
  G,
  Grounded,
  type MeTTa,
  MettaError,
  S,
  SpaceHandle,
  Superpose,
  V,
  atomFromWire,
  byStandardOrder,
  expr,
  exprOf,
  float,
  hostText,
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

describe("a term deeper than the JavaScript stack", () => {
  // The transport recursed once per nesting level in each direction until
  // 2026-08-31: `m.parse` of a term 2,048 deep raised `RangeError: Maximum
  // call stack size exceeded` from inside the WebAssembly call and left the
  // engine unusable, with every later goal answering `Unknown procedure:
  // system:metta_node_do/2`. The bound is the ENGINE's own stack now [C47].
  const DEEP = 50_000;
  const deepSource = `${"(f ".repeat(DEEP)}1${")".repeat(DEEP)}`;

  it("reads one through the engine's own reader and renders it back", () => {
    const atom = m.parse(deepSource);
    assert.equal(atom.text.length, deepSource.length);
    assert.equal(atom.text, deepSource);
  });

  it("carries one into the engine and back unchanged", () => {
    assert.equal(m.roundTrip(m.parse(deepSource)), m.parse(deepSource));
    assert.equal(m.text(m.parse(deepSource)).length, deepSource.length);
  });

  // What the engine does at its OWN ceiling is test/depth.test.ts, which gets
  // its own process so it can lower `stackLimit` to 64 MiB: reaching the
  // build's 1 GiB ceiling here would make this file allocate two gigabytes
  // beside twenty-nine other suites.
});

describe("what a variable is called on the wire", () => {
  // SWI prints an unbound variable as its STACK OFFSET, and this seat used to
  // send that as the variable's name. An offset moves when a collection moves
  // the cell and is handed to whatever lands there next, so one variable could
  // cross under two names and two under one. Measured 2026-08-31 in this
  // build: `[f, V, <three million cells>, V]` gave `_20612914` for the first
  // occurrence of V and `_70` for the second [C54].

  it("mints the name rather than reading the cell's address", () => {
    const answer = m.engine.once("metta_node_encode(V, W), term_to_atom(V, Printed)");
    const wire = answer["W"] as readonly unknown[];
    assert.equal(hostText(wire[0]), "v");
    assert.notEqual(
      hostText(wire[1]),
      hostText(answer["Printed"]),
      "the wire name is the cell's printed form, which is its stack offset",
    );
  });

  it("spends one name per cell and never one name on two", () => {
    const answer = m.engine.once("metta_node_encode([f, V, V, Other], W)");
    const wire = answer["W"] as readonly unknown[];
    // An `e` carries its child COUNT, which is a number rather than text, so
    // the scan reads only the tokens that are a tag.
    const names: string[] = [];
    for (let at = 0; at < wire.length; at += 1) {
      if (wire[at] === "v") names.push(hostText(wire[at + 1]));
    }
    assert.equal(names.length, 3);
    assert.equal(names[0], names[1], "one cell, twice, is one name");
    assert.notEqual(names[0], names[2], "two cells are never one name");
  });

  it("gives two crossings two names, so a host cannot conflate them", () => {
    const first = hostText((m.engine.once("metta_node_encode(V, W)")["W"] as unknown[])[1]);
    const second = hostText((m.engine.once("metta_node_encode(V, W)")["W"] as unknown[])[1]);
    assert.notEqual(first, second, "a host atom compares by spelling");
  });

  it("answers a host operation's own argument variable back as that variable", () => {
    // The reply decodes against the map the CALL was encoded under. Without
    // it the returned variable was a fresh cell and the answer read `$_0`.
    const surface = m;
    surface.op(
      function echoes(x: unknown) {
        return x;
      },
      { raw: true, effect: "pureStructural" },
    );
    assert.deepEqual(surface.run("!(echoes $q)")[0]?.texts, ["$q"]);
  });

  it("gives one variable in two arguments one name", () => {
    const seen: string[] = [];
    m.op(
      function bothOf(a: unknown, b: unknown) {
        seen.push(String(a), String(b));
        return S.ok();
      },
      { raw: true, effect: "pureStructural" },
    );
    m.run("!(both-of $w $w)");
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1], "one variable in two argument positions");
  });
});

describe("the lifetime of a surface", () => {
  it("refuses a root that is not a checkout, by name", async () => {
    await assert.rejects(
      metta({ root: "/no/such/tree" }),
      (error: unknown) => {
        assert.ok(MettaError.is(error, "ERR_METTA_SOURCE"), String(error));
        assert.match(String(error), /is not a MeTTa Kernel checkout/);
        return true;
      },
    );
  });

  it("refuses every door once it is disposed, rather than answering", async () => {
    const released = await metta();
    assert.equal(released.parse("(f 1)").text, "(f 1)");
    released.dispose();
    for (const door of [
      () => released.parse("(f 1)"),
      () => released.run("!(+ 1 2)"),
      () => released.spaces(),
      () => released.self.add(S.after()),
    ]) {
      assert.throws(door, (error: unknown) => {
        assert.ok(MettaError.is(error, "ERR_METTA_CLOSED"), String(error));
        return true;
      });
    }
    // Disposing twice is not an error; releasing what is already released has
    // nothing left to say.
    released.dispose();
  });

  it("refuses an ask that was in flight when the surface closed", async () => {
    const released = await metta();
    released.self.add(...Array.from({ length: 20 }, (_, at) => S.row(S.n(at))));
    const iterator = released.match(S.row(V.x))[Symbol.asyncIterator]();
    await iterator.next();
    released.dispose();
    await assert.rejects(iterator.next(), (error: unknown) => {
      assert.ok(MettaError.is(error, "ERR_METTA_CLOSED"), String(error));
      return true;
    });
    // Closing the abandoned stream is still allowed: cleanup must not raise.
    assert.equal((await iterator.return?.())?.done, true);
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
    assert.deepEqual(groups.map((group) => group.texts), [["true"], ["21"]]);
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
  it("sorts the portable ground image exactly as the engine's msort", async () => {
    const atoms = [
      expr(sym("z")),
      expr(sym("a"), sym("b")),
      expr(sym("a")),
      expr(),
      sym("z"),
      sym("Apple"),
      G("kiwi"),
      G(false),
      G(true),
      space("&space"),
      G(Number.NaN),
      G(Number.NEGATIVE_INFINITY),
      G(-0),
      float(0),
      G(0),
      G(0n),
      G(2n ** 60n),
      G(2n ** 60n + 1n),
    ];
    const [answer] = await m.eval(S.msort(exprOf(atoms))).toArray();
    assert.ok(answer instanceof Expression);
    assert.deepEqual(answer.items.map(String), [...atoms].sort(byStandardOrder).map(String));
  });

  it("keeps host-only order stable across reverse engine allocation", async () => {
    const first = G({});
    const second = G({});
    const order = (): string[] =>
      [first, second]
        .sort(byStandardOrder)
        .map((atom) => (atom === first ? "first" : "second"));
    const before = order();

    // SWI sees these in the opposite order. That session-local handle order
    // cannot change a context-free comparator over host atoms.
    await m.eval(second).toArray();
    await m.eval(first).toArray();

    assert.deepEqual(order(), before);
  });

  it("tells a MeTTa integer from a MeTTa float", () => {
    const integer = m.run("!(+ 1 1)")[0]!.answers[0]!;
    const float = m.run("!(+ 1.0 1.0)")[0]!.answers[0]!;
    assert.deepEqual(wireFromAtom(integer), ["n", 2n]);
    assert.deepEqual(wireFromAtom(float), ["n", 2]);
    assert.equal(m.run("!(+ 1 1)")[0]!.texts[0], "2");
    assert.equal(m.run("!(+ 1.0 1.0)")[0]!.texts[0], "2.0");
    // The engine's `==` is pure TERM equality. Integer and float constructors
    // therefore remain distinct [source:
    // PeTTa@ae66fa8e41dcd5539d614706bd4e5cfb34f9608d src/metta.pl,
    // eval_20/6 clauses for '==' and '!='].
    assert.equal(m.run("!(== 2 2.0)")[0]!.texts[0], "false", "term equality distinguishes");
    assert.equal(m.run("!(!= 2 2.0)")[0]!.texts[0], "true", "term inequality distinguishes");
    assert.equal(m.run("!(=alpha 2 2.0)")[0]!.texts[0], "false", "identity does not");
    assert.equal(
      m.run("!(== (Error bad none) 0)")[0]!.texts[0],
      "false",
      "a written Error is compared as a term",
    );
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

  it("tracks the engine's aligned effects, misses and arity errors", () => {
    assert.deepEqual(
      m.run(
        "!(add-atom &node-alignment-effects (dup 1))\n" +
          "!(add-atom &node-alignment-effects (dup 1))\n" +
          "!(remove-atom &node-alignment-effects (dup $x))\n" +
          "!(collapse (match &node-alignment-effects (dup $x) $x))\n" +
          "!(remove-atom &node-alignment-effects missing)",
      ).map((group) => group.texts),
      [["true"], ["true"], ["true"], ["()"], ["true"]],
      "effects answer true and removal drains every unifying occurrence",
    );

    assert.deepEqual(
      m.run(
        "(= (node-alignment-only a) yes)\n" +
          "!(node-alignment-only b)\n" +
          "!(test (node-alignment-only b) ())",
      ).map((group) => group.texts),
      [[], ["true"]],
      "NoMatchFail answers nothing and test compares that miss as ()",
    );
    assert.deepEqual(m.drainOutput(), ["is (), should (). ✅ "]);

    assert.equal(
      m.run("!(repr (catch (+ 1 2 3)))")[0]!.texts[0],
      '"(Error (domain_error (function_input_arities + (2)) 3) none)"',
      "overapplication reports the function, known arities and asked arity",
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
