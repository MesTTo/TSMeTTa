/**
 * Purpose: keep the README's public subpath table aligned with the Node
 *   package entry points consumers can actually import.
 * Assumes:
 *   - `packageRoot` contains both README.md and package.json in source and
 *     compiled test lanes
 * Guarantees:
 *   - the documented subpaths are EXACTLY the package's code-module exports,
 *     derived from its own exports map rather than from a list here
 *     [tested: "ties every documented subpath to a package export";
 *     commit=c6ed562a1a6f964aba906206f2558489b107dc24]
 *   - the public `TabledMap` row states that swipl-wasm tables end with one
 *     run, so the class cannot drift back to promising a persistent cache
 *     [tested: "pins the Node table lifetime at the run boundary";
 *     commit=c6ed562a1a6f964aba906206f2558489b107dc24]
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

//: DERIVED from package.json, not listed here. A hand-written list asserted
//: with deepEqual does not check the README against the package, it pins the
//: README to whatever the list says, and this one said ten while the exports
//: map declared thirty-one code modules: documenting a subpath made the test
//: RED. The two non-module exports, `./package.json` and `./bridge.pl`, are
//: separated by what their target is rather than by name, so a third one
//: needs no edit here.
function publicSubpaths(exports: Readonly<Record<string, unknown>>): readonly string[] {
  const target = (entry: unknown): string =>
    typeof entry === "string"
      ? entry
      : String((entry as Record<string, unknown>)?.default
          ?? (entry as Record<string, unknown>)?.types ?? "");
  return Object.entries(exports)
    .filter(([key, entry]) => key !== "." && target(entry).endsWith(".js"))
    .map(([key]) => `tsmetta/${key.slice(2)}`)
    .sort();
}

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

    assert.deepEqual([...new Set(named)].sort(), publicSubpaths(manifest.exports));
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
