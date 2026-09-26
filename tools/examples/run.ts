/**
 * Purpose: run every program of the mounted examples corpus in its own
 *   process, and run each twin's MeTTa original with it, so a twin that stops
 *   agreeing with the program it mirrors turns the run red.
 * Assumes: tools/examples.mjs has installed this seat's packed build as the
 *   corpus's tsmetta, compiled every program into the corpus's dist/, and
 *   started this with the corpus root as working directory and TSMETTA_BUILD
 *   naming that build.
 * Guarantees:
 *   - a program passes only when the source scan finds nothing and it
 *     finishes having made at least one assertion; the count it prints is the
 *     assertions it executed
 *   - a program that prints `SKIP: ` and exits 0 before asserting anything is
 *     reported as a skip, the verdict its guarded import gives a reader whose
 *     install lacks the package, and a skip fails nothing
 *   - a twin passes only when the source scan finds nothing and lane.ts's
 *     `agree` finds nothing between it and its original, the difference its
 *     DIVERGENCE export declares included
 *   - with no selection, every original must have a twin or a residue entry
 *     covering the whole example, and a twin with no original is a finding
 *   - an original runs less the `!` forms residue.json says this build
 *     refuses, so the pair compares what this build can run, and an original
 *     it refuses whole is walked form by form to show no claim of it runs, a
 *     claim that runs where it stands, or a clean load, being a stale entry
 *   - `--settle=<reason>` writes into each selected twin the DIVERGENCE its
 *     run shows, with that reason, or removes one the runs no longer show
 *   - every side writes its report into this run's own directory under ai-tmp/,
 *     so two runs never read each other's results
 *   - a twin starts after its original has finished, so no file the original
 *     writes is written by both sides at once [tested 2026-09-26T17:55:04+10:00:
 *     run.js 20-03-prolog-underneath/05-the-module-doors, twenty runs, each
 *     passing]
 * Fails when: two runs share one mounted corpus at once, since both compile
 *   into its dist/ and one can import a program the other is rewriting.
 * Owns resources: one child process per side, each finished before the summary.
 * Decides: one pair runs per core the lane may use, METTA_LANE_WIDTH when the
 *   gate divides the box and every available core otherwise, capped at
 *   sixteen, the most engines the lane held at once while a pair's two sides
 *   ran together.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";

import { compiled, coverage, isTwin, originalOf, originals, programs, residue } from "./corpus.ts";
import { declared } from "./declare.ts";
import { type Difference, agree, mergeVolatile, storedDifference } from "./lane.ts";
import { scan } from "./scan.ts";
import type { Report } from "./side.ts";

/** The findings a settled divergence answers: the stored-atom comparisons. */
const STORED =
  /^the two runs stored different atoms|^the runs no longer differ the way DIVERGENCE declares/;

/** A program's line saying it could not run for a package it lacks. */
const SKIPPED = /^SKIP: (.+)$/m;

const SIDE = fileURLToPath(new URL("./side.js", import.meta.url));
const IDLE = fileURLToPath(new URL("./idle.js", import.meta.url));
const RUN = `ai-tmp/run-${new Date().toISOString().replace(/[:.]/g, "-")}-${String(process.pid)}`;
mkdirSync(RUN, { recursive: true });

let reports = 0;

/** One side, in its own process; resolves with its report and what it printed. */
function side(
  kind: "original" | "whole" | "program",
  path: string,
  refused: readonly number[] = [],
): Promise<Report & { output: string }> {
  reports += 1;
  const out = `${RUN}/${String(reports)}.json`;
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [SIDE, kind, path, out, refused.join(",")], {
      // TMPDIR places Node's temporary files and TMP the engine's, which is
      // the variable a native SWI-Prolog reads for its tmp_dir, so neither
      // side writes into a RAM-backed /tmp.
      env: { ...process.env, TMPDIR: `${process.cwd()}/ai-tmp`, TMP: `${process.cwd()}/ai-tmp` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (!existsSync(out)) {
        accept({
          ok: false,
          claims: 0,
          error: `the side exited ${String(code)} and wrote no report`,
          output,
        });
        return;
      }
      accept({ ...(JSON.parse(readFileSync(out, "utf8")) as Report), output });
    });
  });
}

interface Result {
  readonly path: string;
  readonly original?: string;
  readonly observed?: Difference;
  readonly declared?: Report["divergence"];
  readonly claims: number;
  readonly owed?: number;
  readonly skipped?: string;
  readonly findings: readonly string[];
  readonly output: string;
  readonly inferences?: { readonly original?: number; readonly twin?: number };
}

// `--settle=<reason>` declares, for every selected twin, the stored-atom
// difference its run shows, with that reason: PyMeTTa's `--repin --reason`.
const settleFlag = process.argv.slice(2).find((arg) => arg.startsWith("--settle="));
const settling = settleFlag?.slice("--settle=".length);
if (settling !== undefined && settling.trim() === "")
  throw new Error("--settle= needs the reason the difference is right");
const selected = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const chosen = (path: string): boolean =>
  selected.length === 0 || selected.some((part) => path.includes(part));

const rows = residue();
const declined = rows.filter((entry) => entry.kind === "declined");
/** The `!` forms of an original this build refuses, counted from 1. */
const refusedIn = (original: string): number[] =>
  rows
    .filter((entry) => entry.kind === "refused" && entry.example === original)
    .flatMap((entry) => entry.forms ?? []);
/** The originals an entry covers whole, which then have no twin. */
const wholly = new Map(
  rows.filter((entry) => entry.forms === undefined).map((entry) => [entry.example, entry]),
);
const corpus = originals();
const every = programs();
const twins = every.filter(isTwin);

const found = selected.length === 0 ? coverage(corpus, twins, wholly) : [];

const idle = await side("program", IDLE);
if (!idle.ok || idle.inferences === undefined) {
  throw new Error(`the idle engine did not report its inferences: ${idle.error ?? idle.output}`);
}

const jobs: (() => Promise<Result>)[] = [];

for (const source of every.filter((path) => !isTwin(path) && chosen(path))) {
  jobs.push(async () => {
    const ran = await side("program", compiled(source));
    const skipped = SKIPPED.exec(ran.output)?.[1];
    if (skipped !== undefined && ran.ok && ran.claims === 0) {
      return { path: source, claims: 0, skipped, findings: [], output: ran.output };
    }
    // A hand-written program is held to the twins' spellings as well as to
    // asserting something.
    const findings = scan(source, compiled(source));
    if (!ran.ok) findings.push(`failed: ${ran.error ?? `exited ${String(ran.exited)}`}`);
    else if (ran.claims === 0) findings.push("finished without asserting anything");
    return { path: source, claims: ran.claims, findings, output: ran.output };
  });
}

for (const twin of twins.filter((path) => chosen(path) || chosen(originalOf(path)))) {
  const original = originalOf(twin);
  if (!corpus.includes(original)) continue;
  jobs.push(async () => {
    // One side after the other, because a twin performs its original's
    // effects on the same files: 05-the-module-doors writes and deletes
    // _fixtures/static_rows.tokens-v1.pl, and with both sides running at once
    // one of them found the file the other had just deleted.
    const left = await side("original", original, refusedIn(original));
    const right = await side("program", compiled(twin));
    const divergence = right.divergence;
    const declinedClaims = declined
      .filter((entry) => entry.example === original)
      .reduce((count, entry) => count + (entry.forms?.length ?? 0), 0);
    // A stored difference may be the original's own volatility, a clock
    // reading or a draw, which only a second run of the original tells apart.
    const exact = storedDifference(left, right, undefined, divergence?.volatile);
    const moved = Object.keys(exact.originalOnly).length + Object.keys(exact.twinOnly).length > 0;
    const again =
      left.ok && right.ok && moved
        ? await side("original", original, refusedIn(original))
        : undefined;
    const findings = [
      ...scan(twin, compiled(twin)),
      ...agree(left, right, {
        declined: declinedClaims,
        idle: idle.inferences ?? 0,
        ...(divergence === undefined ? {} : { divergence }),
        ...(again === undefined ? {} : { again }),
      }),
    ];
    return {
      path: twin,
      original,
      observed:
        again === undefined ? exact : storedDifference(left, right, again, divergence?.volatile),
      declared: divergence,
      claims: right.claims,
      owed: Math.max(0, left.claims - declinedClaims),
      findings:
        settling === undefined ? findings : findings.filter((finding) => !STORED.test(finding)),
      output: right.output,
      inferences: {
        ...(left.inferences === undefined ? {} : { original: left.inferences }),
        ...(right.inferences === undefined ? {} : { twin: right.inferences }),
      },
    };
  });
}

// A whole example this build refuses is loaded anyway, and walked form by
// form when it fails. One that loads, or has a claim that runs where it
// stands, is a stale entry: its twin is owed, and the forms that fail are the
// per-form refusal it becomes.
for (const original of corpus.filter(
  (path) => wholly.get(path)?.kind === "refused" && chosen(path),
)) {
  jobs.push(async () => {
    const loaded = await side("whole", original);
    const runs = loaded.runsNow ?? [];
    const findings = loaded.ok
      ? [
          `residue.json refuses ${original} whole, and it now loads without error; write its twin and delete the entry`,
        ]
      : loaded.runsNow === undefined || loaded.failsNow === undefined
        ? [`the walk of ${original} did not finish: ${loaded.error ?? "no error reported"}`]
        : runs.length > 0
          ? [
              `residue.json refuses ${original} whole, and its claim forms ${runs.join(", ")} run where they stand; write its twin and refuse per form only ${loaded.failsNow.join(", ")}`,
            ]
          : [];
    return { path: original, claims: 0, findings, output: loaded.output };
  });
}

if (jobs.length === 0) throw new Error("no program matches the selection");

const width = Number(process.env["METTA_LANE_WIDTH"] ?? availableParallelism());
const results: Result[] = [];
const queue = [...jobs];
async function worker(): Promise<void> {
  for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
    const result = await job();
    results.push(result);
    if (result.skipped !== undefined) {
      console.log(`SKIP ${result.path}: ${result.skipped}`);
      continue;
    }
    const owed = result.owed === undefined ? "" : ` of ${String(result.owed)} owed`;
    console.log(
      `${result.findings.length === 0 ? "PASS" : "FAIL"} ${result.path} (${String(result.claims)} claims${owed})`,
    );
    for (const finding of result.findings) console.log(`  - ${finding}`);
    if (result.findings.length > 0 && result.output.trim() !== "") {
      console.log(result.output.trimEnd().replace(/^/gm, "    | "));
    }
  }
}
await Promise.all(
  Array.from({ length: Math.max(1, Math.min(16, Number.isInteger(width) ? width : 1)) }, worker),
);

results.sort((a, b) => a.path.localeCompare(b.path));
if (settling !== undefined) {
  let written = 0;
  for (const result of results) {
    if (result.original === undefined || result.observed === undefined) continue;
    const volatile = mergeVolatile(result.declared?.volatile, result.observed.volatile);
    const differs =
      Object.keys(result.observed.originalOnly).length +
        Object.keys(result.observed.twinOnly).length +
        Object.keys(volatile).length >
      0;
    const before = readFileSync(result.path, "utf8");
    const after = await declared(
      result.path,
      before,
      differs
        ? {
            originalOnly: result.observed.originalOnly,
            twinOnly: result.observed.twinOnly,
            ...(Object.keys(volatile).length > 0 ? { volatile } : {}),
            reason: settling,
          }
        : undefined,
    );
    if (after !== before) {
      writeFileSync(result.path, after);
      written += 1;
    }
  }
  console.log(`settled ${String(written)} twins' DIVERGENCE`);
}
writeFileSync(`${RUN}/results.json`, JSON.stringify({ coverage: found, results }, null, 2) + "\n");
for (const finding of found) console.log(`FAIL ${finding}`);
const failed = results.filter((result) => result.findings.length > 0).length + found.length;
const skipped = results.filter((result) => result.skipped !== undefined).length;
const claims = results.reduce((total, result) => total + result.claims, 0);
const paired = results.filter((result) => result.original !== undefined).length;
console.log(
  `${String(results.length)} programs (${String(paired)} twins run after their originals), ` +
    `${String(claims)} assertions, ${String(failed)} failures, ${String(skipped)} skipped; reports in ${RUN}`,
);
if (failed > 0) process.exitCode = 1;
