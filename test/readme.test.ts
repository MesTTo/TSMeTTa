/**
 * Purpose: keep the README's public subpath table aligned with the Node
 *   package entry points consumers can actually import.
 * Assumes:
 *   - `packageRoot` contains both README.md and package.json in source and
 *     compiled test lanes
 * Guarantees:
 *   - every documented subpath names an exported package entry point
 *     [tested: "ties every documented subpath to a package export";
 *     commit=WORKTREE]
 *   - the public `TabledMap` row states that swipl-wasm tables end with one
 *     run, so the class cannot drift back to promising a persistent cache
 *     [tested: "pins the Node table lifetime at the run boundary";
 *     commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/index.ts";

const PUBLIC_SUBPATHS = [
  "tsmetta/algebra",
  "tsmetta/arrays",
  "tsmetta/convert",
  "tsmetta/integrate",
  "tsmetta/lint",
  "tsmetta/manifest",
  "tsmetta/paths",
  "tsmetta/remote",
  "tsmetta/structures",
  "tsmetta/tables",
] as const;

function section(markdown: string, heading: string): string {
  const marker = `### ${heading}\n`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `README has no ${marker.trim()} section`);
  const body = start + marker.length;
  const next = markdown.indexOf("\n## ", body);
  return markdown.slice(body, next === -1 ? undefined : next);
}

describe("the README's public subpaths", () => {
  it("ties every documented subpath to a package export", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly exports: Readonly<Record<string, unknown>>;
    };
    const documented = section(readme, "Public subpaths");
    const named = [...documented.matchAll(/`(tsmetta\/[^`]+)`/g)].map((match) => match[1]);

    assert.deepEqual([...new Set(named)].sort(), [...PUBLIC_SUBPATHS].sort());
    // Node's exports map is the package's public subpath allow-list:
    // https://nodejs.org/download/release/v22.17.0/docs/api/packages.html#subpath-exports
    for (const specifier of named) {
      const exported = `./${specifier.slice("tsmetta/".length)}`;
      assert.ok(Object.hasOwn(manifest.exports, exported), `${specifier} is not package-exported`);
    }
  });

  it("pins the Node table lifetime at the run boundary", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const documented = section(readme, "Public subpaths");
    const tabledMap = documented
      .split("\n")
      .find((line) => line.includes("`tsmetta/structures`"));

    assert.ok(tabledMap, "README has no TabledMap subpath row");
    assert.match(tabledMap, /query-local/);
    assert.match(tabledMap, /one `run\(\)`/);
    assert.match(tabledMap, /later jobs recompute/);
  });
});
