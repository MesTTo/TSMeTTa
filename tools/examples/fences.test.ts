/**
 * Purpose: hold the README fence check to its rule: a fence is runs of the
 *   named file's consecutive lines, in order, with indentation, and a drifted
 *   fence fails naming the file and the first line not found.
 * Guarantees: every way a fence can drift has a case that must fail beside
 *   the ones that must pass [tested 2026-09-26T17:54:50+10:00: node --test fences.test.js].
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fenceFindings } from "./fences.ts";

const PROGRAM = [
  "/**",
  " * Purpose: a planted program.",
  " */",
  'import { S, metta } from "tsmetta";',
  "",
  "using m = await metta();",
  "m.add(S.parent(S.tom, S.bob));",
  "for (const row of await m.match(S.parent(S.tom, S.bob))) {",
  "  console.log(row);",
  "}",
  "",
  "m.add(S.parent(S.bob, S.ann));",
].join("\n");

const files: Record<string, string> = { "ch01-getting-started/planted.ts": PROGRAM };
const read = (path: string): string | undefined => files[path];

/** A README holding one entry for the planted program, whose fence is `body`. */
const readme = (body: readonly string[], heading = "ch01-getting-started/planted.ts"): string =>
  [
    "# TSMeTTa by example",
    "",
    "## Getting started",
    "",
    `### [${heading}](${heading})`,
    "",
    "A planted program.",
    "",
    "```ts",
    ...body,
    "```",
    "",
  ].join("\n");

test("passes runs of consecutive lines, in order, with their indentation", () => {
  assert.deepEqual(
    fenceFindings(
      readme([
        "using m = await metta();",
        "m.add(S.parent(S.tom, S.bob));",
        "...",
        "  console.log(row);",
        "}",
        "",
        "m.add(S.parent(S.bob, S.ann));",
      ]),
      read,
    ),
    [],
  );
});

test("fails a drifted fence naming the file and the first line not found", () => {
  const drifted: [string, readonly string[], string][] = [
    [
      "a reworded line",
      ["using m = await metta();", "m.add(S.parent(S.tom, S.ann));"],
      "m.add(S.parent(S.tom, S.ann));",
    ],
    ["a reindented line", ["console.log(row);"], "console.log(row);"],
    ["a line of no file", ['import { V } from "tsmetta";'], 'import { V } from "tsmetta";'],
    [
      "runs out of order",
      ["m.add(S.parent(S.bob, S.ann));", "...", "using m = await metta();"],
      "using m = await metta();",
    ],
    [
      "an omission with no ...",
      ["using m = await metta();", "  console.log(row);"],
      "  console.log(row);",
    ],
  ];
  for (const [what, body, line] of drifted) {
    assert.deepEqual(
      fenceFindings(readme(body), read),
      [`ch01-getting-started/planted.ts: first line not found: ${JSON.stringify(line)}`],
      what,
    );
  }
});

test("fails a fence no entry names, a file that is not there, and an entry that shows nothing", () => {
  assert.deepEqual(
    fenceFindings(readme(["using m = await metta();"], "ch01-getting-started/absent.ts"), read),
    ["ch01-getting-started/absent.ts: the README quotes it, and it does not exist"],
  );
  assert.deepEqual(
    fenceFindings(
      ["## Getting started", "", "```ts", "using m = await metta();", "```"].join("\n"),
      read,
    ),
    ["README line 3: a TypeScript fence under no entry naming its file"],
  );
  assert.deepEqual(
    fenceFindings(
      [
        "### [ch01-getting-started/planted.ts](ch01-getting-started/planted.ts)",
        "",
        "Told, not shown.",
        "",
      ].join("\n"),
      read,
    ),
    ["ch01-getting-started/planted.ts: the entry shows no code"],
  );
  assert.deepEqual(
    fenceFindings(
      [
        "### [planted.ts](ch01-getting-started/planted.ts)",
        "",
        "```ts",
        "using m = await metta();",
        "```",
      ].join("\n"),
      read,
    ),
    ["README line 1: the heading shows planted.ts and links ch01-getting-started/planted.ts"],
  );
});

test("fails a metta fence and leaves every other language alone", () => {
  const page =
    readme(["using m = await metta();"]) + "```metta\n!(+ 1 2)\n```\n\n```sh\nnpm ci\n```\n";
  assert.deepEqual(fenceFindings(page, read), [
    "README line 12: a metta fence; the page shows TypeScript",
  ]);
});
