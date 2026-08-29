/**
 * Purpose: the command line — every subcommand, its exit status, and what it
 *   writes.
 * Guarantees:
 *   - `--version` and `--help` boot nothing, so they answer on a machine where
 *     the engine cannot start
 *   - every command exits nonzero when it fails, so each one is scriptable
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it } from "node:test";

import { main } from "../src/cli.ts";

/**
 * Run one command line, collecting what it wrote.
 *
 * Through the injected sink rather than by replacing `process.stdout.write`:
 * the test runner reports on that same stream, and replacing it swallows the
 * whole run [measured: one test reported where seven ran].
 */
async function run(...argv: readonly string[]): Promise<{ status: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const status = await main(argv, {
    write: (text: string): void => {
      out += text;
    },
    fail: (text: string): void => {
      err += text;
    },
  });
  return { status, out, err };
}

describe("the command line", () => {
  it("answers its version and its usage without booting", async () => {
    const version = await run("--version");
    assert.equal(version.status, 0);
    assert.match(version.out, /^metta-node \d+\.\d+\.\d+/);

    const help = await run("--help");
    assert.equal(help.status, 0);
    assert.match(help.out, /usage: metta-node <command>/);

    // No command at all is a usage error, which is a nonzero status.
    const bare = await run();
    assert.equal(bare.status, 1);
  });

  it("reduces one term", async () => {
    const answered = await run("eval", "(+ 1 2)");
    assert.equal(answered.status, 0);
    assert.equal(answered.out.trim(), "3");
  });

  it("runs a file and prints each answer group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "metta-cli-"));
    const file = join(directory, "program.metta");
    writeFileSync(file, "(= (twice $x) (* 2 $x))\n!(twice 21)\n!(twice 1)\n");
    const answered = await run("run", file);
    assert.equal(answered.status, 0);
    assert.equal(answered.out.trim(), "[42]\n[2]");
    assert.equal((await run("run")).status, 1, "run needs a file");
  });

  it("prints each top-level form and the kind the reader gave it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "metta-cli-"));
    const file = join(directory, "forms.metta");
    writeFileSync(file, "(= (f $x) $x)\n!(f 1)\n");
    const answered = await run("forms", file);
    assert.equal(answered.status, 0);
    assert.match(answered.out, /^function\t\(= \(f \$x\) \$x\)$/m);
    assert.match(answered.out, /^runnable\t\(f 1\)$/m);
  });

  it("explains why an answer holds, and refuses when there is no proof", async () => {
    const proved = await run("why", "(+ 1 2)");
    assert.equal(proved.status, 0);
    assert.match(proved.out, /\(\+ 1 2\) = 3/);

    const absent = await run("why", "(nothing-defines-this 1)");
    assert.equal(absent.status, 1);
    assert.match(absent.err, /no proof/);
  });

  it("refuses a name it has no documentation for", async () => {
    const absent = await run("doc", "nothing-documents-this");
    assert.equal(absent.status, 1);
    assert.match(absent.err, /no documentation/);
  });

  it("names the remedy for a command it does not have", async () => {
    const wrong = await run("serve");
    assert.equal(wrong.status, 1);
    assert.match(wrong.err, /no such command serve/);
    assert.match(wrong.err, /usage: metta-node/);
  });

  it("runs as a process, with the exit status a shell reads", () => {
    // The injected sink above tests the commands; this tests the ENTRY POINT,
    // which is the part a `bin` field points at and a shell actually invokes.
    const here = fileURLToPath(import.meta.url);
    const command = here.replace(/test[/\\]cli\.test\.(ts|js)$/, (matched) =>
      matched.endsWith(".ts") ? "src/cli.ts" : "src/cli.js",
    );
    const answered = spawnSync(process.execPath, [command, "eval", "(+ 2 3)"], {
      encoding: "utf8",
    });
    assert.equal(answered.status, 0, answered.stderr);
    assert.equal(answered.stdout.trim(), "5");

    const refused = spawnSync(process.execPath, [command, "serve"], { encoding: "utf8" });
    assert.equal(refused.status, 1);
  });
});
