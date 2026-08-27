/**
 * Purpose: the doors a program says a name through: `S` for symbols, `V` for
 *   variables, `G` for host values, `_` for the anonymous variable, `seg` for
 *   a segment, and `fn` for the operation vocabulary.
 * Assumes:
 *   - ruling 4 of `ai-typescript-design.md`: a TypeScript IDENTIFIER reaches
 *     the meaning layer through TypeScript's own casing, so `fn.carAtom` is
 *     `car-atom`. A name written as TEXT is exact and untouched, which is what
 *     the bracket door and the call door both are.
 * Guarantees:
 *   - the attribute door and the call door mint the SAME atom for a name the
 *     map leaves alone, so `S.parent === S("parent")`
 *   - `S.then` is undefined and nothing else is, because a namespace that
 *     answers `then` is thenable and anything that resolves it would await it
 *   - a name minted here is interned, so `S.tom === S.tom` by construction
 * Decides: `S` and `fn` both apply the map, and `V` does not. A symbol and an
 *   operation are shared VOCABULARY, so each host reaches them through its own
 *   casing and `S["car-atom"]`, `S.carAtom` and `fn.carAtom` are one atom said
 *   three ways. A variable is a local binder with no vocabulary to converge
 *   with, and its name is the key a caller destructures by, so `V.myThing`
 *   binds `myThing` and mapping it would make the pattern and the
 *   destructuring disagree.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  ATOM_OF,
  type Atom,
  type Term,
  Expression,
  type Sym,
  type Var,
  expr,
  exprOf,
  fresh,
  sym,
  toAtom,
  variable,
} from "./atom.ts";
import { mettaName } from "./naming.ts";
import { OPERATOR_HEADS } from "./words.ts";

/** An expression built by applying a name, carrying which name and with what. */
export type Applied<N extends string = string> = Expression & {
  readonly __head?: N;
};

/**
 * A name: use it bare and it is the symbol, call it and it is the expression.
 *
 * `S.parent` is the symbol `parent` and `S.parent(S.tom, S.bob)` is
 * `(parent tom bob)`. That is MeTTa's own reading, where applying a symbol
 * builds an expression and nothing runs until something asks.
 */
export interface Name<N extends string = string> {
  (...args: readonly Term[]): Applied<N>;
  /** The symbol itself, for the places a callable cannot stand. */
  readonly atom: Sym<N>;
  readonly name: N;
  toString(): string;
}

function makeName<N extends string>(spelling: N): Name<N> {
  const head = sym(spelling);
  const applied = (...args: readonly Term[]): Applied<N> =>
    expr(head, ...args.map(toAtom)) as Applied<N>;
  // `name` is a non-writable own property of every function, so it is
  // REDEFINED rather than assigned; Object.assign throws on it in strict mode,
  // which is what an ES module always is.
  return Object.defineProperties(applied, {
    atom: { value: head, enumerable: true },
    [ATOM_OF]: { value: head },
    name: { value: spelling, configurable: true },
    toString: { value: (): string => spelling },
  }) as unknown as Name<N>;
}

/**
 * A namespace that is also callable.
 *
 * The attribute door reads well (`S.parent`) and the call door keeps a literal
 * in the type where a mapped type over `string` would widen it, so
 * `S("parent")` is `Name<"parent">` while `S.parent` is `Name<string>`. Both
 * mint one interned atom.
 */
export interface SymFactory {
  <const N extends string>(spelling: N): Name<N>;
  readonly [key: string]: Name;
}

/** The variable factory, the same shape: `V.x` is `$x`, `V("x")` keeps the literal. */
export interface VarFactory {
  <const N extends string>(spelling: N): Var<N>;
  readonly [key: string]: Var;
}

/** A symbol factory whose declared names carry their spelling, and that still spells any other. */
export type SymbolsOf<Ns extends string> = SymFactory & { readonly [K in Ns]: Name<K> };

/** The variable factory, narrowed the same way. */
export type VarsOf<Ns extends string> = VarFactory & { readonly [K in Ns]: Var<K> };

function factory<T>(mint: (spelling: string) => T, map: (key: string) => string): T &
  ((spelling: string) => T) {
  const of = (spelling: string): T => mint(spelling);
  return new Proxy(of, {
    get(_target, key): T | undefined {
      // A non-string key is never a MeTTa name, and `then` would make the
      // factory thenable, so anything that resolved it would await it.
      return typeof key === "string" && key !== "then" ? of(map(key)) : undefined;
    },
    has(_target, key): boolean {
      return typeof key === "string" && key !== "then";
    },
  }) as T & ((spelling: string) => T);
}

const exact = (key: string): string => key;

/**
 * The ambient symbol factory. Import it and write names; nothing is declared
 * first.
 *
 * The map fires only where it can be right: `S.carAtom` is `car-atom`,
 * `S.parent` is `parent`, and `S.Number`, `S.StateMonad`, `S["%Undefined%"]`,
 * `S["prime?"]` and `S["car-atom"]` are every one of them exactly themselves,
 * because none is a lowerCamelCase identifier. So the attribute door and the
 * bracket door meet at one atom wherever both can spell a name, and the
 * bracket door alone reaches the rest.
 */
export const S: SymFactory = factory(makeName, mettaName) as unknown as SymFactory;

/**
 * The ambient variable factory. Spellings are EXACT.
 *
 * A variable's name is the KEY a caller destructures an answer by, so
 * `for (const { myThing } of m.match(S.p(V.myThing)))` only works while the
 * pattern and the destructuring agree on the spelling. There is also no shared
 * vocabulary to converge with: a variable is a binder local to one pattern.
 */
export const V: VarFactory = factory(
  (spelling: string) => variable(spelling),
  exact,
) as unknown as VarFactory;

/**
 * The operation vocabulary, spelled TypeScript's way.
 *
 * `fn.carAtom` is `car-atom` and `fn.changeState` is `change-state`; a head
 * outside the map is reached exactly through the bracket door,
 * `fn["change-state!"]`, or through `S`. One principle, one map per host:
 * spell the concept the way the host spells it, and casing IS spelling.
 *
 * The OPERATOR words come first, because an operator's engine head is
 * punctuation and no casing map could reach it: `fn.gte` is `>=` and `fn.add`
 * is `+`. Those are the same words the free functions export, which is fork 1
 * option C: one mechanism, two positions.
 */
export const fn: SymFactory = factory(
  makeName,
  (key) => OPERATOR_HEADS[key] ?? mettaName(key),
) as unknown as SymFactory;

/**
 * The anonymous variable: fresh at every occurrence, so two of them constrain
 * nothing.
 *
 * Prolog's own underscore, and ts-pattern's `P._` for the same job, which is
 * why the spelling needs no teaching.
 */
export const _: Var<"_"> = variable("_");

/** A variable no source spells, for a pattern a helper writes. */
export { fresh };

/**
 * A segment variable: one gap standing for a RUN of subterms.
 *
 * `S.div(seg(V.before), S.li(V.x), seg(V.after))` finds an `li` among its
 * siblings WITH its context bound, which the fixed-arity pattern languages
 * approximate and a sequence variable generalises.
 */
export function seg(name: Var | string): Atom {
  return expr(sym(":seg"), typeof name === "string" ? variable(name) : name);
}

/** A raw expression from its items, each read as a term: `e(x, y, x)` is `($x $y $x)`. */
export function e(...items: readonly Term[]): Expression {
  return exprOf(items.map(toAtom));
}

/** The empty expression `()`, MeTTa's conventional nil. */
export function nil(): Expression {
  return expr();
}

/**
 * A Lisp-style cons list: `list([a, b, c])` is `(:: a (:: b (:: c ())))`.
 *
 * MeTTa writes a sequence as an expression and a LIST as this, and the two are
 * different atoms, so the door says which it means.
 */
export function list(items: readonly Term[], options: { cons?: string } = {}): Atom {
  const cons = sym(options.cons ?? "::");
  let tail: Atom = expr();
  for (let i = items.length - 1; i >= 0; i -= 1) {
    tail = expr(cons, toAtom(items[i] as Term), tail);
  }
  return tail;
}
