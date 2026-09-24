/**
 * Purpose: keep the README's public subpath table aligned with the Node
 *   package entry points consumers can actually import.
 * Assumes:
 *   - `packageRoot` contains both README.md and package.json in source and
 *     compiled test lanes
 * Guarantees:
 *   - the depth sections' TypeScript fences execute through the real runtime
 *     [tested: "executes the depth examples"; commit=94e5fc7eb685b895dde2878e7054332a0cb61c7d].
 *   - the documented subpaths are EXACTLY the package's code-module exports,
 *     derived from its own exports map rather than from a list here
 *     [tested: "ties every documented subpath to a package export";
 *     commit=c6ed562a1a6f964aba906206f2558489b107dc24]
 *   - the public `TabledMap` row states that a table is shared by every ask
 *     of the instance, so the row cannot drift back to a lifetime the host no
 *     longer has [tested: "pins the Node table lifetime to the instance";
 *     commit=3e8b7d4778b0fc8ec98719d94c82667e1d4862c7]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

import { metta, packageRoot } from "../src/index.ts";

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
  it("executes the depth examples", async () => {
    using m = await metta();
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const examples = readme.slice(readme.indexOf("## Queries, joins and guards\n"), readme.indexOf("## Theories\n"));
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const moduleUrl = (name: string): string => new URL(`../src/${name}.${extension}`, import.meta.url).href;
    const fences = [...examples.matchAll(/```ts\n([\s\S]*?)\n```/g)];
    assert.ok(fences.length > 0, "the depth sections contain no examples");
    // Parse imports with the compiler; every remaining statement executes in
    // its own resource scope, using the same engine and notation as the page.
    for (const fence of fences) {
      const parsed = ts.createSourceFile("example.ts", fence[1]!, ts.ScriptTarget.Latest, true);
      const imports: string[] = [];
      const statements: string[] = [];
      for (const statement of parsed.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
          const specifier = statement.moduleSpecifier.text;
          assert.match(specifier, /^tsmetta(?:\/[a-z-]+)?$/);
          const target = moduleUrl(specifier === "tsmetta" ? "index" : specifier.slice("tsmetta/".length));
          imports.push(statement.getText(parsed).replace(JSON.stringify(specifier), JSON.stringify(target)));
        } else statements.push(statement.getText(parsed));
      }
      const source = `import { S, V, fn } from ${JSON.stringify(moduleUrl("index"))};\n` +
        imports.join("\n") + `\nexport async function example(m) {\n${statements.join("\n")}\n}`;
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
      const loaded = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputText).toString("base64")}`) as {
        example: (runtime: typeof m) => Promise<void>;
      };
      await loaded.example(m);
    }
  });

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

  it("pins the Node table lifetime to the instance", () => {
    const readme = readFileSync(join(packageRoot, "README.md"), "utf8");
    const documented = section(readme, "Public subpaths");
    const tabledMap = documented
      .split("\n")
      .find((line) => line.includes("`tsmetta/structures`"));

    assert.ok(tabledMap, "README has no TabledMap subpath row");
    assert.match(tabledMap, /shared by every ask of the instance/);
    assert.match(tabledMap, /a later `get\(\)` reads what an earlier ask computed/);
  });
});
