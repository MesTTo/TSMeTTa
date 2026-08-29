/**
 * Purpose: diagnostics over declarations, equations and calls, without running
 *   any of them.
 * Assumes:
 *   - `m.forms(source)` reads every top-level form without compiling, storing
 *     or evaluating one, so linting a file changes nothing anywhere
 * Guarantees:
 *   - a lint pass performs no write and no reduction: it reads forms and, when
 *     given a space, the atoms already in it [tested: "changes nothing it
 *     looks at"]
 *   - an exact `; metta: ok(rule)` comment on the line before a form suppresses
 *     exactly that rule on exactly that form, so a deliberate shape is
 *     annotated once rather than the rule being turned off everywhere
 *     [tested: "an ok comment suppresses only its own rule"]
 * Decides: five rules, each one a question a reader would ask of the source
 *   anyway. It is not a type checker: the engine has one, and a linter that
 *   guessed at types would disagree with it.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, Sym, Var } from "./atom.ts";
import { alphaKey, isGround } from "./matching.ts";
import type { Form, MeTTa } from "./metta.ts";
import { showsAs } from "./present.ts";
import type { Space } from "./space.ts";

/** Which question a finding answers. */
export type Rule =
  | "unknown-head"
  | "arity-disagreement"
  | "duplicate-equation"
  | "unused-variable"
  | "undeclared-type";

/** Every rule this linter carries. */
export const RULES: readonly Rule[] = Object.freeze([
  "unknown-head",
  "arity-disagreement",
  "duplicate-equation",
  "unused-variable",
  "undeclared-type",
]);

/** One thing worth saying about one form. */
export class Finding {
  /** Which rule found it. */
  readonly rule: Rule;
  /** Which form, counting from one, in the source's own order. */
  readonly form: number;
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** The form's own source text. */
  readonly text: string;

  constructor(rule: Rule, form: number, message: string, text: string) {
    this.rule = rule;
    this.form = form;
    this.message = message;
    this.text = text;
    Object.freeze(this);
  }

  toString(): string {
    return `form ${String(this.form)}: ${this.rule}: ${this.message}`;
  }

  /** The wire shape, so a finding survives a structured log or a CI report. */
  toJSON(): { rule: Rule; form: number; message: string; text: string } {
    return { rule: this.rule, form: this.form, message: this.message, text: this.text };
  }
}

showsAs(Finding.prototype, (finding: Finding) => finding.toString());

/** What `lint` accepts beside the source. */
export interface LintOptions {
  /** A space whose existing definitions count as declared. */
  readonly space?: Space;
  /** Which rules to run. All of them by default. */
  readonly rules?: readonly Rule[];
}

function headOf(atom: Atom): Sym | undefined {
  if (!(atom instanceof Expression) || atom.items.length === 0) return undefined;
  const head = atom.items[0];
  return head instanceof Sym ? head : undefined;
}

function isEquation(atom: Atom): atom is Expression {
  return headOf(atom)?.name === "=" && (atom as Expression).items.length === 3;
}

function isDeclaration(atom: Atom): atom is Expression {
  return headOf(atom)?.name === ":" && (atom as Expression).items.length === 3;
}

/** Every named variable in a term, with how many times it appears. */
function variableCounts(atom: Atom): Map<string, number> {
  const counts = new Map<string, number>();
  const stack: Atom[] = [atom];
  while (stack.length > 0) {
    const node = stack.pop() as Atom;
    if (node instanceof Var) {
      if (node.name !== "_") counts.set(node.name, (counts.get(node.name) ?? 0) + 1);
      continue;
    }
    if (node instanceof Expression) stack.push(...node.items);
  }
  return counts;
}

/** Every call in a term, head first, so a body's callees are visible. */
function* calls(atom: Atom): Generator<Expression> {
  const stack: Atom[] = [atom];
  while (stack.length > 0) {
    const node = stack.pop() as Atom;
    if (!(node instanceof Expression)) continue;
    if (headOf(node) !== undefined) yield node;
    stack.push(...node.items);
  }
}

/** The rules a `; metta: ok(rule)` line before a form turns off for it. */
function suppressed(source: string, form: Form): ReadonlySet<Rule> {
  const at = source.indexOf(form.text);
  if (at < 0) return new Set();
  const before = source.slice(0, at).split("\n");
  // The line immediately before the form, and nothing further back: an
  // annotation binds to what it sits above.
  const line = before[before.length - 2] ?? "";
  const found = new Set<Rule>();
  for (const match of line.matchAll(/metta:\s*ok\(([a-z-]+)\)/g)) {
    const rule = match[1] as Rule;
    if (RULES.includes(rule)) found.add(rule);
  }
  return found;
}

/**
 * Diagnose some MeTTa source.
 *
 * ```ts
 * for (const finding of await lint(m, source)) console.log(String(finding));
 * ```
 *
 * Nothing is run, nothing is stored, and nothing in the space changes. A space
 * given in the options only widens what counts as declared: a head it already
 * defines is not unknown.
 */
export async function lint(
  surface: MeTTa,
  source: string,
  options: LintOptions = {},
): Promise<Finding[]> {
  const wanted = new Set(options.rules ?? RULES);
  const forms = surface.forms(source);
  const findings: Finding[] = [];

  // What this source declares, gathered before anything is judged, so a
  // function defined after its first call is not reported as unknown.
  const defined = new Map<string, Set<number>>();
  const declared = new Set<string>();
  const equations = new Map<string, number>();
  for (const form of forms) {
    if (isEquation(form.atom)) {
      const head = headOf(form.atom.items[1] as Atom);
      if (head !== undefined) {
        const arity = ((form.atom.items[1] as Expression).items.length) - 1;
        const arities = defined.get(head.name) ?? new Set<number>();
        arities.add(arity);
        defined.set(head.name, arities);
      }
    }
    if (isDeclaration(form.atom)) {
      const subject = form.atom.items[1];
      if (subject instanceof Sym) declared.add(subject.name);
    }
  }
  if (options.space !== undefined) {
    for await (const atom of options.space.atoms()) {
      if (isEquation(atom)) {
        const head = headOf(atom.items[1] as Atom);
        if (head !== undefined) {
          const arity = (atom.items[1] as Expression).items.length - 1;
          const arities = defined.get(head.name) ?? new Set<number>();
          arities.add(arity);
          defined.set(head.name, arities);
        }
      }
      if (isDeclaration(atom)) {
        const subject = atom.items[1];
        if (subject instanceof Sym) declared.add(subject.name);
      }
    }
  }

  forms.forEach((form, index) => {
    const position = index + 1;
    const off = suppressed(source, form);
    const say = (rule: Rule, message: string): void => {
      if (!wanted.has(rule) || off.has(rule)) return;
      findings.push(new Finding(rule, position, message, form.text));
    };

    if (isEquation(form.atom)) {
      const head = form.atom.items[1] as Atom;
      const body = form.atom.items[2] as Atom;
      const key = alphaKey(form.atom);
      const first = equations.get(key);
      if (first !== undefined) {
        say(
          "duplicate-equation",
          `this equation is the same as form ${String(first)} up to variable naming`,
        );
      } else {
        equations.set(key, position);
      }
      const inHead = variableCounts(head);
      const inBody = variableCounts(body);
      for (const name of inHead.keys()) {
        if (!inBody.has(name)) {
          say(
            "unused-variable",
            `$${name} is bound by the head and never used; write $_ where nothing needs the value`,
          );
        }
      }
      for (const call of calls(body)) {
        const called = headOf(call) as Sym;
        const arity = call.items.length - 1;
        const arities = defined.get(called.name);
        if (arities === undefined) continue;
        if (!arities.has(arity)) {
          say(
            "arity-disagreement",
            `${called.name} is called with ${String(arity)} arguments and defined with ` +
              `${[...arities].sort().join(" or ")}`,
          );
        }
      }
    }

    if (isDeclaration(form.atom)) {
      const type = form.atom.items[2] as Atom;
      for (const named of typeNames(type)) {
        if (declared.has(named) || BUILTIN_TYPES.has(named)) continue;
        say("undeclared-type", `${named} is used as a type and nothing declares it`);
      }
    }

    if (form.kind === "runnable") {
      for (const call of calls(form.atom)) {
        const called = headOf(call) as Sym;
        if (defined.has(called.name) || declared.has(called.name)) continue;
        if (BUILTIN_HEADS.has(called.name) || !isGround(call)) continue;
        say("unknown-head", `nothing here defines ${called.name}`);
        break;
      }
    }
  });
  return findings;
}

/** The types the engine has without anybody declaring them. */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  "Atom",
  "Bool",
  "Expression",
  "Grounded",
  "Number",
  "String",
  "Symbol",
  "Type",
  "Variable",
  "%Undefined%",
  "->",
]);

/**
 * The heads a runnable form may call without this source defining them.
 *
 * Deliberately short: it names the forms a `!` directive is written WITH
 * rather than every builtin the engine has, because a linter that carried the
 * whole list would go stale the first time the engine grew one.
 */
const BUILTIN_HEADS: ReadonlySet<string> = new Set([
  "+", "-", "*", "/", "%", "<", ">", "<=", ">=", "==",
  "and", "or", "not", "if", "let", "let*", "case", "match",
  "add-atom", "remove-atom", "get-atoms", "get-type", "get-metatype", "get-doc",
  "collapse", "superpose", "empty", "quote", "unify", "assertEqual",
  "car-atom", "cdr-atom", "cons-atom", "println!", "trace!",
]);

function typeNames(type: Atom): string[] {
  const found: string[] = [];
  const stack: Atom[] = [type];
  while (stack.length > 0) {
    const node = stack.pop() as Atom;
    if (node instanceof Sym) found.push(node.name);
    else if (node instanceof Expression) stack.push(...node.items);
  }
  return found;
}

/** Lint one file, by path. */
export async function lintFile(
  surface: MeTTa,
  path: string,
  options: LintOptions = {},
): Promise<Finding[]> {
  const { readFileSync } = await import("node:fs");
  return lint(surface, readFileSync(path, "utf8"), options);
}
