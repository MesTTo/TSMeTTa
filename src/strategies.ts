/**
 * Purpose: name the rewriting strategies the engine's strategy library
 *   reifies, so a plan is built in TypeScript and stored, queried, serialised
 *   and applied as the ordinary atom it is.
 * Assumes:
 *   - the runtime basis is the engine's own strategy library, imported into a
 *     space before a plan built here is evaluated
 * Guarantees:
 *   - every export is a NAME, so a bare one is the symbol and a called one is
 *     the expression; importing this module starts no engine and registers
 *     nothing [tested: "reifies the strategies without an engine"]
 * Decides: the names are UpperCamelCase. Half of them (`Try`, `All`, `One`,
 *   `Repeat`) collide with a reserved word or with a `Set` and `Array` method
 *   a reader has in mind, and a capitalised head is MeTTa's own mark for a
 *   data CONSTRUCTOR, which is exactly what each of these is: `Seq(a, b)`
 *   builds a plan, it does not run one. The engine's own spellings are the
 *   values, so `String(Try)` is `try` and a MeTTa program reading the stored
 *   plan sees the library's own words.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { S } from "./factories.ts";
import type { Name } from "./factories.ts";

/** The identity strategy: succeeds, changing nothing. */
export const Id: Name<"id"> = S("id");

/** The failing strategy: never succeeds. */
export const Fail: Name<"fail"> = S("fail");

/** Left to right, all of them: `Seq(a, b)` applies `a` then `b`. */
export const Seq: Name<"seq"> = S("seq");

/** The first that succeeds: `Choice(a, b)` tries `a`, then `b`. */
export const Choice: Name<"choice"> = S("choice");

/** `Try(a)` is `Choice(a, Id)`: apply it if it applies. */
export const Try: Name<"try"> = S("try");

/** Apply until it no longer applies. */
export const Repeat: Name<"repeat"> = S("repeat");

/** Apply to every immediate subterm; fails unless all succeed. */
export const All: Name<"all"> = S("all");

/** Apply to exactly one immediate subterm, the first that succeeds. */
export const One: Name<"one"> = S("one");

/** Root first, then downward. */
export const TopDown: Name<"topdown"> = S("topdown");

/** Subterms first, then the root. */
export const BottomUp: Name<"bottomup"> = S("bottomup");

/** Innermost-first normalisation: rewrite until nothing applies anywhere. */
export const Innermost: Name<"innermost"> = S("innermost");

/** Stratego's own `all`, kept under its own name beside the shorter one. */
export const StrategoAll: Name<"stratego-all"> = S("stratego-all");

/** Stratego's own `one`, kept under its own name beside the shorter one. */
export const StrategoOne: Name<"stratego-one"> = S("stratego-one");

/** The type-preserving strategy kind, `TP` in the Stratego literature. */
export const TP: Name<"TP"> = S("TP");

/** The type-unifying strategy kind, `TU` in the Stratego literature. */
export const TU: Name<"TU"> = S("TU");
