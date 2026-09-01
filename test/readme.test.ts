/**
 * Purpose: keep the README's Python-counterpart table aligned with the Node
 *   package entry points consumers can actually import.
 * Assumes:
 *   - `packageRoot` contains both README.md and package.json in source and
 *     compiled test lanes
 * Guarantees:
 *   - every counterpart repaired in finding N25 names a public Node subpath,
 *     and the stale absence table cannot return unnoticed
 *     [tested: "ties every documented Python counterpart to an exported Node subpath";
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

const COUNTERPARTS = [
  "metta-node/algebra",
  "metta-node/arrays",
  "metta-node/convert",
  "metta-node/integrate",
  "metta-node/lint",
  "metta-node/manifest",
  "metta-node/paths",
  "metta-node/remote",
  "metta-node/structures",
  "metta-node/tables",
] as const;

function section(markdown: string, heading: string): string {
  const marker = `### ${heading}\n`;
  const start = markdown.indexOf(marker);
  assert.notEqual(start, -1, `README has no ${marker.trim()} section`);
  const body = start + marker.length;
  const next = markdown.indexOf("\n## ", body);
  return markdown.slice(body, next === -1 ? undefined : next);
}

describe("the README's Python package comparison", () => {
  it("ties every documented Python counterpart to an exported Node subpath", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      readonly exports: Readonly<Record<string, unknown>>;
    };
    const compared = section(readme, "Python package counterparts");
    const named = [...compared.matchAll(/`(metta-node\/[^`]+)`/g)].map((match) => match[1]);

    assert.deepEqual([...new Set(named)].sort(), [...COUNTERPARTS].sort());
    // Node's exports map is the package's public subpath allow-list:
    // https://nodejs.org/download/release/v22.17.0/docs/api/packages.html#subpath-exports
    for (const specifier of named) {
      const exported = `./${specifier.slice("metta-node/".length)}`;
      assert.ok(Object.hasOwn(manifest.exports, exported), `${specifier} is not package-exported`);
    }

    assert.doesNotMatch(readme, /these parts of the Python package have no counterpart here yet/);
    assert.doesNotMatch(readme, /^\| absent \| why \|$/m);
    assert.doesNotMatch(compared, /what is absent is a packaged client|the analysis is not|no counterpart/);
  });
});
