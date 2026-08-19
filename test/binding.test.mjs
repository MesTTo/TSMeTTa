/**
 * Purpose: the Node binding's own tests, run by `node --test` the way the
 *   TypeScript space example beside it is run.
 * Guarantees:
 *   - the boot inventory, the codec and the lazy answer surface each fail here
 *     before anything downstream sees them
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, fromTransport, toTransport, PettaError, REFUSALS } from "../index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

let petta;

before(async () => {
  petta = await boot();
});

after(() => {
  const left = petta.drainStderr();
  assert.deepEqual(left, [], "the engine wrote to standard error after booting");
});

describe("boot", () => {
  it("refuses only what it names", () => {
    assert.deepEqual(
      petta.refusals.map(({ file, missing }) => `${missing} in ${file}`),
      REFUSALS.map(({ file, missing }) => `${missing} in ${file}`),
    );
  });

  it("names what each refusal costs, and where it happened", () => {
    for (const refusal of petta.refusals) {
      assert.ok(refusal.costs.length > 20, `${refusal.missing} says nothing about what it costs`);
      assert.ok(Number.isInteger(refusal.line), `${refusal.missing} has no line`);
    }
  });
});

describe("running a program", () => {
  it("answers a directive below the definition it calls", () => {
    const groups = petta.run("(= (twice $x) (* $x 2))\n!(twice 21)");
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 1);
    assert.equal(groups[0][0].text, "42");
    assert.deepEqual(groups[0][0].wire, ["n", 42n]);
  });

  it("registers a signature before any form runs, so a pragma may look down", () => {
    // The import is part of the case rather than assumed: without lib_memo
    // loaded `memoize` is an unreduced expression and the assertion would pass
    // while testing that the pragma did nothing.
    petta.run("!(import! &self (library lib_memo))");
    const groups = petta.run("!(memoize thrice)\n(= (thrice $x) (* $x 3))\n!(thrice 7)");
    assert.deepEqual(groups.map((group) => group.map(String)), [["True"], ["21"]]);
  });

  it("refuses a CALL to a definition below it, as the engine does", () => {
    // prepare_parsed_forms/1 registers the signature, which is what lets the
    // pragma above name a function defined lower down; it does not compile the
    // clauses early. The shipped Python host raises the same
    // '$petta_exec:&self':below/2 here [measured 2026-08-20].
    assert.throws(() => petta.run("!(below 1)\n(= (below $x) $x)"), /Unknown procedure/);
  });

  it("keeps one group per directive, in source order", () => {
    const groups = petta.run("!(+ 1 2)\n!(+ 3 4)");
    assert.deepEqual(groups.map((group) => group.map(String)), [["3"], ["7"]]);
  });

  it("reports a directive with no answers as an empty group", () => {
    assert.deepEqual(petta.run("!(empty)"), [[]]);
  });

  it("runs a .metta file from disk", () => {
    const groups = petta.load(join(HERE, "..", "example", "streaming.metta"));
    assert.deepEqual(groups.map((group) => group.map(String)), [["(1 2 3)"]]);
  });

  it("replaces a file's definitions on a reload rather than doubling them", () => {
    // The claim the engine's own loader buys, and the reason load() goes
    // through import_when/4 and replacing_previous_load/4 rather than reading
    // the text here and calling run(): a second load of one file replaces what
    // it put there, and an edited file replaces it with the edit.
    const directory = mkdtempSync(join(tmpdir(), "petta-node-reload-"));
    const file = join(directory, "program.metta");

    writeFileSync(file, "(= (reloaded) 1)\n!(collapse (reloaded))\n");
    assert.deepEqual(petta.load(file)[0].map(String), ["(1)"]);
    assert.deepEqual(petta.load(file)[0].map(String), ["(1)"], "the load doubled");

    writeFileSync(file, "(= (reloaded) 2)\n!(collapse (reloaded))\n");
    assert.deepEqual(petta.load(file)[0].map(String), ["(2)"], "the edit did not replace");
    assert.deepEqual(petta.run("!(collapse (reloaded))")[0].map(String), ["(2)"]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("raises when the source does not parse", () => {
    assert.throws(() => petta.run("!(unclosed"), /missing '\)'/);
  });

  it("raises an error rather than printing it", () => {
    // swipl-wasm writes every Prolog exception to the host's console before
    // handing it back and has no switch for it, so bridge.pl catches inside
    // and the outcome crosses as data. Without that the caller sees the same
    // failure twice, once raised and once written over its own output.
    const written = [];
    const { log, error } = console;
    console.log = (...parts) => written.push(parts.join(" "));
    console.error = (...parts) => written.push(parts.join(" "));
    try {
      assert.throws(() => petta.run("!(unclosed"), PettaError);
      assert.throws(() => petta.run("!(below 1)\n(= (below $x) $x)"), PettaError);
    } finally {
      console.log = log;
      console.error = error;
    }
    assert.deepEqual(written, []);
  });

  it("buffers what a program prints instead of writing it out", () => {
    petta.drainOutput();
    petta.run('!(println! "from the program")');
    assert.deepEqual(petta.drainOutput(), ['"from the program"']);
    assert.deepEqual(petta.drainOutput(), []);
  });
});

describe("the codec", () => {
  it("tells a MeTTa integer from a MeTTa float", () => {
    const [[integer]] = petta.run("!(+ 1 1)");
    const [[float]] = petta.run("!(+ 1.0 1.0)");
    assert.equal(typeof integer.wire[1], "bigint");
    assert.equal(typeof float.wire[1], "number");
    assert.equal(integer.text, "2");
    assert.equal(float.text, "2.0");
  });

  it("carries an integer past the exact JavaScript range", () => {
    const [[answer]] = petta.run("!(* 1000000000000 1000000000000)");
    assert.equal(answer.wire[1], 1000000000000000000000000n);
  });

  it("carries the non-finite floats", () => {
    assert.equal(petta.run("!(/ 1.0 0.0)")[0][0].wire[1], Infinity);
    assert.equal(petta.run("!(/ -1.0 0.0)")[0][0].wire[1], -Infinity);
  });

  it("round trips every leaf tag through the engine", () => {
    for (const wire of [
      ["s", "foo"],
      ["g", "a \"quoted\" string"],
      ["b", true],
      ["b", false],
      ["n", 0n],
      ["n", -0.5],
      ["e", []],
      ["e", [["s", "f"], ["n", 1n], ["g", "s"]]],
    ]) {
      assert.deepEqual(petta.roundTrip(wire), wire, JSON.stringify(wire, (k, v) => String(v)));
    }
  });

  it("refuses a number JavaScript has no type for", () => {
    assert.throws(() => fromTransport(["n", "1r3"]), /no JavaScript type/);
  });

  it("refuses a tag outside the grammar", () => {
    assert.throws(() => fromTransport(["z", "what"]), /unknown wire tag/);
    assert.throws(() => toTransport(["o", {}]), /unknown wire tag/);
  });

  it("refuses a wire atom that is not a pair", () => {
    assert.throws(() => fromTransport(["s"]), /not a transport atom/);
    assert.throws(() => toTransport("s"), /not a wire atom/);
  });

  it("reads one variable payload as one variable", () => {
    // The payload is an identity within its term, not a display name, so
    // (f $x $x) and (f $x $y) are different terms and the codec must keep
    // them apart in both directions.
    assert.equal(petta.text(["e", [["s", "f"], ["v", "x"], ["v", "x"]]]), "(f $_0 $_0)");
    assert.equal(petta.text(["e", [["s", "f"], ["v", "x"], ["v", "y"]]]), "(f $_0 $_1)");
    const read = petta.read("(f $x $x)");
    assert.equal(read[1][1][1], read[1][2][1], "one name read as two variables");
  });

  it("keeps the anonymous payload fresh at every occurrence", () => {
    // `_` is the one reserved payload: two of them constrain nothing, the
    // same as $_ in source.
    assert.equal(petta.text(["e", [["s", "f"], ["v", "_"], ["v", "_"]]]), "(f $_0 $_1)");
  });

  it("refuses a payload of the wrong kind for its tag", () => {
    assert.throws(() => toTransport(["s", 5]), /carries text/);
    assert.throws(() => toTransport(["n", "2"]), /carries a number/);
    assert.throws(() => toTransport(["b", "true"]), /carries a boolean/);
    assert.throws(() => fromTransport(["b", "maybe"]), /carries true or false/);
    assert.throws(() => toTransport(["e", "x"]), /carries a list/);
    assert.throws(() => fromTransport(["e", "x"]), /carries a list/);
  });

  it("keeps the sign of negative zero, which String(-0) loses", () => {
    const [, text] = toTransport(["n", -0]);
    assert.equal(text, "-0.0");
    assert.equal(petta.text(["n", -0]), "-0.0");
    assert.ok(Object.is(petta.roundTrip(["n", -0])[1], -0));
  });
});

describe("the answer stream", () => {
  it("hands over answers one at a time", async () => {
    const seen = [];
    for await (const answer of petta.stream("(superpose (1 2 3))")) seen.push(answer.text);
    assert.deepEqual(seen, ["1", "2", "3"]);
  });

  it("ends on an expression with no answers", async () => {
    const seen = [];
    for await (const answer of petta.stream("(empty)")) seen.push(answer.text);
    assert.deepEqual(seen, []);
  });

  it("leaves an abandoned stream's remaining answers uncomputed", async () => {
    petta.run(`
      (= (seen $n) (let $ignored (add-atom &abandoned (at $n)) $n))
      (= (forever $n) (superpose ((seen $n) (forever (+ $n 1)))))
    `);
    const pulled = [];
    for await (const answer of petta.stream("(forever 1)")) {
      pulled.push(answer.text);
      if (pulled.length === 2) break;
    }
    assert.deepEqual(pulled, ["1", "2"]);
    assert.deepEqual(
      petta.run("!(collapse (get-atoms &abandoned))")[0].map(String),
      ["((at 1) (at 2))"],
      "the generator ran past the answers that were asked for",
    );
  });

  it("lets two streams interleave", async () => {
    const left = petta.stream("(superpose (a b c))")[Symbol.asyncIterator]();
    const right = petta.stream("(superpose (x y z))")[Symbol.asyncIterator]();
    const order = [];
    order.push((await left.next()).value.text);
    order.push((await right.next()).value.text);
    order.push((await left.next()).value.text);
    order.push((await right.next()).value.text);
    await left.return();
    await right.return();
    assert.deepEqual(order, ["a", "x", "b", "y"]);
  });

  it("ends a stream whose expression will not even open", async () => {
    const stream = petta.stream("(unclosed")[Symbol.asyncIterator]();
    await assert.rejects(() => stream.next(), PettaError);
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });

  it("closes a cursor that is abandoned before its first pull", async () => {
    const stream = petta.stream("(superpose (1 2 3))")[Symbol.asyncIterator]();
    await stream.return();
    assert.deepEqual(await stream.next(), { done: true, value: undefined });
  });
});
