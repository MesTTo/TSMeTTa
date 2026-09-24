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
 *     inside it resolving beside it [tested: "imports a file by its host path,
 *     and a relative import inside it";
 *     commit=bf758a5e0654c691ad64e2a5d998fb7c2e39108b]
 *   - a file loads whatever else its directory holds, a link to nothing
 *     included [tested: "loads a file whose directory holds a link to
 *     nothing"; commit=a151c899a11b3b8ffb405b23b67d1f2000ded4dd]
 *   - the engine sees this host's files at their own paths and starts in this
 *     process's working directory, a working directory of / included, and a
 *     Windows path is its drive's mount [tested: "resolves a relative path
 *     against this process's working directory, as the native engine does",
 *     "reads a host file written after boot and writes one the host reads",
 *     "boots in a working directory of / with no mount of its own", "names a
 *     Windows path by its drive's mount";
 *     commit=1369817ebd86d76661ac9f36c0e39b5b3bf75007]
 *   - each engine mints its temporary names in a directory of its own, which
 *     its disposal removes [tested: "gives every engine a temporary directory
 *     of its own, and removes it when the engine is disposed";
 *     commit=609b2715276edf92ba47f9853c0a05a29221d787]
 * Open Obligations: None.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { FALSE, G, type MeTTa, S, TRUE, V, e, fn, lib, metta, toAtom } from "../src/index.ts";
import { enginePath } from "../src/platform.ts";

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

  it("loads a file whose directory holds a link to nothing", async () => {
    // A directory another process writes into can hold a link whose target
    // is gone; the engine reads the one file it was asked for.
    const directory = mkdtempSync(join(tmpdir(), "tsmetta-mount-"));
    try {
      writeFileSync(join(directory, "main.metta"), "(= (mounted) yes)\n");
      symlinkSync(join(directory, "removed.metta"), join(directory, "dangling.metta"));
      m.loadFile(join(directory, "main.metta"));
      assert.deepEqual(await m.fn.mounted(), [S.yes.atom]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

describe("the host's files", () => {
  let host: MeTTa;

  before(async () => {
    host = await metta();
    host.import(lib.file);
    host.import(lib.system);
  });

  after(() => {
    host.dispose();
  });

  it("resolves a relative path against this process's working directory, as the native engine does", async () => {
    assert.deepEqual(await host.fn.workingDirectory(), [G(process.cwd())]);
    assert.deepEqual(await host.fn.fileExists("package.json"), [TRUE]);
    assert.deepEqual(await host.fn.fileExists("no-such-file.here"), [FALSE]);
  });

  it("reads a host file written after boot and writes one the host reads", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tsmetta-host-"));
    try {
      writeFileSync(join(directory, "late.metta"), "(= (late) yes)\n");
      host.loadFile(join(directory, "late.metta"));
      assert.deepEqual(await host.fn.late(), [S.yes.atom]);
      const written = join(directory, "from-engine.txt");
      assert.deepEqual(await host.fn["write-file!"](written, "hello"), [TRUE]);
      assert.equal(readFileSync(written, "utf8"), "hello");
      // Named at another engine path, the same directory is live there too.
      host.engine.mount(directory, "/elsewhere");
      writeFileSync(join(directory, "later.txt"), "later");
      assert.deepEqual(await host.fn["read-file!"]("/elsewhere/later.txt"), [G("later")]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("boots in a working directory of / with no mount of its own", () => {
    // A child process, since a working directory belongs to the process: it
    // starts at /, reads this package's manifest by its absolute path, and
    // mints a temporary directory inside the one TMP names, where a native
    // engine would write.
    const temporary = mkdtempSync(join(tmpdir(), "tsmetta-root-"));
    try {
      const index = new URL(`../src/index.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`, import.meta.url).href;
      const manifest = resolve("package.json");
      const program = `
        import { lib, metta } from ${JSON.stringify(index)};
        const m = await metta();
        m.import(lib.file);
        m.import(lib.system);
        const text = async (answers) => (await answers).map(String);
        const seen = {
          working: await text(m.fn.workingDirectory()),
          manifest: await text(m.fn.fileExists(${JSON.stringify(manifest)})),
          temporary: String(await m.fn["temp-dir!"]("root").one()),
        };
        m.dispose();
        process.stdout.write(JSON.stringify(seen));
      `;
      const seen = JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", program], {
          cwd: "/",
          env: { ...process.env, TMP: temporary },
          encoding: "utf8",
        }),
      ) as { working: string[]; manifest: string[]; temporary: string };
      assert.deepEqual(seen.working, ['"/"']);
      assert.deepEqual(seen.manifest, ["true"]);
      assert.ok(seen.temporary.startsWith(`"${temporary}/`), seen.temporary);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("gives every engine a temporary directory of its own, and removes it when the engine is disposed", async () => {
    // Every WebAssembly engine's process id is 42, so a temporary name
    // SWI-Prolog mints from it is unique only because each engine mints it in
    // a directory of its own: two engines asking for one name get two.
    const temporaryOf = (surface: MeTTa): string =>
      String(surface.engine.once("current_prolog_flag(tmp_dir, Directory)")["Directory"]);
    const minted = (surface: MeTTa): string =>
      String(surface.engine.once("tmp_file(twin, Name)")["Name"]);
    const other = await metta();
    const mine = temporaryOf(host);
    const theirs = temporaryOf(other);
    try {
      assert.notEqual(mine, theirs);
      assert.ok(existsSync(mine) && existsSync(theirs), `${mine} and ${theirs}`);
      assert.notEqual(minted(host), minted(other));
    } finally {
      other.dispose();
    }
    assert.equal(existsSync(theirs), false, `${theirs} outlived its engine`);
    assert.ok(existsSync(mine), `${mine} went with another engine`);
  });

  it("names a Windows path by its drive's mount", () => {
    assert.equal(enginePath("C:\\Users\\ada\\x.metta", "win32"), "/c/Users/ada/x.metta");
    assert.equal(enginePath("D:/data/y.pl", "win32"), "/d/data/y.pl");
    assert.equal(enginePath("\\\\server\\share\\z", "win32"), "\\\\server\\share\\z");
    assert.equal(enginePath("/home/ada/x.metta", "linux"), "/home/ada/x.metta");
  });
});
