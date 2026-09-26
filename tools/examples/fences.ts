/**
 * Purpose: hold every TypeScript fence in the examples corpus's README to real
 *   lines of the program its entry names, so the page cannot show code the
 *   program does not have.
 * Assumes: the README names each program in a `### [path](path)` heading, the
 *   path relative to the corpus root, and quotes it in the ```ts fence below
 *   that heading, where a line holding `...` alone marks omitted lines.
 * Guarantees:
 *   - a ```ts fence under no entry heading, or under one naming a file that
 *     does not exist, is a finding, and so is a heading whose text and link
 *     differ
 *   - a fence is runs of lines separated by `...` lines; each run is a block
 *     of consecutive lines of the named file, compared with indentation and
 *     less trailing whitespace, and each run begins after the one before it
 *     ends, so a reworded, reindented, reordered or silently shortened line
 *     fails, and the finding names the file and the first line not found
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/fences.test.ts]
 *   - this is stricter than PyMeTTa's tests/repository/test_example_snippets.py
 *     at f692a13d9, which asks only that each non-blank fence line be some
 *     line of the file, in any order
 *   - an entry with no fence, and any ```metta fence, is a finding, since the
 *     page shows TypeScript, and shows it rather than tells
 *   - run as `node fences.js <README>` from the corpus root, it prints each
 *     finding and exits 1 when there is one
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** An entry heading: `### [path](path)`. */
const ENTRY = /^### \[([^\]]+)\]\(([^)]+)\)$/;

/**
 * Where a run of lines stands in a file from line `from` on: the first
 * position holding the whole run, or else the one holding its longest prefix.
 * Time: O(K * R) comparisons, K the file lines from `from`, R the run's length.
 */
function longestMatch(
  file: readonly string[],
  run: readonly string[],
  from: number,
): { at: number; matched: number } {
  let best = { at: -1, matched: 0 };
  for (let at = from; at < file.length; at++) {
    let matched = 0;
    while (matched < run.length && file[at + matched] === run[matched]) matched++;
    if (matched === run.length) return { at, matched };
    if (matched > best.matched) best = { at, matched };
  }
  return best;
}

/**
 * Every finding for a README, reading each file an entry names through `read`.
 * Time: O(N) over the README's N lines, plus longestMatch for each run.
 */
export function fenceFindings(
  readme: string,
  read: (path: string) => string | undefined,
): string[] {
  const findings: string[] = [];
  const lines = readme.split("\n");
  let entry: string | undefined;
  let shown = true;
  const close = (): void => {
    if (entry !== undefined && !shown) findings.push(`${entry}: the entry shows no code`);
  };
  let at = 0;
  while (at < lines.length) {
    const line = lines[at] ?? "";
    const opened = at + 1;
    at += 1;
    if (line.startsWith("#")) {
      close();
      const named = ENTRY.exec(line);
      entry = named?.[2];
      shown = named === null;
      if (named !== null && named[1] !== named[2]) {
        findings.push(
          `README line ${String(opened)}: the heading shows ${named[1]} and links ${named[2]}`,
        );
      }
      continue;
    }
    const language = /^```(\S*)$/.exec(line)?.[1];
    if (language === undefined) continue;
    const body: string[] = [];
    while (at < lines.length && lines[at] !== "```") body.push(lines[at++] ?? "");
    at += 1;
    if (language === "metta") {
      findings.push(`README line ${String(opened)}: a metta fence; the page shows TypeScript`);
      continue;
    }
    if (language !== "ts" && language !== "typescript") continue;
    shown = true;
    if (entry === undefined) {
      findings.push(
        `README line ${String(opened)}: a TypeScript fence under no entry naming its file`,
      );
      continue;
    }
    const text = read(entry);
    if (text === undefined) {
      findings.push(`${entry}: the README quotes it, and it does not exist`);
      continue;
    }
    const file = text.split("\n").map((each) => each.trimEnd());
    const runs: string[][] = [[]];
    for (const quoted of body.map((each) => each.trimEnd())) {
      if (quoted.trim() === "...") runs.push([]);
      else runs.at(-1)?.push(quoted);
    }
    let from = 0;
    for (const run of runs.filter((each) => each.length > 0)) {
      const found = longestMatch(file, run, from);
      if (found.matched < run.length) {
        findings.push(`${entry}: first line not found: ${JSON.stringify(run[found.matched])}`);
        break;
      }
      from = found.at + run.length;
    }
  }
  close();
  return findings;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const readme = process.argv[2] ?? "README.md";
  const findings = fenceFindings(readFileSync(readme, "utf8"), (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  );
  for (const finding of findings) console.log(`FAIL ${finding}`);
  if (findings.length > 0) process.exitCode = 1;
  else console.log(`${readme}: every TypeScript fence is lines of the file its entry names`);
}
