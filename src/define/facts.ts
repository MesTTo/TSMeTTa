/**
 * Purpose: what a compiled definition's own source says about itself — where
 *   it is, what it documents, which names it reached, and what it may do.
 * Assumes:
 *   - `lower` is the authority on which names a body could not bind itself:
 *     it must decide that to compile at all, so asking it is the same answer
 *     the equations were built from rather than a second walk that could
 *     disagree with it
 *   - a live function cannot name its own file in this runtime, so a span is
 *     relative to the definition's own text until a caller says where that
 *     text came from
 * Guarantees:
 *   - `definitionFacts` installs nothing and writes nothing: the body is
 *     lowered to find out what it reaches and the term is discarded
 *     [tested: "reads a definition's own facts without defining it"]
 *   - the effect it reports is the join over every head the body reaches, and
 *     that is the WHOLE analysis rather than a part of one: a lowered body can
 *     only act by naming a head, because the lowering refuses every other
 *     statement form, so there is no effect left for a second walk to find
 *     [tested: "joins the effect of every head the body reaches"]
 *   - `pure` is never claimed for a body reaching a head whose effect the
 *     engine does not declare, so nothing is reported purer than it was shown
 *     to be [tested: "does not claim purity for a head it could not resolve"]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type EffectClass, joinEffects } from "../vocabularies.ts";
import { lower } from "./lower.ts";

/**
 * One definition's source coordinates.
 *
 * Relative to the definition's own text by default, because that is what this
 * runtime can recover from a live function. A caller that knows where the text
 * came from says so through `at`, and the coordinates are then absolute.
 */
export interface SourceSpan {
  /** The file, when a caller supplied one. */
  readonly path: string | undefined;
  /** The first line, counting from one. */
  readonly startLine: number;
  /** The column it starts at, counting from zero. */
  readonly startColumn: number;
  /** The last line. */
  readonly endLine: number;
  /** The column after its last character. */
  readonly endColumn: number;
  /** The definition's own text. */
  readonly source: string;
}

/** What one definition's source says about itself. */
export interface DefinitionFacts {
  /** Where it is. */
  readonly span: SourceSpan;
  /** Its first block comment, with the leading stars stripped. */
  readonly doc: string | undefined;
  /** Every name it reached that its own source could not bind, sorted. */
  readonly freeVariables: readonly string[];
  /**
   * The join over the heads whose effect the engine declares.
   *
   * A lower bound, and `unresolved` is what keeps it honest: the engine
   * declares an effect for a registered operation and a builtin, and answers
   * nothing for a head defined by equations, whose effect is its own body's.
   */
  readonly effect: EffectClass;
  /** The heads it reaches that the engine declares no effect for. */
  readonly unresolved: readonly string[];
  /** Whether it was SHOWN structural: every head resolved, and all of them pure. */
  readonly pure: boolean;
}

/** Where a definition's text came from, for a caller that knows. */
export interface SourceOrigin {
  /** The file. */
  readonly path: string;
  /** The line the text starts on there, counting from one. */
  readonly line?: number;
  /** The column the first line starts at, counting from zero. */
  readonly column?: number;
}

/** What a caller may say about a definition this cannot work out for itself. */
export interface FactsOptions {
  /** Where the text came from, which a live function cannot say. */
  readonly at?: SourceOrigin;
  /** The head it installs under, for a body that calls itself. */
  readonly name?: string;
  /** Values it reaches by name that its own source cannot resolve. */
  readonly scope?: Readonly<Record<string, unknown>>;
}

/** What `definitionFacts` needs of an engine: the effect of a head it names. */
export interface EffectSource {
  effectOf(name: string): EffectClass | "unknown";
}

/**
 * Read one function's own facts, without defining it.
 *
 * ```ts
 * const facts = definitionFacts(m, function twice(n) { return n * 2; });
 * facts.freeVariables;   // []
 * facts.effect;          // "pureStructural"
 * ```
 *
 * Nothing is installed and nothing is written: the body is lowered to find out
 * what it reaches and the term is thrown away. A body this cannot lower
 * refuses here exactly as it would at `define`, which is the point — this is
 * how a tool checks a definition before committing to it.
 */
export function definitionFacts(
  engine: EffectSource,
  target: (...args: never[]) => unknown,
  options: FactsOptions = {},
): DefinitionFacts {
  const source = Function.prototype.toString.call(target);
  const lowered = lower(target, {
    selfName: options.name ?? target.name,
    ...(target.name === "" ? {} : { selfIdentifier: target.name }),
    // Every name resolves while reading facts. Refusing would answer nothing
    // about a body that reaches something not yet defined, which is exactly
    // the body a tool asks about.
    knows: () => true,
    ...(options.scope === undefined ? {} : { scope: options.scope as Record<string, never> }),
  });
  // A name the caller supplied through `scope` is a host VALUE rather than a
  // head, so it declares nothing and is not unresolved either.
  const supplied = new Set(Object.keys(options.scope ?? {}));
  const heads = lowered.free.filter((name) => !supplied.has(name));
  const declared: EffectClass[] = [];
  const unresolved: string[] = [];
  for (const name of heads) {
    const held = engine.effectOf(name);
    if (held === "unknown") unresolved.push(name);
    else declared.push(held);
  }
  const effect = joinEffects(...declared);
  return {
    span: spanOf(source, options.at),
    doc: docOf(source),
    freeVariables: lowered.free,
    effect,
    unresolved,
    // `pure` is a CLAIM rather than a measurement, so it is conservative: an
    // unresolved head could do anything, and a body reaching one has not been
    // shown to be pure however pure the rest of it reads.
    pure: effect === "pureStructural" && unresolved.length === 0,
  };
}

/**
 * Where a definition sits, relative to its own text or to where that came from.
 *
 * A function's text begins at its own first character, so the relative span is
 * the whole of it; `at` shifts the first line's column and every line's number
 * to the coordinates the file actually has, which is the same arithmetic a
 * source map does.
 */
export function spanOf(source: string, at?: SourceOrigin): SourceSpan {
  const lines = source.split("\n");
  const last = lines[lines.length - 1] ?? "";
  const firstLine = at?.line ?? 1;
  const firstColumn = at?.column ?? 0;
  return {
    path: at?.path,
    startLine: firstLine,
    startColumn: firstColumn,
    endLine: firstLine + lines.length - 1,
    // Only the FIRST line is shifted by the starting column; every later line
    // begins at the file's own column zero.
    endColumn: lines.length === 1 ? firstColumn + last.length : last.length,
    source,
  };
}

/** A definition's first block comment, with its leading stars stripped. */
export function docOf(source: string): string | undefined {
  const found = /\/\*\*?([\s\S]*?)\*\//.exec(source);
  if (found === null) return undefined;
  const body = (found[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, "").trimEnd())
    .join("\n")
    .trim();
  return body === "" ? undefined : body;
}
