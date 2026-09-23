/**
 * Purpose: read MeTTa text at the TYPE level, so a query written as a string
 *   gets typed rows and a type declaration written as a string types the
 *   callable it declares.
 * Assumes:
 *   - the technique is the route-parameter one every TypeScript router uses:
 *     recursive template-literal types over a string literal. It types the
 *     variable STRUCTURE and never the answer VALUES, because MeTTa answers
 *     come from runtime rewriting and no type system can evaluate that
 *   - it works on a plain string literal, NOT on a tagged template, because
 *     TypeScript widens a tagged template's text to `string` and the literal is
 *     gone before a type can read it
 * Guarantees:
 *   - quoted and commented dollars do not become query columns
 *     [tested: test/source-row-boundary.test.ts; commit=f43f0466e4ed256f599e6aa56eaa7ed92a9249d9]
 *   - `SourceRow<"(likes Ada $drink)">` is `{ drink: Atom }`, so destructuring
 *     a name the pattern does not bind is a compile error rather than an
 *     `undefined` at run time
 *   - the reader tracks parenthesis depth and string quoting, so a nested
 *     pattern stays one token and a quoted string splits nothing
 * Decides: nothing here has a runtime half. These are types only, erased
 *   entirely, which is what lets them be as elaborate as the checking needs
 *   without costing a byte at run time.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import type { Atom } from "../atom.ts";

/** A complete variable token contributes its name. */
type VariableName<Token extends string> = Token extends `$${infer N}` ? N extends "" ? never : N : never;

/** Scan tokens, keeping strings and line comments opaque to variable discovery. */
type ScanVars<S extends string, Token extends string = "", Found extends string = never,
  Mode extends "plain" | "string" | "comment" = "plain", Escaped extends boolean = false> =
  S extends `${infer C}${infer Rest}`
    ? Mode extends "comment"
      ? ScanVars<Rest, "", Found, C extends "\n" ? "plain" : "comment">
      : Mode extends "string"
        ? Escaped extends true ? ScanVars<Rest, "", Found, "string">
          : C extends "\\" ? ScanVars<Rest, "", Found, "string", true>
          : ScanVars<Rest, "", Found, C extends '"' ? "plain" : "string">
        : C extends '"' ? ScanVars<Rest, "", Found | VariableName<Token>, "string">
          : C extends ";" ? ScanVars<Rest, "", Found | VariableName<Token>, "comment">
          : C extends " " | "\n" | "\r" | "\t" | "(" | ")"
            ? ScanVars<Rest, "", Found | VariableName<Token>>
            : ScanVars<Rest, `${Token}${C}`, Found>
    : Found | VariableName<Token>;

/** Every variable token in source; strings and comments contribute no bindings. */
export type SourceVars<S extends string> = string extends S ? string : ScanVars<S>;

/**
 * The row a source pattern answers.
 *
 * Keys come from the text; values are `Atom`, which is the honest type: what a
 * variable binds to is decided by rewriting at run time, and a type system
 * that claimed to know it would be lying.
 */
export type SourceRow<S extends string> = { [K in Exclude<SourceVars<S>, "_">]: Atom };

// ---------------------------------------------------------------------------
// A real reader, for the places the row alone is not enough.

type Ws = " " | "\n" | "\t";
type TrimL<S extends string> = S extends `${Ws}${infer R}` ? TrimL<R> : S;
type TrimR<S extends string> = S extends `${infer R}${Ws}` ? TrimR<R> : S;
type Trim<S extends string> = TrimR<TrimL<S>>;

type Push<T extends readonly unknown[]> = [...T, unknown];
type Pop<T extends readonly unknown[]> = T extends readonly [unknown, ...infer R] ? R : [];
type Emit<Cur extends string, Acc extends string[]> = Cur extends "" ? Acc : [...Acc, Cur];

/**
 * Split an expression body into its top-level tokens.
 *
 * A parenthesised group stays one token and a quoted string is opaque, so
 * neither its spaces nor its parentheses split anything.
 */
type SplitTop<
  S extends string,
  Cur extends string = "",
  Depth extends readonly unknown[] = [],
  Quoted extends boolean = false,
  Acc extends string[] = [],
> = S extends `${infer C}${infer R}`
  ? C extends '"'
    ? SplitTop<R, `${Cur}"`, Depth, Quoted extends true ? false : true, Acc>
    : Quoted extends true
      ? SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
      : C extends "("
        ? SplitTop<R, `${Cur}(`, Push<Depth>, Quoted, Acc>
        : C extends ")"
          ? SplitTop<R, `${Cur})`, Pop<Depth>, Quoted, Acc>
          : C extends Ws
            ? Depth extends readonly []
              ? SplitTop<R, "", Depth, Quoted, Emit<Cur, Acc>>
              : SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
            : SplitTop<R, `${Cur}${C}`, Depth, Quoted, Acc>
  : Emit<Cur, Acc>;

/** The tokens of a parenthesised term, head first. */
export type Tokens<S extends string> = Trim<S> extends `(${infer Body})` ? SplitTop<Body> : never;

/** The head of a parenthesised term, as a literal. */
export type Head<S extends string> = Tokens<S> extends readonly [infer H extends string, ...string[]]
  ? H
  : never;

/** How many arguments a parenthesised term applies. */
export type Arity<S extends string> = Tokens<S> extends readonly [string, ...infer A]
  ? A["length"]
  : never;

// ---------------------------------------------------------------------------
// Arrow declarations.

/** Every argument type of an arrow declaration, as written. */
export type ArrowArgs<S extends string> = Tokens<S> extends readonly ["->", ...infer Rest]
  ? Rest extends readonly [...infer Args, string]
    ? Args
    : []
  : never;

/** The result type of an arrow declaration, as written. */
export type ArrowResult<S extends string> = Tokens<S> extends readonly ["->", ...infer Rest]
  ? Rest extends readonly [...string[], infer R]
    ? R
    : never
  : never;

/** How many arguments an arrow declaration takes. */
export type ArrowArity<S extends string> = ArrowArgs<S>["length"];

/** Every name a schema declares. */
export type SchemaVars<D> = keyof D & string;

/**
 * A pattern whose argument count disagrees with the arrow that declares it
 * cannot match anything, ever.
 *
 * The message rides IN the type, so the compiler prints it at the call site
 * rather than reporting an unrelated "not assignable to never".
 */
export interface ArityError<H extends string, Got extends number, Want extends number> {
  readonly __mettaArityError: `${H} takes ${Want} argument(s), this gives ${Got}`;
}

/** Check an application against the arrow that declares its head. */
export type CheckArity<
  H extends string,
  Given extends readonly unknown[],
  Declared extends string,
> = Given["length"] extends ArrowArity<Declared>
  ? unknown
  : ArityError<H, Given["length"] & number, ArrowArity<Declared> & number>;
