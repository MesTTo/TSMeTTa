/* Purpose: run the examples lane over TSMeTTa-Examples, mounted at examples/:
 *   install this seat's own packed build as the corpus's tsmetta, build the
 *   lane and the corpus, lint and format-check them, run the lane's own tests
 *   and the README fence check, then run every program and every twin beside
 *   its MeTTa original (tools/examples/run.ts).
 *
 * Assumes: the seat is this script's parent directory, the corpus is mounted at
 *   its examples/ with the MeTTa corpus at examples/examples/, and both have
 *   their npm installs.
 * Guarantees:
 *   - it does not fetch. An unmounted corpus or a missing install is named with
 *     the command that supplies it, and the exit status is 125, the gate's word
 *     for a run that measured nothing.
 *   - every program imports this seat's own build: the seat packed as npm
 *     would publish it, `prepare` included, and unpacked where the corpus's own
 *     install put tsmetta, so a program, the side that reads its engine and the
 *     browser program's bundle all load one copy. Every dependency the pack
 *     declares must resolve from there, or the run stops naming it.
 *   - the lane is compiled beside the programs, into the corpus's
 *     node_modules/.cache/tsmetta-lane, so its own `tsmetta` is that copy too.
 *   - every step runs whatever an earlier one found, and the exit status is 1
 *     when any step failed, each named in the last lines printed.
 *   - its arguments pass through to run.ts: a path fragment selects programs,
 *     and --settle=<reason> declares each selected twin's DIVERGENCE.
 * Fails when: two runs share one mounted corpus at once, since both unpack
 *   over its tsmetta and compile into its dist/.
 * Owns resources: a scratch directory under this seat's ai-tmp/ holding the
 *   packed archive, removed however the run ends; the corpus's
 *   node_modules/tsmetta and node_modules/.cache/tsmetta-lane, rewritten by
 *   every run, whose verdicts/ it keeps.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const seat = fileURLToPath(new URL("../", import.meta.url));
const corpus = join(seat, "examples");
const lane = join(corpus, "node_modules", ".cache", "tsmetta-lane");
const tool = (root, name) => join(root, "node_modules", ".bin", name);

function unmeasured(message) {
  console.error(`note: ${message}`);
  process.exit(125);
}

if (!existsSync(join(corpus, "package.json"))) {
  unmeasured("examples/ is not mounted; `git submodule update --init --recursive examples` in extensions/node mounts it");
}
if (!existsSync(join(corpus, "examples", "README.md"))) {
  unmeasured("examples/examples/, the MeTTa corpus the twins mirror, is not mounted; `git -C examples submodule update --init` mounts it");
}
for (const name of ["tsc", "oxlint", "prettier"]) {
  if (!existsSync(tool(seat, name))) {
    unmeasured("extensions/node has no npm install; `npm ci` there fetches the tools this lane builds and checks with");
  }
}
if (!existsSync(tool(corpus, "tsc"))) {
  unmeasured("examples/ has no npm install; `npm ci --prefix examples` in extensions/node fetches the packages its programs import");
}

// The seat as a consumer installs it. `npm pack` runs `prepare`, which builds
// dist/, browser/ and _runtime/, exactly as tools/dist-consumer.mjs relies on.
const installed = join(corpus, "node_modules", "tsmetta");
mkdirSync(join(seat, "ai-tmp"), { recursive: true });
const scratch = mkdtempSync(join(seat, "ai-tmp", "examples-pack-"));
let build;
try {
  execFileSync("npm", ["pack", "--pack-destination", scratch], {
    cwd: seat,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const tarball = readdirSync(scratch).find((name) => name.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("npm pack wrote no tarball");
  // npm's own integrity string for the archive, which names the build a
  // refusal verdict belongs to.
  build = `sha512-${createHash("sha512").update(readFileSync(join(scratch, tarball))).digest("base64")}`;
  rmSync(installed, { recursive: true, force: true });
  mkdirSync(installed, { recursive: true });
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", installed, "--strip-components=1"]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const resolveFrom = createRequire(join(installed, "package.json"));
for (const dependency of Object.keys(manifest.dependencies ?? {})) {
  try {
    resolveFrom.resolve(`${dependency}/package.json`);
  } catch {
    console.error(`examples: tsmetta depends on ${dependency}, which nothing installed beside it resolves`);
    process.exit(1);
  }
}
console.log(`examples: the corpus imports this seat's build, ${build}`);

const failed = [];
/** Run one step with `cwd` as its working directory, and keep its name when it fails. */
function step(name, command, args, cwd, env = {}) {
  console.log(`examples: ${name}`);
  const { status, error } = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (error !== undefined || status !== 0) {
    failed.push(`${name} (${error === undefined ? `exit ${String(status)}` : error.message})`);
  }
}

// The lane's last build is replaced; the refusal verdicts it keeps stay.
for (const entry of existsSync(lane) ? readdirSync(lane) : []) {
  if (entry !== "verdicts") rmSync(join(lane, entry), { recursive: true, force: true });
}
step("the lane compiles", tool(seat, "tsc"), ["-p", "tsconfig.examples.json"], seat);
mkdirSync(lane, { recursive: true });
// Under node_modules no package.json of the corpus scopes the lane, so it
// names its own module type; and declare.ts formats a twin with this config.
writeFileSync(join(lane, "package.json"), '{ "type": "module" }\n');
cpSync(join(seat, "tools", "examples", "prettierrc.json"), join(lane, "prettierrc.json"));

step("the corpus compiles against this build", tool(corpus, "tsc"), ["-p", "."], corpus);
// The corpus's programs, its README and the files at its root, named rather
// than globbed, so the MeTTa corpus at examples/examples/ and every build
// product stay out without an ignore file of this seat's own.
const chapters = readdirSync(corpus).filter((entry) => /^ch\d\d-/.test(entry));
const roots = ["README.md", "package.json", "package-lock.json", "tsconfig.json", "residue.json"];
const lint = ["-c", join(seat, "tools", "examples", "oxlintrc.json"), "--type-aware"];
step("the corpus lints", tool(seat, "oxlint"), [...lint, ...chapters], corpus);
step("the lane lints", tool(seat, "oxlint"), [...lint, "--tsconfig", "tsconfig.examples.json", "tools/examples"], seat);
step(
  "the corpus and the lane are formatted",
  tool(seat, "prettier"),
  ["--check", "--config", join(seat, "tools", "examples", "prettierrc.json"), ...chapters, ...roots, join(seat, "tools", "examples")],
  corpus,
);
step(
  "the lane's own tests pass",
  process.execPath,
  ["--test", ...readdirSync(lane).filter((name) => name.endsWith(".test.js")).map((name) => join(lane, name))],
  corpus,
);
step("the README shows the programs' own lines", process.execPath, [join(lane, "fences.js"), "README.md"], corpus);
step(
  "every program runs, and every twin agrees with its original",
  process.execPath,
  [join(lane, "run.js"), ...process.argv.slice(2)],
  corpus,
  { TSMETTA_BUILD: build },
);

if (failed.length > 0) {
  console.error(`examples: ${String(failed.length)} step(s) failed:`);
  for (const name of failed) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("examples: every step passed");
