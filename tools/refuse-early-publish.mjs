/**
 * Purpose: refuse `npm publish` while this package is still marked private, in
 *   a check this repository owns and can test.
 *
 * npm is documented to refuse a package carrying `"private": true`, and that is
 * almost certainly what a real publish does. What is NOT true is that you can
 * demonstrate it: measured 2026-08-29, `npm publish --dry-run` on a package
 * with `"private": true` prints `Publishing to https://registry.npmjs.org/`
 * and lists the tarball, because the dry run simulates the PACK and skips the
 * preflight. So the only way to see the guard work is to publish for real,
 * which is not a test anyone can run twice.
 *
 * This is that guard, as a `prepublishOnly` hook, which npm runs on `publish`
 * and not on `pack` or `install`. A nonzero exit stops the publish. It keys off
 * the same `private` flag, so it needs no separate maintenance: the day that
 * line comes out of package.json, this stops refusing, and until then the
 * refusal is one this repository can run on demand.
 *
 * Guarantees:
 *   - exits nonzero while package.json carries a truthy `private`
 *   - exits zero once it does not, so it is not a second thing to remember
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const manifest = JSON.parse(
  readFileSync(
    join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json"),
    "utf8",
  ),
);

if (manifest.private) {
  console.error(
    `refusing to publish ${manifest.name}: package.json still carries ` +
      `"private": true.\n\n` +
      `That flag is this repository's pre-release guard, not a decision about ` +
      `the registry.\nEverything here goes public together on the day the ` +
      `GitHub repository does.\nTo publish, remove the "private" line and run ` +
      `this again.`,
  );
  process.exit(1);
}
