/* Purpose: be the program the `node-dist` lane runs against the BUILT package,
 *   so `dist/` is proven current and working rather than assumed to be.
 *
 * Assumes: `npm run build:dist` has just run, and imports `../dist/index.js`
 *   the way the package's own `exports` map points a consumer at it. It does
 *   NOT import from `src/`, which is the whole point: every other lane in this
 *   seat runs `build/`, compiled from source by `npm test`, and none of them
 *   ever loads `dist/`.
 * Guarantees: exits 0 having evaluated one program through the built library,
 *   and exits nonzero naming what failed otherwise
 *   [tested: extensions/node/check.sh node-dist; commit=1c40a5f96c308941b4c0669594acb06403109751].
 *   It also resolves `metta-node/atom` and `metta-node/errors` through NODE'S
 *   OWN resolver, from a directory whose `node_modules` links to this package,
 *   which is the only way to exercise the `exports` map rather than a path
 *   this file happens to know.
 * Fails when: `dist/` was built from older sources than the ones beside it.
 *   That is not hypothetical: on 2026-08-31 `dist/` held the previous wire
 *   codec while the engine's bridge held the new one, so a consumer got
 *   `WireError: not a transport atom` and then an engine that answered nothing
 *   at all -- a decode ceiling that had just been fixed still looked broken,
 *   and the fix looked wrong.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { metta, S } from "../dist/index.js";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * What a consumer sees when it imports the engine-free subpaths.
 *
 * A CHILD process, because this one has already loaded the engine: a recorder
 * in here would see nothing resolved for a module already in the graph, and
 * the whole question is what the subpath pulls in on its own. The child
 * records every specifier its resolver is asked for.
 *
 * The measure is the `node:` builtins as much as swipl-wasm. Loading the
 * engine is LAZY even from the root, an `await import` inside src/wasm.ts, so
 * what a browser bundler actually trips over is the root's static reach into
 * `node:fs`, `node:path` and `node:url`. Measured 2026-09-05 through this same
 * recorder: importing `metta-node` asks for 166 specifiers, three of them
 * `node:` builtins; importing `metta-node/atom` asks for three, none of them.
 */
function engineFreeSubpaths() {
  // `ai-tmp/` is gitignored, so it exists only where somebody has already put
  // a scratch file in it. This read it and assumed it, so the lane passed in
  // the checkout its author worked in and failed with ENOENT on every fresh
  // clone and in CI. The seat's two other repository-local scratch sites
  // create the root first (test/coverage.test.ts packageTree, and
  // test/coverage-gaps.test.ts's manifest case), and this is that same line.
  const scratchRoot = join(packageRoot, "ai-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  const scratch = mkdtempSync(join(scratchRoot, "consumer-"));
  try {
    mkdirSync(join(scratch, "node_modules"));
    symlinkSync(packageRoot, join(scratch, "node_modules", "metta-node"), "dir");
    const probe = `
      import { registerHooks } from "node:module";
      const asked = [];
      registerHooks({ resolve(specifier, context, next) { asked.push(specifier); return next(specifier, context); } });
      const { expr, sym, G, float } = await import("metta-node/atom");
      const { MettaError } = await import("metta-node/errors");
      console.log(JSON.stringify({
        text: expr(sym("user"), G(42), float(1), G("ada")).text,
        code: new MettaError("refused").code,
        asked,
      }));
    `;
    return JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
        cwd: scratch,
        encoding: "utf8",
      }),
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const m = await metta();
try {
  const [answer] = await m.eval(S["+"](2, 3));
  if (String(answer) !== "5") {
    console.error(`the built package answered ${String(answer)}, wanted 5`);
    process.exitCode = 1;
  } else {
    // A term past the old host ceiling, because the built copy is exactly
    // where a stale one hides: the suite that proves the ceiling runs `build/`.
    const deep = m.parse("(f ".repeat(4096) + "1" + ")".repeat(4096));
    if (String(deep).length !== 4096 * 4 + 1) {
      console.error("the built package mis-read a term 4096 deep");
      process.exitCode = 1;
    } else {
      const subpaths = engineFreeSubpaths();
      const outside = subpaths.asked.filter(
        (specifier) => specifier.includes("swipl-wasm") || specifier.startsWith("node:"),
      );
      if (subpaths.text !== '(user 42 1.0 "ada")' || subpaths.code !== "ERR_METTA_ENGINE") {
        console.error(`the engine-free subpaths answered ${JSON.stringify(subpaths)}`);
        process.exitCode = 1;
      } else if (outside.length > 0) {
        console.error(`metta-node/atom reached ${JSON.stringify(outside)}`);
        process.exitCode = 1;
      } else {
        console.log(
          "node-dist: the built package boots, evaluates, reads deep, and " +
            "resolves the engine-free subpaths without loading swipl-wasm",
        );
      }
    }
  }
} finally {
  await m.close?.();
}
