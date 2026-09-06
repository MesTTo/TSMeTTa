/* Purpose: be the program the `node-dist` lane runs against the PACKED
 *   package, so what a consumer installs is proven to boot rather than
 *   assumed to.
 *
 * Assumes: `npm pack` can run here, which means the devDependencies are
 *   installed: packing runs this package's `prepare`, and that is what builds
 *   `dist/`, `browser/` and `_runtime/`.
 * Guarantees:
 *   - exits 0 having evaluated one program through the built library, reached
 *     from a directory that is NOT a checkout, and exits nonzero naming what
 *     failed otherwise [tested: extensions/node/check.sh node-dist]
 *   - the packed tree carries the engine and the browser build. A `file:`
 *     install of the DIRECTORY carried neither, because npm's directory
 *     fetcher runs `prepare` and no other script and both were made by
 *     `prepack`: 165 of 300 files arrived and the boot searched the
 *     CONSUMER's project for `engine/`
 *     [measured 2026-09-07; fixture=ai-tmp/consumer-links]
 *   - `metta-node/atom` and `metta-node/errors` resolve through NODE'S OWN
 *     resolver from a directory whose `node_modules` holds this package,
 *     which is the only way to exercise the `exports` map rather than a path
 *     this file happens to know
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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * What a consumer's `npm install` puts on disk, unpacked where nothing
 * encloses it.
 *
 * `npm pack` rather than `npm install file:` because a gate does not reach the
 * network and installing would resolve this package's two dependencies from
 * the registry. It is the same list either way: npm's directory fetcher packs
 * a `file:` dependency through the very `npm-packlist` that `npm pack` calls
 * [source: pacote lib/dir.js, `packlist(this.tree, ...)`]. Packing also runs
 * `prepare`, which is the hook that makes `_runtime/` and `browser/` and the
 * one a directory install runs, so this proves the chain a consumer follows.
 *
 * `node_modules/metta-node` rather than a symlink to the checkout: the two
 * levels above an installed package decide whether the engine is read from an
 * enclosing tree or from the copy inside the package, and a link back into
 * the checkout would answer that question with the checkout every time.
 */
function unpack(scratch) {
  const installed = join(scratch, "node_modules", "metta-node");
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
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", installed, "--strip-components=1"]);
  for (const dependency of ["acorn", "swipl-wasm"]) {
    symlinkSync(
      join(packageRoot, "node_modules", dependency),
      join(scratch, "node_modules", dependency),
      "dir",
    );
  }
  return installed;
}

/**
 * The consumer program, run from the scratch directory as a child process.
 *
 * A CHILD because the resolver question is what this proves: the specifiers
 * are bare names, so the `exports` map and the unpacked `node_modules` decide
 * what they reach, and a module already in this process's graph would be
 * resolved for free. The recorder counts what the engine-free subpaths ask
 * for. Measured 2026-09-05 through it: importing `metta-node` asks for 166
 * specifiers, three of them `node:` builtins; importing `metta-node/atom`
 * asks for three, none of them.
 */
const consumer = `
  import { registerHooks } from "node:module";
  const asked = [];
  registerHooks({ resolve(specifier, context, next) { asked.push(specifier); return next(specifier, context); } });
  const { expr, sym, G, float } = await import("metta-node/atom");
  const { MettaError } = await import("metta-node/errors");
  const atoms = {
    text: expr(sym("user"), G(42), float(1), G("ada")).text,
    code: new MettaError("refused").code,
    asked: [...asked],
  };
  const { metta, S, repoRoot } = await import("metta-node");
  const m = await metta();
  try {
    const [answer] = await m.eval(S["+"](2, 3));
    // A term past the old host ceiling, because the built copy is exactly
    // where a stale one hides: the suite that proves the ceiling runs build/.
    const deep = m.parse("(f ".repeat(4096) + "1" + ")".repeat(4096));
    console.log(JSON.stringify({ ...atoms, answer: String(answer), deep: String(deep).length, repoRoot }));
  } finally { await m.close?.(); }
`;

// OUTSIDE this package, in the repository's own scratch directory. Node's
// ESM resolver lets a package import itself by name wherever a `package.json`
// with an `exports` map encloses the importer, and self-reference beats the
// `node_modules` lookup: a scratch directory under `extensions/node/ai-tmp/`
// resolved `metta-node` straight back to the checkout, so the unpacked copy
// beside it was never loaded and this lane read the tree it was meant to be
// standing outside of [measured 2026-09-07: import.meta.resolve answered
// extensions/node/dist/index.js from a scratch whose own node_modules held
// the unpacked package].
const scratchRoot = join(packageRoot, "..", "..", "ai-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(join(scratchRoot, "packed-"));
try {
  const installed = unpack(scratch);

  // The engine and the browser build, by name. Both are gitignored build
  // products listed in `files`, and both were absent from a directory install
  // for as long as `prepack` was the only thing that made them.
  const missing = [
    "_runtime/engine/metta.pl",
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

  const seen = JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "-e", consumer], {
      cwd: scratch,
      encoding: "utf8",
    }),
  );
  const outside = seen.asked.filter(
    (specifier) => specifier.includes("swipl-wasm") || specifier.startsWith("node:"),
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
    console.error(`metta-node/atom reached ${JSON.stringify(outside)}`);
    process.exitCode = 1;
  } else if (!seen.repoRoot.endsWith(`${join("metta-node", "_runtime")}`)) {
    console.error(`the packed package read its engine from ${seen.repoRoot}, not from its own copy`);
    process.exitCode = 1;
  } else {
    console.log(
      "node-dist: the packed package carries its engine, boots outside any " +
        "checkout, evaluates, reads deep, and resolves the engine-free " +
        "subpaths without loading swipl-wasm",
    );
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
