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
 *   [tested: extensions/node/check.sh node-dist; commit=WORKTREE].
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

import { metta, S } from "../dist/index.js";

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
      console.log("node-dist: the built package boots, evaluates and reads deep");
    }
  }
} finally {
  await m.close?.();
}
