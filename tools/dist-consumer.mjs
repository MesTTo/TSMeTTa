/* Purpose: be the program the `node-dist` lane runs against the PACKED
 *   package, so what a consumer installs is proven to boot rather than
 *   assumed to.
 *
 * Assumes: `npm pack` can run here, which means the devDependencies are
 *   installed: packing runs this package's `prepare`, and that is what builds
 *   `dist/`, `browser/` and `_runtime/`.
 * Guarantees:
 *   - nested worktrees resolve the unpacked consumer package
 *     [tested: node tools/dist-consumer.mjs; commit=f43f0466e4ed256f599e6aa56eaa7ed92a9249d9].
 *   - exits 0 having evaluated one program through the built library, reached
 *     from a directory that is NOT a checkout, and exits nonzero naming what
 *     failed otherwise [tested: extensions/node/check.sh node-dist]
 *   - the packed tree carries the WebAssembly SWI-Prolog it boots on, in
 *     `_host/`, and boots with no other SWI installed: only `acorn` is linked
 *     into the consumer's `node_modules`, so a package still reaching for
 *     npm's `swipl-wasm` fails here rather than on a consumer's machine
 *     [tested: extensions/node/check.sh node-dist]
 *   - the packed tree carries the engine and the browser build. A `file:`
 *     install of the DIRECTORY carried neither, because npm's directory
 *     fetcher runs `prepare` and no other script and both were made by
 *     `prepack`: 165 of 300 files arrived and the boot searched the
 *     CONSUMER's project for `engine/`
 *     [measured 2026-09-07; fixture=an `npm install file:` of the seat
 *     directory into a project outside the checkout]
 *   - `tsmetta/atom` and `tsmetta/errors` resolve through NODE'S OWN
 *     resolver from a directory whose `node_modules` holds this package,
 *     which is the only way to exercise the `exports` map rather than a path
 *     this file happens to know
 *   - the packed tarball carries THIRD-PARTY-NOTICES beside every copy of the
 *     host's binaries, the glue's bundled copy in browser/ included:
 *     tests/checks/check_third_party_notices.py runs on the tarball itself,
 *     with the interpreter tools/select-python.sh chooses for every runner
 *     here, and a finding stops the lane before anything boots
 *     [tested 2026-09-28T14:00:02+10:00: sh tools/check.sh node-dist,
 *     with build 12 vendored]
 *   - the packed package parses HTML with lib_markup's own HTML5 DTD, which
 *     the WebAssembly host's data image does not carry: the DTD is in the
 *     packed _runtime/lib, runtime.json names it for the browser host, and
 *     the consumer's markup-parse-html closes an omitted end tag through it
 *     [tested 2026-09-28T13:36:09+10:00: sh tools/check.sh node-dist, with
 *     build 12 vendored]
 *   - the packed host's platform census, as its own engine reads it, is the
 *     one tools/host-capabilities.json declares for a WebAssembly host: every
 *     capability present but those it lacks by design, each named with its
 *     reason there. tests/checks/check_host_capabilities.py, the check
 *     assemble.sh runs on every Linux wheel, compares the two and names what
 *     differs; it loads no library here, since no Python runs beside this
 *     host [tested 2026-09-28T15:30:27+10:00: that check's --census over
 *     tsmetta 0.0.1-alpha.2's census read by m.engine.capabilities(), 21
 *     capabilities parsed and its one finding the isub row alpha.2's engine
 *     predates]
 *   - the packed _runtime/ holds, under engine/ and lib/, only files git
 *     tracks at the same paths, lib's submodule included, and beside them
 *     only what tools/bundle-runtime.mjs writes: read from the tarball as
 *     unpacked, so an untracked path fails the lane whatever let it into the
 *     pack, as six .native/build.lock files from under lib reached tsmetta
 *     0.0.1-alpha.2 [tested 2026-09-30T12:00:13+10:00: sh tools/check.sh node-dist]
 * Fails when: `dist/` was built from older sources than the ones beside it.
 *   That is not hypothetical: on 2026-08-31 `dist/` held the previous wire
 *   codec while the engine's bridge held the new one, so a consumer got
 *   `WireError: not a transport atom` and then an engine that answered
 *   nothing at all -- a decode ceiling that had just been fixed still looked
 *   broken, and the fix looked wrong.
 * Owns resources: one scratch directory under the REPOSITORY's ai-tmp/, not
 *   this package's, holding the tarball and the unpacked copy, removed on the
 *   way out however the run ends.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = join(packageRoot, "..", "..");

/**
 * What a consumer's `npm install` puts on disk, unpacked where nothing
 * encloses it.
 *
 * `npm pack` rather than `npm install file:` because a gate does not reach the
 * network and installing would resolve this package's dependency from the
 * registry. It is the same list either way: npm's directory fetcher packs
 * a `file:` dependency through the very `npm-packlist` that `npm pack` calls
 * [source: pacote lib/dir.js, `packlist(this.tree, ...)`]. Packing also runs
 * `prepare`, which is the hook that makes `_runtime/` and `browser/` and the
 * one a directory install runs, so this proves the chain a consumer follows.
 *
 * `node_modules/tsmetta` rather than a symlink to the checkout: the two
 * levels above an installed package decide whether the engine is read from an
 * enclosing tree or from the copy inside the package, and a link back into
 * the checkout would answer that question with the checkout every time.
 */
function unpack(scratch) {
  const installed = join(scratch, "node_modules", "tsmetta");
  mkdirSync(installed, { recursive: true });
  try {
    execFileSync("npm", ["pack", "--pack-destination", scratch], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    console.error(`node-dist: npm pack failed\n${String(error.stderr ?? error)}`);
    process.exit(1);
  }
  const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) {
    console.error("node-dist: npm pack wrote no tarball");
    process.exit(1);
  }
  try {
    execFileSync("sh", ["-c",
      '. "$1/tools/select-python.sh" && [ -n "$PY" ] && exec "$PY" "$1/tests/checks/check_third_party_notices.py" "$2"',
      "sh", repositoryRoot, join(scratch, tarball)],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, METTA_ROOT: repositoryRoot } });
  } catch {
    console.error("node-dist: the packed tarball does not carry the notices of the host it ships, above");
    process.exit(1);
  }
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", installed, "--strip-components=1"]);
  for (const dependency of ["acorn"]) {
    symlinkSync(
      join(packageRoot, "node_modules", dependency),
      join(scratch, "node_modules", dependency),
      "dir",
    );
  }
  return installed;
}

// What tools/bundle-runtime.mjs writes into _runtime/ beside engine/ and lib/.
const BUNDLED = new Set(["bridge.pl", "extensions", "runtime.json", "wasm"]);

/**
 * Every file of the packed _runtime/ that is not what the package ships there:
 * under engine/ and lib/, a file git does not track at that path, and beside
 * them, an entry the bundler does not write.
 */
function untrackedInPack(installed) {
  const tracked = new Set(execFileSync("git",
    ["-C", repositoryRoot, "ls-files", "-z", "--recurse-submodules", "--", "engine", "lib"],
    { encoding: "utf8", maxBuffer: 1 << 26 }).split("\0").filter(Boolean));
  const runtime = join(installed, "_runtime");
  const found = [];
  const walk = (relative) => {
    for (const entry of readdirSync(join(runtime, relative), { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (!tracked.has(path)) found.push(`_runtime/${path}`);
    }
  };
  for (const entry of readdirSync(runtime)) {
    if (entry === "engine" || entry === "lib") walk(entry);
    else if (!BUNDLED.has(entry)) found.push(`_runtime/${entry}`);
  }
  return found;
}

/**
 * Whether the packed host's platform census is the one declared for a
 * WebAssembly host, by the repository's check, which prints what differs.
 */
function capabilitiesHold(census, scratch) {
  const file = join(scratch, "census.json");
  writeFileSync(file, JSON.stringify(census));
  try {
    execFileSync("sh", ["-c",
      '. "$1/tools/select-python.sh" && [ -n "$PY" ] && exec "$PY" "$1/tests/checks/check_host_capabilities.py" --kind webassembly --census "$2"',
      "sh", repositoryRoot, file],
      { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, METTA_ROOT: repositoryRoot } });
    return true;
  } catch {
    return false;
  }
}

/**
 * The consumer program, run from the scratch directory as a child process.
 *
 * A CHILD because the resolver question is what this proves: the specifiers
 * are bare names, so the `exports` map and the unpacked `node_modules` decide
 * what they reach, and a module already in this process's graph would be
 * resolved for free. The recorder counts what the engine-free subpaths ask
 * for. Measured 2026-09-05 through it: importing `tsmetta` asks for 166
 * specifiers, three of them `node:` builtins; importing `tsmetta/atom`
 * asks for three, none of them.
 */
const consumer = `
  import { registerHooks } from "node:module";
  const asked = [];
  registerHooks({ resolve(specifier, context, next) { asked.push(specifier); return next(specifier, context); } });
  const { expr, sym, G, float } = await import("tsmetta/atom");
  const { MettaError } = await import("tsmetta/errors");
  const atoms = {
    text: expr(sym("user"), G(42), float(1), G("ada")).text,
    code: new MettaError("refused").code,
    asked: [...asked],
  };
  const { metta, S, repoRoot } = await import("tsmetta");
  const m = await metta();
  try {
    const [answer] = await m.eval(S["+"](2, 3));
    // A term past the old host ceiling, because the built copy is exactly
    // where a stale one hides: the suite that proves the ceiling runs build/.
    const deep = m.parse("(f ".repeat(4096) + "1" + ")".repeat(4096));
    // HTML through the library's own DTD: two li elements, the first closed by
    // the second as the DTD's omitted end tag says.
    const { lib } = await import("tsmetta");
    m.import(lib.markup);
    const [html] = await m.fn.markupParseHtml("<ul><li>a<li>b</ul>");
    console.log(JSON.stringify({ ...atoms, answer: String(answer), deep: String(deep).length, repoRoot,
                                 html: String(html), census: m.engine.capabilities() }));
  } finally { await m.close?.(); }
`;

// OUTSIDE this package, in the repository's own scratch directory. Node's
// ESM resolver lets a package import itself by name wherever a `package.json`
// with an `exports` map encloses the importer, and self-reference beats the
// `node_modules` lookup: a scratch directory under `extensions/node/ai-tmp/`
// resolved `tsmetta` straight back to the checkout, so the unpacked copy
// beside it was never loaded and this lane read the tree it was meant to be
// standing outside of [measured 2026-09-07: import.meta.resolve answered
// extensions/node/dist/index.js from a scratch whose own node_modules held
// the unpacked package].
const scratchRoot = join(packageRoot, "..", "..", "ai-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "packed-"));
try {
  // A package scope also isolates nested battery worktrees from self-reference.
  writeFileSync(join(scratch, "package.json"), JSON.stringify({name: "packed-consumer", private: true, type: "module"}));
  const installed = unpack(scratch);

  // The engine and the browser build, by name. Both are gitignored build
  // products listed in `files`, and both were absent from a directory install
  // for as long as `prepack` was the only thing that made them.
  const missing = [
    "_host/swipl-web.cjs",
    "_host/swipl-web.wasm",
    "_host/swipl-web.data",
    "_host/LICENSE",
    "_runtime/engine/metta.pl",
    "_runtime/engine/host_check.pl",
    "_runtime/lib/lib_markup/DTD/HTML5.dtd",
    "_runtime/runtime.json",
    "_runtime/wasm/swipl-web.wasm",
    "browser/index.js",
    "dist/index.js",
    "bridge.pl",
  ].filter((path) => !existsSync(join(installed, path)));
  if (missing.length > 0) {
    console.error(
      `node-dist: the packed package is missing ${JSON.stringify(missing)}; ` +
        "`npm run prepare` is what builds them and `npm pack` is what runs it",
    );
    process.exit(1);
  }
  // The browser host mounts only what runtime.json names.
  const manifest = JSON.parse(readFileSync(join(installed, "_runtime/runtime.json"), "utf8"));
  if (!manifest.files.some((file) => file.path === "lib/lib_markup/DTD/HTML5.dtd")) {
    console.error("node-dist: runtime.json does not carry lib/lib_markup/DTD/HTML5.dtd, so the browser host cannot parse HTML");
    process.exit(1);
  }
  const untracked = untrackedInPack(installed);
  if (untracked.length > 0) {
    console.error(`node-dist: the packed _runtime/ holds ${untracked.length} file(s) the package does not ship there, ` +
      `such as ${JSON.stringify(untracked.slice(0, 5))}: under engine/ and lib/ only what git tracks, and beside ` +
      "them only what tools/bundle-runtime.mjs writes");
    process.exit(1);
  }

  const seen = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", consumer], {
      cwd: scratch,
      encoding: "utf8",
    }),
  );
  const outside = seen.asked.filter(
    (specifier) => specifier.includes("swipl-web") || specifier.startsWith("node:"),
  );
  if (seen.answer !== "5") {
    console.error(`the packed package answered ${seen.answer}, wanted 5`);
    process.exitCode = 1;
  } else if (seen.deep !== 4096 * 4 + 1) {
    console.error(`the packed package mis-read a term 4096 deep: ${String(seen.deep)}`);
    process.exitCode = 1;
  } else if (seen.text !== '(user 42 1.0 "ada")' || seen.code !== "ERR_METTA_ENGINE") {
    console.error(`the engine-free subpaths answered ${JSON.stringify(seen)}`);
    process.exitCode = 1;
  } else if (outside.length > 0) {
    console.error(`tsmetta/atom reached ${JSON.stringify(outside)}`);
    process.exitCode = 1;
  } else if (!seen.repoRoot.endsWith(`${join("tsmetta", "_runtime")}`)) {
    console.error(`the packed package read its engine from ${seen.repoRoot}, not from its own copy`);
    process.exitCode = 1;
  } else if (seen.html !== '(element ul () ((element li () ("a")) (element li () ("b"))))') {
    console.error(`the packed package parsed <ul><li>a<li>b</ul> as ${seen.html}`);
    process.exitCode = 1;
  } else if (!capabilitiesHold(seen.census, scratch)) {
    console.error("node-dist: the packed host's platform capabilities are not the WebAssembly host's declared set, above");
    process.exitCode = 1;
  } else {
    console.log(
      "node-dist: the packed package carries its engine, boots outside any " +
        "checkout, evaluates, reads deep, parses HTML with lib_markup's own " +
        "DTD, has every platform capability a WebAssembly host is declared " +
        "to, and resolves the engine-free subpaths without loading the " +
        "WebAssembly host",
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
