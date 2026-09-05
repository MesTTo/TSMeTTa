/**
 * Purpose: copy the engine tree into this package before it is packed, so an
 *   installed copy carries the engine it mounts.
 *
 * `files` in package.json cannot name a path outside the package directory,
 * and the engine lives at the repository root while this seat lives at
 * `extensions/node/`. So the tarball gets its own copy under `_runtime/`,
 * which src/engine.ts prefers whenever it exists. Without it a published
 * package holds the bridge and not the engine: measured 2026-08-29, a fresh
 * `npm install` on a machine outside any checkout booted into
 * `scandir '<consumer project>\engine'`, because two levels above an
 * installed package is the consumer's own project.
 *
 * Written in Node rather than as a shell line because `npm pack` runs on
 * whatever machine publishes, Windows included.
 *
 * Guarantees:
 *   - `--clean` removes exactly what a bundling run wrote, so a checkout is
 *     left as it was found and `git status` stays quiet after a pack
 *   - build products are excluded by extension: a shipped `.qlf` shadows the
 *     source it was built from and ties the package to one SWI version, and a
 *     host `.so` is meaningless to a WebAssembly engine
 *   - runtime.json carries source text and extension metadata, and wasm/
 *     carries the matching swipl-wasm browser assets
 *     [source: extensions/node/tools/bundle-runtime.mjs:collect; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(PACKAGE, "..", "..");
const BUNDLE = join(PACKAGE, "_runtime");
const TREES = ["engine", "lib"];

// The same exclusions MANIFEST.in states for the Python seat, for the same
// reasons, plus the caches a working tree accumulates.
const SKIP = new Set([".qlf", ".so", ".o", ".pyc", ".qlf-stamp"]);
const SKIP_DIRS = new Set(["__pycache__", "node_modules", "target"]);

function wanted(source) {
  const name = source.split(/[\\/]/).pop() ?? "";
  if (SKIP_DIRS.has(name)) return false;
  const dot = name.lastIndexOf(".");
  return dot < 0 || !SKIP.has(name.slice(dot));
}

if (process.argv.includes("--clean")) {
  rmSync(BUNDLE, { recursive: true, force: true });
  process.exit(0);
}

rmSync(BUNDLE, { recursive: true, force: true });
for (const tree of TREES) {
  const from = join(REPO, tree);
  if (!existsSync(from)) {
    console.error(`bundle-runtime: ${from} is absent; this must run in a checkout`);
    process.exit(1);
  }
  cpSync(from, join(BUNDLE, tree), { recursive: true, filter: wanted });
}
const controls = join(REPO, "extensions");
for (const seat of readdirSync(controls)) {
  const control = join(controls, seat, "extension.pl");
  if (!existsSync(control)) continue;
  const destination = join(BUNDLE, "extensions", seat);
  mkdirSync(destination, { recursive: true });
  cpSync(control, join(destination, "extension.pl"));
}
cpSync(join(PACKAGE, "bridge.pl"), join(BUNDLE, "bridge.pl"));

// A text snapshot avoids requiring browser directory listings or native caches.
const files = [];
function collect(directory, prefix = "") {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = `${prefix}${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path, `${relative}/`);
    else if (/\.(?:pl|metta)$/.test(entry.name)) {
      files.push({ path: relative, text: readFileSync(path, "utf8") });
    }
  }
}
collect(BUNDLE);
writeFileSync(join(BUNDLE, "runtime.json"), JSON.stringify({ version: 1, files }));

const wasm = join(BUNDLE, "wasm");
mkdirSync(wasm, { recursive: true });
const swipl = dirname(fileURLToPath(import.meta.resolve("swipl-wasm/dist/swipl/swipl-web.js")));
for (const name of ["swipl-web.wasm", "swipl-web.data"]) {
  cpSync(join(swipl, name), join(wasm, name));
}
console.log(`bundle-runtime: ${TREES.join(", ")}, extension controls, bridge and browser assets copied into _runtime/`);
