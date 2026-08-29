#!/usr/bin/env node
/**
 * Purpose: the command line. Run files, reduce one term, read a name's
 *   documentation, explain an answer, and an interactive loop.
 * Assumes:
 *   - the engine is this package's own, booted in process, so the command
 *     needs no `swipl` on `PATH` and no Python
 * Guarantees:
 *   - every subcommand exits NONZERO on failure, so each one is scriptable
 *   - `--version` and `--help` boot nothing at all, which is what makes them
 *     safe to run on a machine where the engine cannot start
 *   - what a program printed reaches the terminal, and nothing this package
 *     does prints beside it
 * Decides: the subcommand surface is this binding's, not the Prolog
 *   launcher's. `serve`, `boot` and `lint` are absent because this package
 *   carries no HTTP server, no manifest assembler and no static analyser;
 *   naming them here and refusing would be worse than not offering them.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { MettaError } from "./errors.ts";
import { type MeTTa, metta } from "./metta.ts";
import { version } from "./version.ts";

/**
 * Where a command writes.
 *
 * Passed in rather than reached for, so a test reads what a command wrote
 * without replacing `process.stdout.write` — which is the stream the test
 * runner itself reports on, and replacing it hides the run.
 */
export interface Output {
  /** Ordinary output. */
  write(text: string): void;
  /** Diagnostics and refusals. */
  fail(text: string): void;
}

const CONSOLE: Output = {
  write: (text: string): void => {
    stdout.write(text);
  },
  fail: (text: string): void => {
    process.stderr.write(text);
  },
};

const USAGE = `usage: metta-node <command> [arguments]

Run MeTTa on the engine this package carries, in one Node process.

  run FILE...          load each file and print every ! answer group
  eval TERM            reduce one term and print each answer
  repl                 an interactive read-eval-print loop
  doc NAME             print a name's (@doc ...) documentation
  why TERM             print the first proof of an answer
  forms FILE           print each top-level form and the kind the reader gave it
  --version            print the version
  --help               print this

Every command exits nonzero when it fails.`;

/** Print everything the engine wrote while the work ran. */
function flush(surface: MeTTa, io: Output): void {
  for (const line of surface.drainOutput()) io.write(line);
  for (const line of surface.drainStderr()) io.fail(line);
}

function runFiles(surface: MeTTa, files: readonly string[], io: Output): void {
  for (const file of files) {
    for (const group of surface.loadFile(file)) io.write(`[${group.texts.join(", ")}]\n`);
    flush(surface, io);
  }
}

async function evalTerm(surface: MeTTa, source: string, io: Output): Promise<void> {
  const term = surface.parse(source);
  for await (const answer of surface.eval(term)) io.write(`${answer.text}\n`);
  flush(surface, io);
}

async function repl(surface: MeTTa, io: Output): Promise<void> {
  const lines = createInterface({ input: stdin, output: stdout });
  io.write("metta-node. One form per line; a blank line exits.\n");
  try {
    for (;;) {
      const line = (await lines.question("> ")).trim();
      if (line === "") return;
      try {
        // A directive or a definition goes through `run`, which is the door
        // that admits equations; anything else is a term to reduce, which is
        // what a reader typing `(+ 1 2)` means.
        if (line.startsWith("!") || line.startsWith("(=") || line.startsWith("(:")) {
          for (const group of surface.run(line)) {
            if (group.texts.length > 0) io.write(`[${group.texts.join(", ")}]\n`);
          }
        } else {
          await evalTerm(surface, line, io);
        }
      } catch (error) {
        io.write(`${String(error)}\n`);
      }
      flush(surface, io);
    }
  } finally {
    lines.close();
  }
}

async function doc(surface: MeTTa, name: string, io: Output): Promise<number> {
  const subject = surface.parse(name);
  const found = await surface.doc(subject).find();
  if (found === undefined) {
    io.fail(`${name} has no documentation here\n`);
    return 1;
  }
  io.write(`${found.text}\n`);
  return 0;
}

async function why(surface: MeTTa, source: string, io: Output): Promise<number> {
  const proof = await surface.why(surface.parse(source));
  if (proof === undefined) {
    io.fail(`${source} has no proof here\n`);
    return 1;
  }
  io.write(`${String(proof)}\n`);
  return 0;
}

/** Run one command line. Answers the exit status rather than exiting. */
export async function main(argv: readonly string[], io: Output = CONSOLE): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "-V") {
    io.write(`metta-node ${version()}\n`);
    return 0;
  }
  const surface = await metta();
  try {
    switch (command) {
      case "run":
        if (rest.length === 0) throw new MettaError("run needs at least one file");
        runFiles(surface, rest, io);
        return 0;
      case "eval":
        if (rest.length === 0) throw new MettaError("eval needs a term");
        await evalTerm(surface, rest.join(" "), io);
        return 0;
      case "repl":
        await repl(surface, io);
        return 0;
      case "doc":
        if (rest.length === 0) throw new MettaError("doc needs a name");
        return await doc(surface, rest.join(" "), io);
      case "why":
        if (rest.length === 0) throw new MettaError("why needs a term");
        return await why(surface, rest.join(" "), io);
      case "forms": {
        if (rest.length === 0) throw new MettaError("forms needs a file");
        const { readFileSync } = await import("node:fs");
        for (const form of surface.forms(readFileSync(rest[0] as string, "utf8"))) {
          io.write(`${form.kind}\t${form.text}\n`);
        }
        return 0;
      }
      default:
        io.fail(`metta-node: no such command ${command}\n\n${USAGE}\n`);
        return 1;
    }
  } catch (error) {
    io.fail(`${String(error)}\n`);
    return 1;
  } finally {
    surface.dispose();
  }
}

// Run only when this file IS the command, so importing it for a test costs
// nothing. `process.argv[1]` is the script the runtime was pointed at.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? "\0")) {
  process.exitCode = await main(process.argv.slice(2));
}
