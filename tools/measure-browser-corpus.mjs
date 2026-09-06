/**
 * Purpose: run every example the shell runner runs in the BROWSER build, in
 *   headless Chromium over HTTP, and print how many of them a reader can run in
 *   a page and why the rest cannot.
 *
 * Usage: node tools/measure-browser-corpus.mjs [--inferences <n>] [--slice <n>]
 *
 * This is the command behind "N of M runnable examples run in the browser",
 * which the documentation site, `llms.txt` and the CHANGELOG all state. It is a
 * measurement tool rather than a gate lane: it boots one engine per example,
 * takes minutes, and needs Chromium, which is what
 * `npx playwright install chromium` fetches.
 *
 * A FRESH engine per example, not a shared one, so an example that aborts the
 * WebAssembly module costs one row rather than every row after it. Sharing was
 * tried first: the 40 examples after the first aborting one all answered
 * `Unknown procedure: system:metta_node_do/2`, which is the corpse rather than
 * a result [measured 2026-09-07]. A page holds twenty of them, so a page that
 * crashes costs a slice and says which one.
 *
 * It refuses, naming `npm run build:browser`, when the build it measures is not
 * there, because a browser kit that is absent and one that runs nothing look
 * the same in a count.
 *
 * Guarantees:
 *   - the corpus is the one `test.sh` runs: every `.metta` under `examples/`
 *     outside a `_fixtures/` directory, less what
 *     `tests/data/example_skips.txt` names, so this and the gate cannot
 *     disagree about what an example is
 *     [source: test.sh, the find and the SKIPS read; commit=a8b50dae12518adb626bf2594258eeaaf4a7f76d]
 */

import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..", "..");

/** How much one example may spend before it is counted as too expensive. */
let budget = 20_000_000;
/** How many examples share one Chromium page, so a crashed page costs a slice. */
let slice = 20;
for (let at = 2; at < process.argv.length; at += 2) {
  const value = Number(process.argv[at + 1]);
  if (process.argv[at] === "--inferences") budget = value;
  else if (process.argv[at] === "--slice") slice = value;
  else {
    process.stderr.write(`measure-browser-corpus: no such option ${process.argv[at]}\n`);
    process.exit(2);
  }
}

if (!existsSync(join(root, "browser")) || !existsSync(join(root, "_runtime/runtime.json"))) {
  process.stderr.write("measure-browser-corpus: browser/ or _runtime/ is not built here.\n  npm run build:browser\n");
  process.exit(1);
}

/** Every `.metta` under a directory, less the `_fixtures/` trees. */
function walk(directory, into) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "_fixtures") walk(path, into);
    } else if (entry.name.endsWith(".metta")) into.push(path);
  }
  return into;
}

const skipped = new Set((await readFile(join(repo, "tests/data/example_skips.txt"), "utf8"))
  .split("\n").filter(line => line.trim() !== "" && !line.startsWith("#"))
  .map(line => line.split(/\s+/)[0]));
// Forward slashes whatever the platform joined with, because the skip file and
// every path this prints are the repository's own spelling.
const listed = walk(join(repo, "examples"), [])
  .map(path => relative(repo, path).replaceAll("\\", "/"))
  .sort();
const corpus = [];
for (const path of listed) {
  if (skipped.has(path)) continue;
  corpus.push([path, await readFile(join(repo, path), "utf8")]);
}

const server = createServer(async (request, response) => {
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>corpus</title><body>corpus");
    return;
  }
  const file = resolve(root, `.${path}`);
  if (!file.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file);
    const mime = { ".js": "text/javascript", ".json": "application/json", ".wasm": "application/wasm" };
    response.writeHead(200, { "content-type": mime[extname(file)] ?? "application/octet-stream" });
    response.end(bytes);
  } catch { response.writeHead(404).end("missing asset"); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const answers = [];
try {
  for (let at = 0; at < corpus.length; at += slice) {
    const page = await browser.newPage();
    const batch = corpus.slice(at, at + slice);
    try {
      await page.goto(origin);
      answers.push(...await page.evaluate(async ({ batch, budget }) => {
        const { metta } = await import("/browser/index.js");
        const said = [];
        for (const [path, source] of batch) {
          const startedBoot = performance.now();
          let m;
          try { m = await metta({ root: new URL("/_runtime/", location.href).href }); }
          catch (error) { said.push({ path, outcome: error.code ?? error.name, why: String(error.message).slice(0, 200) }); continue; }
          const bootMs = performance.now() - startedBoot;
          const started = performance.now();
          try {
            const bound = m.limits({ inferences: budget });
            try { m.run(source); said.push({ path, outcome: "ran", ms: performance.now() - started, bootMs }); }
            finally { bound.release(); }
          } catch (error) {
            said.push({ path, outcome: error.code ?? error.name, why: String(error.message).replace(/\s+/g, " ").slice(0, 200), ms: performance.now() - started, bootMs });
          }
          try { m.dispose(); } catch { /* an aborted module cannot be disposed */ }
        }
        return said;
      }, { batch, budget }));
    } catch (error) {
      process.stderr.write(`measure-browser-corpus: the page holding ${batch.length} example(s) from ${batch[0][0]} crashed: ${String(error).slice(0, 120)}\n`);
      for (const [path] of batch) {
        if (!answers.some(answer => answer.path === path)) answers.push({ path, outcome: "PageCrash", why: "the page crashed in this slice" });
      }
    } finally { await page.close(); }
  }
} finally {
  await browser.close();
  await new Promise(done => server.close(done));
}

const outcomes = new Map();
for (const answer of answers) outcomes.set(answer.outcome, (outcomes.get(answer.outcome) ?? 0) + 1);
const ran = answers.filter(answer => answer.outcome === "ran").sort((left, right) => left.ms - right.ms);
const boots = answers.filter(answer => answer.bootMs !== undefined).map(answer => answer.bootMs);
process.stdout.write(
  `measure-browser-corpus: ${String(ran.length)} of ${String(corpus.length)} runnable examples ` +
  `run in the browser build (${String(listed.length)} listed, ${String(skipped.size)} skipped), ` +
  `under a ${String(budget)} inference bound\n`);
for (const [outcome, count] of [...outcomes].sort((left, right) => right[1] - left[1])) {
  process.stdout.write(`  ${String(count).padStart(4)}  ${outcome}\n`);
}
if (ran.length > 0) {
  process.stdout.write(
    `  median run ${ran[Math.floor(ran.length / 2)].ms.toFixed(1)} ms; ` +
    `mean boot ${(boots.reduce((sum, one) => sum + one, 0) / boots.length).toFixed(0)} ms; ` +
    `loadavg ${(await readFile("/proc/loadavg", "utf8").catch(() => "unknown")).split(" ")[0]}\n`);
}
for (const answer of answers) {
  if (answer.outcome !== "ran") process.stdout.write(`  ${answer.path}\n      ${answer.outcome}: ${answer.why}\n`);
}
