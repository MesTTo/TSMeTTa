/**
 * Purpose: the module tier — one lazily booted engine behind free functions.
 * Assumes: `node --test` runs each file in its own process, so the default
 *   engine this file creates is this file's alone.
 * Guarantees:
 *   - importing the module boots nothing
 *   - an ask from the module tier is as lazy as the method it stands for
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { after, describe, it } from "node:test";

import { S, V } from "../src/index.ts";
import * as ambient from "../src/ambient.ts";

after(async () => {
  await ambient.reset();
});

describe("the module tier", () => {
  it("boots nothing until a verb needs the engine", () => {
    // Importing has happened; building a term is ordinary TypeScript; and the
    // ask below is a DESCRIPTION, so nothing has started an engine yet.
    const ask = ambient.match(S.parent(V.x, S.bob));
    assert.match(ask.description, /^match\(\(parent \$x bob\)\)$/);
    // Configuring is allowed only while nothing has booted, which is the point
    // being made here: this call proves no engine exists.
    ambient.configure({});
  });

  it("boots on the first verb, and every verb shares the one engine", async () => {
    await ambient.add(S.parent(S.tom, S.bob));
    const rows = await ambient.match(S.parent(V.x, S.bob));
    assert.deepEqual(rows.map((row) => String(row["x"])), ["tom"]);
    assert.ok(await ambient.has(S.parent(S.tom, S.bob)));

    const surface = await ambient.engine();
    assert.ok(surface.has(S.parent(S.tom, S.bob)), "the same engine, through the handle");
    assert.equal(await ambient.engine(), surface, "one engine, cached");
  });

  it("refuses to reconfigure an engine that has already booted", async () => {
    await ambient.engine();
    assert.throws(() => ambient.configure({ verbose: true }));
  });

  it("runs source, reduces a term and reads a query's own text", async () => {
    await ambient.run("(= (twice $x) (* 2 $x))");
    assert.deepEqual((await ambient.evaluate(S.twice(21))).map(String), ["42"]);
    await ambient.add(S.likes(S.ada, S.tea));
    const drinks = await ambient.q("(likes ada $drink)");
    assert.deepEqual(drinks.map((row) => String(row["drink"])), ["tea"]);
  });

  it("reaches the reflection verbs too", async () => {
    await ambient.run("(= (dbl $x) (* 2 $x))");
    const proof = await ambient.why(S.dbl(4));
    assert.ok(proof !== undefined);
    assert.equal(proof.answer.text, "8");
    assert.deepEqual(
      (await ambient.forms("!(dbl 1)")).map((form) => form.kind),
      ["runnable"],
    );
    assert.equal((await ambient.parse("(f 1)")).text, "(f 1)");
    assert.equal((await ambient.self()).name, "&self");
    assert.equal((await ambient.catalog()).name, "&metta");
  });

  it("forgets the engine on reset, and boots a fresh one afterwards", async () => {
    await ambient.add(S.gone(1));
    assert.ok(await ambient.has(S.gone(1)));
    await ambient.reset();
    assert.ok(!(await ambient.has(S.gone(1))), "a fresh engine holds nothing");
  });
});
