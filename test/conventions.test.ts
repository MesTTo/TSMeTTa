/**
 * Purpose: the Google TypeScript Style Guide rules that reach a LIBRARY
 *   SURFACE, as an executable gate over this package's own sources.
 * Assumes:
 *   - `google.github.io/styleguide/tsguide.html` (mirrored at `ts.dev/style`)
 *     is the genre's normative guide, the way PEP 8 is Python's, and its
 *     surface-reaching rules are the ones checked here: casing per kind, no
 *     `I` prefix on an interface, no leading or trailing underscore, no
 *     `Array<T>` where `T[]` reads, no `enum`, no default export, no `any`
 * Guarantees:
 *   - a violation names the file and the identifier, so the gate is a fix
 *     rather than a verdict [tested: every case below]
 *   - the check reads the SOURCES, so a rule cannot be satisfied by the
 *     declaration emitter rewriting something
 * Decides: the reader is a regular expression over the source rather than a
 *   parse. It runs with no dependency and no build, and its one cost is that
 *   it sees a name inside a comment. Every rule below therefore reads a
 *   declaration keyword and an identifier together, which a comment does not
 *   carry, and the exemptions are named individually rather than by pattern.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { packageRoot } from "../src/engine.ts";

// The PACKAGE's own `src`, not a path relative to this file. Relative to the
// test, `../src` is `build/src` when the suite runs compiled, which holds no
// `.ts` file at all: every rule below then scanned nothing and reported clean.
const SOURCE = join(packageRoot, "src");

/** Every `.ts` file under `src`, with its text. */
function sources(): { path: string; text: string }[] {
  const found: { path: string; text: string }[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) found.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(SOURCE);
  return found;
}

const FILES = sources();

/** Every match of a pattern over these files, as `file: identifier`. */
function scan(
  files: readonly { path: string; text: string }[],
  pattern: RegExp,
  keep: (name: string, path: string) => boolean,
): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const match of file.text.matchAll(pattern)) {
      const name = match[1] ?? match[0];
      if (keep(name, file.path)) found.push(`${file.path.slice(SOURCE.length + 1)}: ${name}`);
    }
  }
  return found;
}

/** Every match of a pattern over this package's own sources. */
function offences(pattern: RegExp, keep: (name: string, path: string) => boolean): string[] {
  return scan(FILES, pattern, keep);
}

/**
 * The three names this package spells against the casing rules, each because
 * the ENGINE spells it that way and a name that meant something else would be
 * a name for nothing.
 */
const EXEMPT = new Set([
  // `S`, `V` and `G` are the term factories, and they are single capitals in
  // every MeTTa host: Python's, this one's, and the source design's.
  "S",
  "V",
  "G",
  // `_` is the anonymous variable, which is Prolog's own spelling and
  // ts-pattern's `P._` for the same job.
  "_",
  // `TP` and `TU` are the Stratego strategy kinds, named in the literature.
  "TP",
  "TU",
  // `PATH_AT` and `SUBSCRIPTION_QUEUE_MAX` are module constants, which the
  // guide spells CONSTANT_CASE.
  "PATH_AT",
  "SUBSCRIPTION_QUEUE_MAX",
  "VOCABULARIES",
  // `MeTTa` is the language's own name, and the engine's.
  "MeTTa",
]);

describe("the TypeScript style guide, where it reaches this surface", () => {
  it("names every class, interface and type alias in UpperCamelCase", () => {
    const wrong = offences(
      /^export (?:abstract )?(?:class|interface|type) ([A-Za-z_$][\w$]*)/gm,
      (name) => !EXEMPT.has(name) && !/^[A-Z][A-Za-z0-9]*$/.test(name),
    );
    assert.deepEqual(wrong, []);
  });

  it("puts no I prefix on an interface, which the guide forbids by name", () => {
    const wrong = offences(
      /^export interface (I[A-Z][\w$]*)/gm,
      () => true,
    );
    assert.deepEqual(wrong, []);
  });

  it("names every exported function in lowerCamelCase, or capitalises a constructor", () => {
    // A capitalised function is allowed and is the design's own rule: `If`,
    // `Let`, `Match` and the rest CONSTRUCT an atom rather than branching, and
    // JSX has already taught every TypeScript reader that an UpperCamelCase
    // callable returns a tree. Anything else must be lowerCamelCase.
    const wrong = offences(
      /^export (?:async )?function\*? ([A-Za-z_$][\w$]*)/gm,
      (name) =>
        !EXEMPT.has(name) &&
        !/^[a-z][A-Za-z0-9]*$/.test(name) &&
        !/^[A-Z][A-Za-z0-9]*$/.test(name),
    );
    assert.deepEqual(wrong, []);
  });

  it("uses no leading or trailing underscore on an exported name", () => {
    const wrong = offences(
      /^export (?:const|function|class|interface|type|abstract class) ([A-Za-z_$][\w$]*)/gm,
      (name) => !EXEMPT.has(name) && (name.startsWith("_") || name.endsWith("_")),
    );
    assert.deepEqual(wrong, []);
  });

  it("spells an array type as T[] rather than Array<T>", () => {
    // Two spellings stay: `new Array<T>(n)` is a CONSTRUCTOR call, which the
    // guide allows, and `interface X extends ReadonlyArray<T>` is the only way
    // to write a recursive array type at all, since `T[]` cannot be extended.
    const wrong = offences(
      /((?:new |extends )?(?:Readonly)?Array<[^>]*>)/g,
      (name) => !name.startsWith("new ") && !name.startsWith("extends "),
    );
    assert.deepEqual(wrong, []);
  });

  it("declares no enum, which erasable syntax refuses anyway", () => {
    assert.deepEqual(offences(/^\s*(?:export )?(?:const )?enum\s/gm, () => true), []);
  });

  it("has no default export, so every import spells the name it took", () => {
    assert.deepEqual(offences(/^export default\b/gm, () => true), []);
  });

  it("uses no `any`, anywhere in the sources", () => {
    // `unknown` is the honest top type and this package uses it everywhere.
    // The pattern reads a TYPE position, so the word inside prose is not a hit.
    assert.deepEqual(offences(/:\s*any\b|<any>|as any\b/g, () => true), []);
  });

  it("gives every source file the obligation header this repository requires", () => {
    // The header sits after a mandatory shebang, which is where this
    // repository's own convention puts it.
    const missing = FILES.filter(
      (file) => !file.text.replace(/^#![^\n]*\n/, "").startsWith("/**\n * Purpose:"),
    ).map((file) => file.path.slice(SOURCE.length + 1));
    assert.deepEqual(missing, []);
  });

  it("reads this package's own sources, and there are many of them", () => {
    // The rules above are vacuous over an empty file list, and a path that
    // resolved to the BUILD directory made them exactly that. This is the
    // count that says the scan looked at something.
    assert.ok(FILES.length >= 20, `${String(FILES.length)} source files scanned`);
    assert.ok(FILES.some((file) => file.path.endsWith("index.ts")));
  });

  it("documents every exported name", () => {
    // The rule that makes a surface readable from the editor: an export with no
    // doc comment above it is one a reader meets with no explanation.
    const declaration =
      /^export (?:async )?(?:abstract )?(?:function\*?|class|interface|type|const) ([A-Za-z_$][\w$]*)/;
    const undocumented: string[] = [];
    for (const file of FILES) {
      const lines = file.text.split("\n");
      let documented = "";
      lines.forEach((line, at) => {
        const found = declaration.exec(line);
        if (found === null) return;
        const name = found[1] as string;
        const above = (lines[at - 1] ?? "").trim();
        if (above.endsWith("*/") || above.startsWith("//")) {
          documented = name;
          return;
        }
        // An OVERLOAD group is one declaration said several times, and the doc
        // comment sits above the first of them.
        if (name === documented) return;
        undocumented.push(`${file.path.slice(SOURCE.length + 1)}:${String(at + 1)}: ${line.trim()}`);
      });
    }
    assert.deepEqual(undocumented, []);
  });

  it("imports every module with the .ts extension node's resolver needs", () => {
    const wrong = offences(/from "(\.[^"]*)"/g, (name) => !name.endsWith(".ts"));
    assert.deepEqual(wrong, []);
  });

  /**
   * The gate's own eyesight.
   *
   * A clean result says nothing on its own: a pattern that matches NOTHING
   * reports every tree clean and nothing says so. So each rule is run against
   * a planted violation and required to find it, which is the same proof the
   * repository's Prolog static checks make of their walker.
   */
  it("finds a planted violation of each rule it checks", () => {
    const planted = [
      {
        path: join(SOURCE, "planted.ts"),
        text: [
          "export class lowercaseClass {}",
          "export interface IThing {}",
          "export function BadName_() {}",
          "export const _leading = 1;",
          "export type Rows = Array<string>;",
          "export enum Colour { Red }",
          "export default 1;",
          "export const held: any = 1;",
          'import { x } from "./other";',
        ].join("\n"),
      },
    ];
    const rules: [string, RegExp, (name: string, path: string) => boolean][] = [
      ["casing", /^export (?:abstract )?(?:class|interface|type) ([A-Za-z_$][\w$]*)/gm,
        (name) => !EXEMPT.has(name) && !/^[A-Z][A-Za-z0-9]*$/.test(name)],
      ["the I prefix", /^export interface (I[A-Z][\w$]*)/gm, () => true],
      ["an underscore", /^export (?:const|function|class|interface|type) ([A-Za-z_$][\w$]*)/gm,
        (name) => name.startsWith("_") || name.endsWith("_")],
      ["Array<T>", /(Array<[^>]*>)/g, () => true],
      ["an enum", /^\s*(?:export )?(?:const )?enum\s/gm, () => true],
      ["a default export", /^export default\b/gm, () => true],
      ["any", /:\s*any\b|<any>|as any\b/g, () => true],
      ["an extensionless import", /from "(\.[^"]*)"/g, (name) => !name.endsWith(".ts")],
    ];
    const blind = rules
      .filter(([, pattern, keep]) => scan(planted, pattern, keep).length === 0)
      .map(([what]) => what);
    assert.deepEqual(blind, [], "every rule can see a violation of itself");
  });
});
