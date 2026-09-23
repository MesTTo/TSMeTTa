/**
 * Purpose: the doors a program reaches the engine's own vocabulary through:
 *   `space.fn`, which ASKS an engine function where `fn` builds the term, and
 *   `space.import` with the `lib` namespace, which loads a library or a file.
 * Guarantees:
 *   - `m.fn.name(...)` answers exactly what `m.eval(fn.name(...))` answers, for
 *     an operator word, a hyphenated head and the exact call door alike
 *     [tested: "asks what fn builds"]
 *   - `lib.x` is `(library lib_x)`, `lib(name)` and `lib(name, file)` are the
 *     exact forms, and importing one makes the library's functions answer
 *     [tested: "imports a shipped library by name"]
 *   - a host path imports the file the process sees, with a relative import
 *     inside it resolving beside it [tested: "imports a file by its host path"]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { FALSE, G, type MeTTa, S, TRUE, V, e, fn, lib, metta, toAtom } from "../src/index.ts";

let m: MeTTa;

before(async () => {
  m = await metta();
});

after(() => {
  m.dispose();
});

describe("space.fn", () => {
  it("asks what fn builds", async () => {
    assert.deepEqual(await m.fn.add(1, 2), await m.eval(fn.add(1, 2)));
    assert.deepEqual(await m.fn.add(1, 2), [toAtom(3)]);
    assert.deepEqual(await m.fn.carAtom(e(S.a, S.b)), [S.a.atom]);
    assert.deepEqual(await m.fn("car-atom")(e(S.a, S.b)), [S.a.atom]);
    const kb = m.space(S.doorsKb);
    kb.add(S.item(1), S.item(2));
    assert.deepEqual(await kb.fn.match(kb, S.item(V.n), V.n), [toAtom(1), toAtom(2)]);
    assert.equal(m.fn, m.self.fn, "one namespace per space");
  });
});

describe("space.import", () => {
  it("imports a shipped library by name", async () => {
    assert.equal(lib.spaces.form, S.library(S.lib_spaces));
    assert.equal(lib.import.form, S.library(S.lib_import));
    assert.equal(lib("minimal_metta_lib").form, S.library(S.minimal_metta_lib));
    assert.equal(lib("metta_fixture_lib", "fixture").form, S.library(S.metta_fixture_lib, S.fixture));
    assert.equal(toAtom(lib.spaces), S.library(S.lib_spaces), "a library reference is also its term");

    const kb = m.space(S.doorsImport);
    assert.equal(kb.import(lib.spaces), kb, "import answers the space, as add does");
    kb.add(S.friend(S.a, S.b));
    assert.deepEqual(await kb.fn.find(kb, S.friend(V.x, V.y)), [TRUE]);
    assert.deepEqual(await kb.fn.find(kb, S.friend(S.b, V.y)), [FALSE]);
  });

  it("imports a file by its host path, and a relative import inside it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tsmetta-import-"));
    try {
      writeFileSync(join(directory, "helper.metta"), "(= (helped $x) (+ $x 1))\n");
      writeFileSync(join(directory, "main.metta"), "!(import! &self helper)\n(= (greeting) hello)\n");
      const kb = m.space(S.doorsPath);
      kb.import(join(directory, "main.metta"));
      assert.deepEqual(await kb.fn.greeting(), [S.hello.atom]);
      assert.deepEqual(await kb.fn.helped(41), [G(42)]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
