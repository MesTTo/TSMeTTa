/**
 * Purpose: hold boot() to the engine's host check: the host this package
 *   carries passes it, and a host that does not declare every patch the engine
 *   requires is refused before the engine loads, in the engine's own words.
 * Assumes:
 *   - the checkout this suite reads, repoRoot, holds engine/host_check.pl and
 *     engine/host_patches.pl, which boot() mounts with the rest of engine/
 *   - npm's swipl-wasm, a devDependency and nothing else, is the stock host:
 *     SWI-Prolog's own WebAssembly build, whose home holds no declaration
 *     [tested: "refuses the stock npm swipl-wasm"; commit=b18f7d31d58691f97112d0de67b0136bfd8a3291]
 * Guarantees:
 *   - the host in _host/ boots and evaluates [tested: "boots on the host this
 *     package carries"; commit=b18f7d31d58691f97112d0de67b0136bfd8a3291]
 *   - a requirement the host does not declare refuses boot with EngineError
 *     naming the missing patch [tested: "refuses a host whose declaration
 *     lacks a patch the engine requires"; commit=b18f7d31d58691f97112d0de67b0136bfd8a3291]
 *   - the stock npm swipl-wasm, put where this package keeps its host, refuses
 *     boot with EngineError carrying the engine's sentence, through the same
 *     boot() a consumer calls [tested: "refuses the stock npm swipl-wasm";
 *     commit=b18f7d31d58691f97112d0de67b0136bfd8a3291]
 *   - a refusal writes nothing to the console [tested: both refusal cases]
 *   - license:licensed/2 answers, beyond SWI's own registrations, exactly the
 *     components of the THIRD-PARTY-NOTICES beside the host in _host/, which
 *     is the text the data image holds [tested 2026-09-28T14:00:32+10:00:
 *     "answers license/0 for every component the host's notices name",
 *     with build 12 vendored]
 * Owns resources: one scratch directory per case under build/, which the
 *   next build deletes and each case removes on the way out.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { MettaError, S, metta } from "../src/index.ts";
import { packageRoot, repoRoot } from "../src/platform.ts";

/** A scratch directory inside this package, so bare imports still find node_modules. */
function scratch(name: string): string {
  const parent = join(packageRoot, "build");
  mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, `${name}-`));
}

/**
 * Await a boot that must be refused, and return what reached the console.
 *
 * A refusal is raised, never also printed: the loader writes an exception that
 * escapes a query to the console, which is why the check crosses as data.
 */
async function refusedQuietly(booting: () => Promise<unknown>, check: (error: Error) => void): Promise<string[]> {
  const written: string[] = [];
  const { log, error } = console;
  console.log = (...parts: unknown[]) => written.push(parts.join(" "));
  console.error = (...parts: unknown[]) => written.push(parts.join(" "));
  try {
    await assert.rejects(booting, (refusal: unknown) => {
      assert.ok(refusal instanceof Error, String(refusal));
      check(refusal);
      return true;
    });
  } finally {
    console.log = log;
    console.error = error;
  }
  return written;
}

describe("the host boot() runs the engine on", () => {
  it("boots on the host this package carries", async () => {
    const m = await metta();
    try {
      const [answer] = await m.eval(S["+"](2, 3));
      assert.equal(String(answer), "5");
    } finally {
      m.dispose();
    }
  });

  it("answers license/0 for every component the host's notices name", async () => {
    // A component block opens where a line of 78 '=' is directly followed by
    // its `Component: ` line, the text tools/host-notices/notices.py writes
    // and reads back in components_of(), and the host build both packs at
    // /swipl and vendors beside it. Any other such line is a licence text's
    // own: LLVM's LICENSE.TXT divides its sections with eight, Emscripten's
    // LICENSE with three.
    const rule = "=".repeat(78);
    const lines = readFileSync(join(packageRoot, "_host", "THIRD-PARTY-NOTICES"), "utf8").split("\n");
    const named = lines
      .slice(1)
      .flatMap((line, index) =>
        lines[index] === rule && line.startsWith("Component: ") ? [line.slice("Component: ".length)] : [],
      );
    const m = await metta();
    try {
      const answer = m.engine.once(
        "findall(C, (license:licensed(I, C), \\+ clause(license:licensed(I, C), true)), Cs), " +
          "atomic_list_concat(Cs, '\\n', Text)",
      );
      assert.deepEqual(String(answer["Text"]).split("\n").sort(), [...named].sort());
    } finally {
      m.dispose();
    }
  });

  it("refuses a host whose declaration lacks a patch the engine requires", async () => {
    // A root whose engine requires one patch more than any host declares:
    // the real engine with one fact added to its requirement, which is what
    // a checkout whose patches moved on from the vendored host looks like.
    const root = scratch("planted-requirement");
    try {
      mkdirSync(join(root, "engine"));
      for (const entry of readdirSync(join(repoRoot, "engine"))) {
        if (entry === "host_patches.pl") continue;
        cpSync(join(repoRoot, "engine", entry), join(root, "engine", entry), { recursive: true });
      }
      writeFileSync(
        join(root, "engine", "host_patches.pl"),
        readFileSync(join(repoRoot, "engine", "host_patches.pl"), "utf8") +
          `host_patch('planted.patch', '${"0".repeat(64)}').\n`,
      );
      for (const tree of ["lib", "extensions"]) {
        if (existsSync(join(repoRoot, tree))) {
          symlinkSync(join(repoRoot, tree), join(root, tree), "dir");
        }
      }
      const written = await refusedQuietly(() => metta({ root }), (error) => {
        assert.ok(MettaError.is(error, "ERR_METTA_ENGINE"), String(error));
        assert.match(error.message, /^This SWI-Prolog does not carry every patch the MeTTa engine needs/);
        assert.match(error.message, /1 patch\(es\) missing:\s+planted\.patch/);
        assert.match(error.message, /Read from \/swipl\/metta-host\.pl/);
      });
      assert.deepEqual(written, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses the stock npm swipl-wasm", async (t) => {
    const stock = join(packageRoot, "node_modules", "swipl-wasm", "dist", "swipl");
    if (!existsSync(join(stock, "swipl-web.js"))) {
      t.skip("npm's swipl-wasm is not installed; `npm ci` installs it as a devDependency");
      return;
    }
    // This package, with the stock host where it keeps its own: the modules
    // this suite runs, beside the package.json and bridge.pl that make the
    // directory a package root, and _host/ holding swipl-wasm's three files.
    const modules = fileURLToPath(new URL("../src/", import.meta.url));
    const suffix = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
    const copy = scratch("stock-host");
    try {
      cpSync(modules, join(copy, "src"), { recursive: true });
      for (const name of ["package.json", "bridge.pl"]) {
        cpSync(join(packageRoot, name), join(copy, name));
      }
      mkdirSync(join(copy, "_host"));
      cpSync(join(stock, "swipl-web.js"), join(copy, "_host", "swipl-web.cjs"));
      for (const name of ["swipl-web.wasm", "swipl-web.data"]) {
        cpSync(join(stock, name), join(copy, "_host", name));
      }
      const entry = await import(pathToFileURL(join(copy, "src", `index${suffix}`)).href) as {
        metta: typeof metta;
        MettaError: typeof MettaError;
      };
      const written = await refusedQuietly(() => entry.metta({ root: repoRoot }), (error) => {
        assert.ok(entry.MettaError.is(error, "ERR_METTA_ENGINE"), String(error));
        assert.match(error.message, /^This SWI-Prolog does not carry every patch the MeTTa engine needs/);
        assert.match(error.message, /The home \/swipl has no metta-host\.pl/);
      });
      assert.deepEqual(written, []);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });
});
