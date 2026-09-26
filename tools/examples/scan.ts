/**
 * Purpose: read a program's compiled JavaScript and its TypeScript source for
 *   the spellings a program may not use: MeTTa source text handed to the
 *   engine to read, an exact-name door where the attribute reaches the same
 *   atom, the loose assert module, the generator's mark, and an import of
 *   anything a reader who installed tsmetta alone would not have.
 * Assumes:
 *   - the compiled file is tsc's ES2022 output of the source beside it,
 *     which keeps every string literal, call and member access the source
 *     wrote, and every import but a whole `import type` declaration, which
 *     the scan reads from the source; acorn parses it as a module
 *   - a member named `fn`, as in `m.fn` or `space.fn`, is tsmetta's asking
 *     door, which takes a called name exactly and maps an attribute or a
 *     bracketed name through `fnHead` as the `fn` factory does
 *     [source 2026-09-26T18:00:56+10:00: src/space.ts asking() and
 *     src/metta.ts `get fn()`]
 *   - every MeTTa method that reads its argument as MeTTa source names that
 *     parameter `source`, the free-function tier of tsmetta/ambient spells
 *     the same doors by the same names, tsmetta/lint's lint reads its
 *     `source` as MeTTa, and the Engine's read, which names it `text`, is
 *     the one reader door spelled otherwise [source 2026-09-26T18:00:56+10:00:
 *     src/metta.ts run, runStatus, load, q, forms, trace and parse,
 *     src/ambient.ts run, parse and forms, src/lint.ts lint and
 *     src/engine.ts read]; `source` alone does
 *     not mark a door, since docOf and spanOf name a TypeScript function's
 *     text so
 * Guarantees:
 *   - a finding names the line and the spelling to write instead
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "names the attribute a bracket door
 *     should have been"]
 *   - the exact-name rule is decided by the maps tsmetta's factories read,
 *     `mettaName` for `S`, `fnHead` for every `fn` door, which reads the
 *     operator words before the casing map, and none for `V`, so the scan and
 *     the factories cannot disagree about which spellings reach one atom:
 *     `fn("mul")` is the only spelling of the head `mul`, since `fn.mul` is
 *     `*` [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "reads every fn door by fnHead"]
 *   - a space is never named as a symbol: `S["&self"]` and every other
 *     ampersand name at the S door is a finding naming the handle to use
 *     [source 2026-09-26T18:00:56+10:00: ai-python-conventions.md at the
 *     workspace root, lines 2143-2159, "Write this, not that"]
 *   - a twin whose original is itself about reading MeTTa text says so on a
 *     comment line `// reads MeTTa text: <why>`, and only such a twin hands
 *     the engine MeTTa text through any of: a text door called on the engine
 *     or a space it made, whatever the argument, and on anything else with a
 *     string; one of the ambient tier's doors or lint called by its imported
 *     name; the Engine's read; a reader head, parse, sread, parse-command,
 *     trace-source or observe-source, asked through an `fn` door with
 *     anything, or built with `S` around a string; and a string holding a
 *     MeTTa definition, a type declaration or a `!` form anywhere but inside
 *     an assertion, where it is a value compared, or the twin's DIVERGENCE
 *     export, where it is a stored atom as the engine prints it [tested 2026-09-26T17:54:50+10:00:
 *     tools/examples/lane.test.ts, "scans a twin for MeTTa text however it
 *     reaches the engine"]
 *   - a program imports tsmetta, node:* and files in its own `_fixtures/`
 *     statically, and any other package only through `import(...)` inside the
 *     receiver of a `.catch` whose handler calls `process.exit`, the guard
 *     that tells a reader what to install; a specifier `import(...)` computes
 *     is a finding, since nothing can say what it loads [tested 2026-09-26T17:54:50+10:00:
 *     tools/examples/lane.test.ts, "holds a program to tsmetta, node:* and
 *     its own fixtures"]
 */
import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parse, parseExpressionAt } from "acorn";
import * as tsmetta from "tsmetta";
import { MeTTa, fnHead, mettaName, tsName } from "tsmetta";

/** The names a function's own code gives its parameters, read with acorn. */
function parameterNames(code: string): string[] {
  const open = code.indexOf("(");
  let depth = 0;
  let close = open;
  for (; close < code.length; close++) {
    if (code[close] === "(") depth++;
    else if (code[close] === ")" && --depth === 0) break;
  }
  const arrow = parseExpressionAt(`(${code.slice(open + 1, close)}) => 0`, 0, {
    ecmaVersion: "latest",
  }) as unknown as { params: Node[] };
  return arrow.params.map((param) => {
    const bound = param.type === "AssignmentPattern" ? (param["left"] as Node) : param;
    return nameOf(bound.type === "RestElement" ? (bound["argument"] as Node) : bound) ?? "";
  });
}

/**
 * The MeTTa methods that take MeTTa SOURCE TEXT rather than a term, read off
 * the class: each names that parameter `source`. The ambient tier's free
 * functions are the same doors under the same names.
 */
const SOURCE_DOORS = new Set(
  Object.getOwnPropertyNames(MeTTa.prototype).filter((name) => {
    const value = Object.getOwnPropertyDescriptor(MeTTa.prototype, name)?.value as unknown;
    return (
      name !== "constructor" &&
      typeof value === "function" &&
      parameterNames(Function.prototype.toString.call(value)).includes("source")
    );
  }),
);

/** The free functions a program imports from tsmetta that read MeTTa source. */
const READING_FUNCTIONS = new Set([...SOURCE_DOORS, "lint"]);

/**
 * Engine heads that read a string argument as MeTTa source, as the engine
 * spells them: parse and sread [source 2026-09-26T18:00:56+10:00:
 * _runtime/engine/metta/terms.pl:97-98 and _runtime/engine/parser.pl:882-883],
 * parse-command [source 2026-09-26T18:00:56+10:00:
 * _runtime/engine/metta/runtime.pl:276-277], and lib_observe's trace-source
 * and observe-source, which take a program as text [source
 * 2026-09-26T18:00:56+10:00: _runtime/lib/lib_observe/lib_observe.pl:35 and
 * :55].
 */
const READER_HEADS = new Set(["parse", "sread", "parse-command", "trace-source", "observe-source"]);

/**
 * A string holding a MeTTa program's own forms: a definition, a type
 * declaration or a `!` form, which no regular expression, grammar input or
 * printed answer begins with.
 */
const PROGRAM_TEXT = /^\s*(?:\((?:=|:)\s|!\()/;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The map each naming factory reads an attribute or a bracketed name
 * through; a call, `S("x")`, is exact for every factory. A factory's member
 * names an engine head, never one of the SOURCE_DOORS.
 */
const HEAD = { S: mettaName, V: (key: string) => key, fn: fnHead } as const;

type Factory = keyof typeof HEAD;

/**
 * The operator words, `mul` for `*` and `gte` for `>=`: the names tsmetta
 * exports whose fn head is not their casing-map image, read from the package
 * so a word it adds is a candidate here without an edit.
 */
const WORDS = Object.keys(tsmetta).filter((name) => fnHead(name) !== mettaName(name));

/**
 * Names no attribute or bracket reaches, because the factory answers them as
 * undefined: `then`, which would make the factory thenable.
 */
const UNREACHABLE = new Set(["then"]);

/**
 * The attribute that reaches the atom this exact name spells, if one does:
 * the name itself, an operator word, or its camelCase image, in that order,
 * so `pow-math` is `fn.pow` rather than `fn.powMath`, which reaches it too.
 */
export function attributeFor(factory: Factory, name: string): string | undefined {
  return [name, ...WORDS, tsName(name)].find(
    (attribute) =>
      IDENTIFIER.test(attribute) &&
      !UNREACHABLE.has(attribute) &&
      HEAD[factory](attribute) === name,
  );
}

/**
 * The naming factory a node is: `S`, `V` or `fn` by name, or the asking door
 * `fn` as a member of an engine or a space, which spells heads by `fnHead`.
 */
function factoryOf(node: Node): Factory | undefined {
  const name = nameOf(node);
  if (name === "S" || name === "V" || name === "fn") return name;
  const asking =
    node.type === "MemberExpression" &&
    node["computed"] !== true &&
    nameOf(node["property"] as Node) === "fn";
  return asking ? "fn" : undefined;
}

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

function children(node: Node): Node[] {
  const out: Node[] = [];
  for (const value of Object.values(node)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (item !== null && typeof item === "object" && typeof (item as Node).type === "string") {
        out.push(item as Node);
      }
    }
  }
  return out;
}

function text(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Literal" && typeof node["value"] === "string") return node["value"];
  if (node.type === "TemplateLiteral") {
    const quasis = node["quasis"] as { value: { cooked: string } }[];
    return quasis.map((quasi) => quasi.value.cooked).join("${}");
  }
  return undefined;
}

/** The argument of `G(...)`, the grounding call a string crosses as text through. */
function groundedText(node: Node | undefined): Node | undefined {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node["callee"] as Node;
  return callee.type === "Identifier" && callee["name"] === "G"
    ? (node["arguments"] as Node[])[0]
    : undefined;
}

function nameOf(node: Node | undefined): string | undefined {
  if (node?.type === "Identifier") return node["name"] as string;
  return undefined;
}

const FROM_TSMETTA = /^tsmetta(\/|$)/;

/**
 * A declaration's value as written, through `await` and tsc's `using` helper;
 * acorn writes a declaration with no value as null.
 */
function unwrapped(node: Node | null | undefined): Node | undefined {
  if (node === null || node === undefined) return undefined;
  if (node.type === "AwaitExpression") return unwrapped(node["argument"] as Node);
  if (
    node.type === "CallExpression" &&
    nameOf(node["callee"] as Node) === "__addDisposableResource"
  ) {
    return unwrapped((node["arguments"] as Node[])[1]);
  }
  return node;
}

/** What a value that came from tsmetta is, as far as its reader doors care. */
type Held = "surface" | "engine";

/** The names this module imports from tsmetta's modules, local name to exported name. */
function tsmettaImports(tree: Node): Map<string, string> {
  const imports = new Map<string, string>();
  for (const node of tree["body"] as Node[]) {
    if (
      node.type !== "ImportDeclaration" ||
      !FROM_TSMETTA.test(String((node["source"] as Node)["value"]))
    ) {
      continue;
    }
    for (const specifier of node["specifiers"] as Node[]) {
      const local = nameOf(specifier["local"] as Node);
      const imported = nameOf(specifier["imported"] as Node | undefined);
      if (local !== undefined && imported !== undefined) imports.set(local, imported);
    }
  }
  return imports;
}

/**
 * What each expression of this module holds of tsmetta: `metta()` and
 * `new MeTTa()` make a surface, so do a surface's `space(...)` and `self` and
 * any name bound to one, `this` in a definition is its space, and a surface's
 * `engine` is the Engine. Anything else, a zod schema's `parse` or a SQLite
 * statement's `run`, holds nothing.
 */
function heldBy(
  tree: Node,
  imports: Map<string, string>,
): (node: Node | undefined) => Held | undefined {
  const names = new Map<string, Held>();
  const held = (node: Node | undefined): Held | undefined => {
    const value = unwrapped(node);
    if (value === undefined) return undefined;
    if (value.type === "ThisExpression") return "surface";
    if (value.type === "Identifier") return names.get(nameOf(value) ?? "");
    if (value.type === "CallExpression" || value.type === "NewExpression") {
      const maker = imports.get(nameOf(value["callee"] as Node) ?? "");
      if (maker === "metta" || maker === "MeTTa") return "surface";
    }
    const member = value.type === "CallExpression" ? (value["callee"] as Node) : value;
    if (member.type !== "MemberExpression" || member["computed"] === true) return undefined;
    if (held(member["object"] as Node) !== "surface") return undefined;
    const property = nameOf(member["property"] as Node);
    if (property === "engine" && value === member) return "engine";
    return (property === "space" && value !== member) || (property === "self" && value === member)
      ? "surface"
      : undefined;
  };
  // Every name the module binds, by declaration or by assignment: tsc
  // compiles a top-level `using m = ...` to `var m;` and a later `m = ...`.
  const bindings: [string, Node | undefined][] = [];
  const work: Node[] = [tree];
  while (work.length > 0) {
    const node = work.pop() as Node;
    work.push(...children(node));
    const [target, value] =
      node.type === "VariableDeclarator"
        ? [node["id"], node["init"]]
        : node.type === "AssignmentExpression" && node["operator"] === "="
          ? [node["left"], node["right"]]
          : [undefined, undefined];
    const name = nameOf(target as Node | undefined);
    if (name !== undefined) bindings.push([name, value as Node | undefined]);
  }
  // A binding can name an earlier binding, so settle them all.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, value] of bindings) {
      const kind = held(value);
      if (kind !== undefined && names.get(name) !== kind) {
        names.set(name, kind);
        changed = true;
      }
    }
  }
  return held;
}

/**
 * The engine head an asked or built call reaches, with the factory it went
 * through: `fn.traceSource(...)`, `m.fn["parse-command"](...)`, `S.parse(...)`
 * and `m.fn("sread")(...)` alike.
 */
function headOf(callee: Node): { factory: Factory; head: string } | undefined {
  if (callee.type === "MemberExpression") {
    const factory = factoryOf(callee["object"] as Node);
    if (factory === undefined || factory === "V") return undefined;
    const name =
      callee["computed"] === true
        ? text(callee["property"] as Node)
        : nameOf(callee["property"] as Node);
    return name === undefined ? undefined : { factory, head: HEAD[factory](name) };
  }
  if (callee.type === "CallExpression") {
    const factory = factoryOf(callee["callee"] as Node);
    const name = text((callee["arguments"] as Node[])[0]);
    return factory === undefined || factory === "V" || name === undefined
      ? undefined
      : { factory, head: name };
  }
  return undefined;
}

/** Whether an assertion encloses a node: there a string is a value compared. */
function assertionRanges(tree: Node): (node: Node) => boolean {
  const ranges: [number, number][] = [];
  const work: Node[] = [tree];
  while (work.length > 0) {
    const node = work.pop() as Node;
    work.push(...children(node));
    if (node.type !== "CallExpression") continue;
    const callee = node["callee"] as Node;
    const root = callee.type === "MemberExpression" ? (callee["object"] as Node) : callee;
    if (nameOf(root) === "assert") ranges.push([node.start, node.end]);
  }
  return (node) => ranges.some(([start, end]) => start <= node.start && node.end <= end);
}

/**
 * Whether the module's `export const DIVERGENCE = ...` encloses a node: there
 * a string is a stored atom as the engine prints it, which the lane compares.
 */
function declarationRange(tree: Node): (node: Node) => boolean {
  const declared = (tree["body"] as Node[]).find((node) => {
    const declaration = node["declaration"] as Node | null | undefined;
    return (
      node.type === "ExportNamedDeclaration" &&
      declaration?.type === "VariableDeclaration" &&
      (declaration["declarations"] as Node[]).some(
        (declarator) => nameOf(declarator["id"] as Node) === "DIVERGENCE",
      )
    );
  });
  return (node) =>
    declared !== undefined && declared.start <= node.start && node.end <= declared.end;
}

/**
 * Whether a program may import a specifier statically: tsmetta and its
 * subpaths, Node's own modules, and a file in the program's own `_fixtures/`.
 */
function importable(source: string, specifier: string): boolean {
  if (FROM_TSMETTA.test(specifier) || specifier.startsWith("node:")) return true;
  if (!specifier.startsWith(".")) return false;
  const fixtures = resolve(dirname(source), "_fixtures");
  const within = relative(fixtures, resolve(dirname(source), specifier));
  return within !== "" && !within.startsWith("..") && !within.startsWith("/");
}

/**
 * The ranges of every `.catch(handler)` receiver whose handler calls
 * `process.exit`, so an `import(...)` inside one is the guarded load of an
 * optional package.
 */
function guardedRanges(tree: Node): (node: Node) => boolean {
  const exits = (node: Node): boolean => {
    const work: Node[] = [node];
    while (work.length > 0) {
      const next = work.pop() as Node;
      work.push(...children(next));
      const callee = next.type === "CallExpression" ? (next["callee"] as Node) : undefined;
      if (
        callee?.type === "MemberExpression" &&
        nameOf(callee["object"] as Node) === "process" &&
        nameOf(callee["property"] as Node) === "exit"
      ) {
        return true;
      }
    }
    return false;
  };
  const ranges: [number, number][] = [];
  const work: Node[] = [tree];
  while (work.length > 0) {
    const node = work.pop() as Node;
    work.push(...children(node));
    if (node.type !== "CallExpression") continue;
    const callee = node["callee"] as Node;
    const handler = (node["arguments"] as Node[])[0];
    if (
      callee.type === "MemberExpression" &&
      callee["computed"] !== true &&
      nameOf(callee["property"] as Node) === "catch" &&
      handler !== undefined &&
      exits(handler)
    ) {
      const receiver = callee["object"] as Node;
      ranges.push([receiver.start, receiver.end]);
    }
  }
  return (node) => ranges.some(([start, end]) => start <= node.start && node.end <= end);
}

/**
 * The packages a source names in a whole `import type` declaration, which
 * tsc drops and so the compiled program never shows. The declaration's
 * grammar is `import type <clause> from "<specifier>"`, so the specifier is
 * the first string after the first `from`. Under verbatimModuleSyntax tsc
 * drops `import type { A } from "x"` and keeps `import { type B } from "x"`
 * as `import {} from "x"`, which the compiled scan sees [tested
 * 2026-09-26T17:34:03+10:00: tsc 7.0.2 on a two-line probe module].
 */
function typeOnlyImports(written: string): { specifier: string; at: number }[] {
  return [...written.matchAll(/^import\s+type\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((match) => ({
    specifier: match[1] ?? "",
    at: match.index,
  }));
}

/** Every finding for one program: its TypeScript source and its compiled program. */
export function scan(source: string, program: string): string[] {
  const written = readFileSync(source, "utf8");
  const readsText = /^\s*\/\/ reads MeTTa text: \S/m.test(written);
  const findings: string[] = [];
  if (written.includes("Generated by tools/generate_language.ts")) {
    findings.push("the file carries the generator's mark; a twin is written by hand");
  }
  for (const { specifier, at } of typeOnlyImports(written)) {
    if (!importable(source, specifier)) {
      findings.push(
        `line ${String(written.slice(0, at).split("\n").length)} of the source: imports types from ${specifier}; a program names only tsmetta, node:* and its own _fixtures/`,
      );
    }
  }
  const compiled = readFileSync(program, "utf8");
  const lineOf = (at: number): number => compiled.slice(0, at).split("\n").length;
  const tree = parse(compiled, {
    ecmaVersion: "latest",
    sourceType: "module",
  }) as unknown as Node;
  const imports = tsmettaImports(tree);
  const held = heldBy(tree, imports);
  const asserted = assertionRanges(tree);
  const declares = declarationRange(tree);
  const guarded = guardedRanges(tree);
  /** The calls a reading finding named, whose strings are not reported again. */
  const read: Node[] = [];
  const reading = (node: Node, finding: string): void => {
    read.push(node);
    if (!readsText) findings.push(`line ${String(lineOf(node.start))}: ${finding}`);
  };
  const strings: Node[] = [];
  const work: Node[] = [tree];
  while (work.length > 0) {
    const node = work.pop() as Node;
    work.push(...children(node));
    if (text(node) !== undefined) strings.push(node);
    const from =
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
        ? (node["source"] as Node | null)?.["value"]
        : undefined;
    if (typeof from === "string" && !importable(source, from)) {
      findings.push(
        `line ${String(lineOf(node.start))}: imports ${from}; a program imports only tsmetta, node:* and its own _fixtures/, and loads any other package through a guarded import(...)`,
      );
    }
    if (node.type === "ImportExpression") {
      const specifier = text(node["source"] as Node);
      if (specifier === undefined) {
        findings.push(
          `line ${String(lineOf(node.start))}: import(...) of a computed specifier, which no reader can know to install`,
        );
      } else if (!importable(source, specifier) && !guarded(node)) {
        findings.push(
          `line ${String(lineOf(node.start))}: import(${JSON.stringify(specifier)}) is not guarded; load it inside a .catch that names what to install and exits`,
        );
      }
    }
    if (node.type === "ImportDeclaration") {
      if (from === "node:assert" || from === "assert") {
        findings.push(
          `line ${String(lineOf(node.start))}: import node:assert/strict, whose equal is ===, not the loose module`,
        );
      }
    }
    if (node.type === "TaggedTemplateExpression") {
      const tag = node["tag"] as Node;
      if (tag.type === "MemberExpression" && nameOf(tag["property"] as Node) === "load") {
        reading(node, "m.load`...` reads MeTTa source text; build the terms instead");
      }
    }
    if (node.type === "CallExpression") {
      const callee = node["callee"] as Node;
      const args = node["arguments"] as Node[];
      const first = text(args[0]);
      if (callee.type === "MemberExpression" && callee["computed"] !== true) {
        const door = nameOf(callee["property"] as Node) ?? "";
        const object = callee["object"] as Node;
        const engineHead = factoryOf(object) !== undefined;
        const holds = held(object);
        if (
          SOURCE_DOORS.has(door) &&
          !engineHead &&
          (holds === "surface" || (first !== undefined && nameOf(object) !== "JSON"))
        ) {
          reading(node, `.${door}(...) is handed MeTTa source text; build the terms instead`);
        }
        if (door === "read" && holds === "engine") {
          reading(
            node,
            ".read(...) is the Engine's reader, handed MeTTa source text; build the terms instead",
          );
        }
        if (door === "loadFile" && first !== undefined && !first.includes("/_fixtures/")) {
          findings.push(
            `line ${String(lineOf(node.start))}: loadFile reads ${first}, which is not a fixture the original imports`,
          );
        }
      }
      const bare = imports.get(nameOf(callee) ?? "");
      if (bare !== undefined && READING_FUNCTIONS.has(bare)) {
        reading(
          node,
          `${nameOf(callee) ?? bare}(...) reads MeTTa source text; build the terms instead`,
        );
      }
      // A reader head asked through fn reads whatever it is handed; built
      // with S it is a term, the reader's only when a string goes in.
      const reached = headOf(callee);
      const handed = args.some(
        (arg) => text(arg) !== undefined || text(groundedText(arg)) !== undefined,
      );
      if (
        reached !== undefined &&
        READER_HEADS.has(reached.head) &&
        (reached.factory === "fn" || handed)
      ) {
        reading(
          node,
          `the reader head ${compiled.slice(callee.start, callee.end)} is handed MeTTa text; only a twin of a reading example may`,
        );
      }
      const factory = factoryOf(callee);
      if (factory !== undefined && first !== undefined) {
        const spelled = compiled.slice(callee.start, callee.end);
        const attribute = attributeFor(factory, first);
        if (attribute !== undefined) {
          findings.push(
            `line ${String(lineOf(node.start))}: ${spelled}(${JSON.stringify(first)}) is ${spelled}.${attribute}`,
          );
        } else if (factory !== "V" && HEAD[factory](first) === first && !UNREACHABLE.has(first)) {
          findings.push(
            `line ${String(lineOf(node.start))}: ${spelled}(${JSON.stringify(first)}) is the bracket door ${spelled}[${JSON.stringify(first)}]; the call door is for a name the map would change`,
          );
        }
      }
    }
    if (node.type === "MemberExpression" && node["computed"] === true) {
      const object = node["object"] as Node;
      const factory = factoryOf(object);
      const key = text(node["property"] as Node);
      if (factory === "S" && key?.startsWith("&") === true) {
        findings.push(
          `line ${String(lineOf(node.start))}: S[${JSON.stringify(key)}] names a space as a symbol; the handle is the space (m.self, this, or a Space held in a const)`,
        );
      }
      if (factory !== undefined && key !== undefined) {
        // A bracketed name goes through the factory's map as an attribute
        // does, so `fn["mul"]` is `fn.mul`, which is `*`.
        const attribute = attributeFor(factory, HEAD[factory](key));
        if (attribute !== undefined) {
          const spelled = compiled.slice(object.start, object.end);
          findings.push(
            `line ${String(lineOf(node.start))}: ${spelled}[${JSON.stringify(key)}] is ${spelled}.${attribute}`,
          );
        }
      }
    }
  }
  // A program's own forms written as a string reach the engine however they
  // travel, a file written and read back included, unless an assertion
  // compares them or a reading finding above already named the call.
  for (const node of strings) {
    const value = text(node) ?? "";
    const within = (call: Node): boolean => call.start <= node.start && node.end <= call.end;
    if (
      !PROGRAM_TEXT.test(value) ||
      asserted(node) ||
      declares(node) ||
      read.some(within) ||
      readsText
    ) {
      continue;
    }
    findings.push(
      `line ${String(lineOf(node.start))}: the string ${JSON.stringify(value.slice(0, 40))} is a MeTTa program; build the terms instead`,
    );
  }
  return findings;
}
