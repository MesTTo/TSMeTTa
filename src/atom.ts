/**
 * Purpose: the atom algebra this surface speaks: one interned, immutable
 *   value per MeTTa atom, narrowing by `instanceof`, printing as MeTTa text,
 *   and ordering by the engine's own standard order of terms.
 * Assumes:
 *   - fork 2 of `ai-typescript-design.md` is ruled YES: atoms are hash-consed,
 *     so `===`, `Set`, `Map` and `Array.prototype.includes` are STRUCTURAL for
 *     atoms without any of them being reimplemented here
 *   - `WeakRef` and `FinalizationRegistry` exist (Node 22), so the intern table
 *     can hold its values weakly and a program that builds a million terms in a
 *     loop does not retain them
 * Guarantees:
 *   - `sym("a") === sym("a")` and `expr(sym("f"), G(1)) === expr(sym("f"), G(1))`
 *     [tested: "makes === structural", "makes Set and Map
 *     structural without either being reimplemented"]
 *   - an atom is frozen: nothing mutates one after it is built, which is what
 *     makes interning sound
 *   - `String(atom)` and a template literal render MeTTa text, while `atom + 1`
 *     and `atom == "f"` REFUSE, because a silent coercion of an atom to a
 *     number or to text is a wrong answer rather than a convenience
 *   - GC visibility is never semantic: the intern table's `FinalizationRegistry`
 *     is cleanup only, and a live atom keeps its own entry alive, so identity
 *     never depends on when a collection happened
 *     [source: ai-typescript-design.md round 13, the Temporal precedent]
 * Owns: the process-wide intern table. It holds every atom weakly.
 * Decides: the standard order is Prolog's, which is the order the engine's own
 *   sort uses: variable, number, symbol, string, compound. A live host value
 *   sorts last, after every term the engine can compare itself.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { MettaError, UnsupportedError, WireError } from "./errors.ts";
import { showsAs } from "./present.ts";

/** Which of the five shapes an atom is. Narrows a union in `switch`. */
export type Kind = "symbol" | "variable" | "grounded" | "expression" | "space";

/** The intern table's key space, one string per structurally distinct atom. */
type InternKey = string;

/**
 * A table whose values are held weakly, so interning does not retain.
 *
 * The textbook hash-cons-with-GC shape: a `WeakRef` per entry plus a
 * `FinalizationRegistry` that removes the entry when its atom is collected.
 * The registry's held value is the `WeakRef` itself, so a cleanup that arrives
 * after the key was re-interned can tell the two apart and leaves the live
 * entry alone.
 */
const table = new Map<InternKey, WeakRef<Atom>>();
const reaper = new FinalizationRegistry<{ key: InternKey; ref: WeakRef<Atom> }>(({ key, ref }) => {
  if (table.get(key) === ref) table.delete(key);
});

let nextId = 1;

/**
 * The mark a worklist puts where an expression closes.
 *
 * A SYMBOL rather than a count in the node stream, because a term in value
 * position can BE a number and a marker a datum could impersonate is a silent
 * wrong answer rather than a refusal. The count rides a second stack beside it.
 */
const CLOSE: unique symbol = Symbol("metta.atom.close");

/**
 * The last `arity` results, as the children of the expression that closes.
 *
 * Popped into a pre-sized array rather than spliced off the tail, which is
 * both an allocation and a move; measured 2026-08-31, `splice` was 60 percent
 * of what a worklist costs over a recursive walk on a shallow term.
 */
function gather(built: Atom[], arity: number): Atom[] {
  const children = new Array<Atom>(arity);
  for (let at = arity - 1; at >= 0; at -= 1) children[at] = built.pop() as Atom;
  return children;
}

function interned<A extends Atom>(key: InternKey, make: () => A): A {
  const hit = table.get(key)?.deref();
  if (hit !== undefined) return hit as A;
  const made = make();
  const ref = new WeakRef<Atom>(made);
  table.set(key, ref);
  reaper.register(made, { key, ref });
  return made;
}

/** How many atoms the intern table currently holds. Diagnostics, never semantics. */
export function internedCount(): number {
  return table.size;
}

const REFUSE_COERCION =
  "an atom does not coerce; render it with String(atom) or ask the engine with m.text(atom)";

/**
 * One MeTTa atom.
 *
 * Every atom is interned and frozen, so two structurally equal atoms are the
 * same object and `===` is the equality a reader expects. The subclasses are
 * the narrowing door: `if (a instanceof Expression)` types `a.items`.
 */
export abstract class Atom {
  /** Which shape this atom is, for a `switch` that must be exhaustive. */
  abstract readonly kind: Kind;

  /** A process-unique number. Keys the intern table for expressions; never semantic. */
  readonly id: number;

  constructor() {
    this.id = nextId;
    nextId += 1;
  }

  /** This atom rendered as MeTTa source text, by this host's own writer. */
  abstract get text(): string;

  toString(): string {
    return this.text;
  }

  toJSON(): string {
    return this.text;
  }

  get [Symbol.toStringTag](): string {
    return `Atom(${this.text})`;
  }

  /**
   * Rendering is allowed; coercion is not.
   *
   * `String(a)` and a template literal ask for text and get it. `a + 1`,
   * `Number(a)` and `a == "f"` ask JavaScript to decide what an atom means as
   * a number or a primitive, and there is no answer to that which is not a
   * wrong one.
   */
  [Symbol.toPrimitive](hint: string): string {
    if (hint === "string") return this.text;
    throw new UnsupportedError(REFUSE_COERCION);
  }
}

// Console honesty: an atom prints as MeTTa text in `console.log` and in
// `util.inspect`, not as a field dump.
showsAs(Atom.prototype, (atom) => atom.text);

/** A MeTTa symbol. The phantom `N` carries its spelling when it is a literal. */
export class Sym<N extends string = string> extends Atom {
  readonly kind: Kind = "symbol";
  readonly name: N;

  /** @internal Use {@link sym}, which interns. */
  constructor(name: N) {
    super();
    this.name = name;
    Object.freeze(this);
  }

  override get text(): string {
    return this.name;
  }
}

/** A MeTTa variable, `$name`. The phantom `N` carries the name. */
export class Var<N extends string = string> extends Atom {
  readonly kind: Kind = "variable";
  readonly name: N;

  /** @internal Use {@link variable} or {@link fresh}. */
  constructor(name: N) {
    super();
    this.name = name;
    Object.freeze(this);
  }

  override get text(): string {
    return `$${this.name}`;
  }
}

/**
 * A host value that IS an atom.
 *
 * A number, a string and a boolean are MeTTa's own grounded values and cross
 * the wire as themselves. Any other JavaScript value crosses by REFERENCE:
 * the engine holds an opaque id and this host holds the object, so the value
 * that comes back is the very same object (`===`), which is the round-trip
 * identity law of the design ledger.
 */
export class Grounded<T = unknown> extends Atom {
  readonly kind: Kind = "grounded";
  readonly value: T;

  /** @internal Use {@link G}. */
  constructor(value: T) {
    super();
    this.value = value;
    // A subclass freezes itself once its own fields are in place; freezing
    // here unconditionally would make {@link FloatAtom} unconstructable.
    if (new.target === Grounded) Object.freeze(this);
  }

  override get text(): string {
    return groundedText(this.value);
  }
}

/**
 * A number that is a MeTTa FLOAT even though its value is a whole number.
 *
 * JavaScript has one number type and MeTTa has two, and the engine tells them
 * apart: `(== 2 2.0)` answers `false`. The crossing therefore has to choose for
 * a whole number, and it chooses the INTEGER, because that is what a reader
 * who wrote `42` meant. This is the other side: `float(42)` is the atom `42.0`,
 * and it is what an engine float decodes back into, so a round trip changes
 * neither the value nor its MeTTa type.
 */
export class FloatAtom extends Grounded<number> {
  /** @internal Use {@link float}. */
  constructor(value: number) {
    super(value);
    Object.freeze(this);
  }

  override get text(): string {
    return floatText(this.value);
  }
}

/** A MeTTa expression, `(f a b)`. Children are atoms, already interned. */
export class Expression extends Atom {
  readonly kind: Kind = "expression";
  readonly items: readonly Atom[];

  /** @internal Use {@link expr}. */
  constructor(items: readonly Atom[]) {
    super();
    this.items = Object.freeze([...items]);
    Object.freeze(this);
  }

  override get text(): string {
    // Written out with an explicit stack rather than by recursing into each
    // child's own getter: a term's depth belongs on the heap, and `String(a)`
    // is on every path a program takes, so a deep answer must be printable.
    // A string on the stack is a literal to emit, an atom is one to render.
    const out: string[] = [];
    const work: (Atom | string)[] = [this];
    while (work.length > 0) {
      const step = work.pop() as Atom | string;
      if (typeof step === "string") {
        out.push(step);
        continue;
      }
      if (step instanceof Expression) {
        out.push("(");
        work.push(")");
        for (let at = step.items.length - 1; at >= 0; at -= 1) {
          work.push(step.items[at] as Atom);
          if (at > 0) work.push(" ");
        }
        continue;
      }
      out.push(step.text);
    }
    return out.join("");
  }

  /** The head, or undefined for `()`. */
  get head(): Atom | undefined {
    return this.items[0];
  }

  /** Everything after the head. */
  get args(): readonly Atom[] {
    return this.items.slice(1);
  }
}

/**
 * A named engine space, by reference.
 *
 * The name is the whole host identity: the store stays in the engine. Two
 * decodes of one name are one handle, because interning turns the name-based
 * identity this has always carried into reference identity as well.
 */
export class SpaceHandle extends Atom {
  readonly kind: Kind = "space";
  readonly name: string;

  /** @internal Use {@link space}; the constructor stays public for the wire tests. */
  constructor(name: string) {
    super();
    if (typeof name !== "string") {
      throw new WireError(`the p tag carries text, not ${JSON.stringify(name)}`);
    }
    if (!name.startsWith("&")) {
      throw new WireError(
        `the p tag carries an ampersand-prefixed space name, not ${JSON.stringify(name)}`,
      );
    }
    this.name = name;
    Object.freeze(this);
  }

  override get text(): string {
    return this.name;
  }
}

// ---------------------------------------------------------------------------
// The builders. Each one interns.

/** The symbol `name`, exactly as spelled. */
export function sym<const N extends string>(name: N): Sym<N> {
  return interned(`s ${name}`, () => new Sym(name));
}

/** The variable `$name`, exactly as spelled. */
export function variable<const N extends string>(name: N): Var<N> {
  return interned(`v ${name}`, () => new Var(name));
}

let freshCount = 0;

/**
 * A variable no source spells, for a pattern a helper writes.
 *
 * Hygiene: a library that builds a pattern around a caller's term must not
 * capture a name the caller happened to use, so it asks for one of these. The
 * separator is a character MeTTa's reader will not produce, so a fresh name
 * cannot collide with one a program wrote.
 */
export function fresh(hint = "g"): Var {
  freshCount += 1;
  return variable(`${hint}__${freshCount}`);
}

/** The named space `&name`. */
export function space(name: string): SpaceHandle {
  return interned(`p ${name}`, () => new SpaceHandle(name));
}

/** A grounded key that tells -0 from 0 and keeps each primitive type apart. */
function primitiveKey(value: unknown): string | undefined {
  switch (typeof value) {
    case "number":
      return Object.is(value, -0) ? "g n -0" : `g n ${String(value)}`;
    case "bigint":
      return `g i ${value.toString()}`;
    case "string":
      return `g t ${value}`;
    case "boolean":
      return `g b ${String(value)}`;
    default:
      return undefined;
  }
}

// A live host value is interned by IDENTITY, which is what makes `G(x) === G(x)`
// for one object and keeps the engine-side handle table one entry per object.
const byReference = new WeakMap<WeakKey, Grounded>();

/**
 * The MeTTa float `value`, whatever its value is.
 *
 * A number with a fraction or an exponent is already a float, so this answers
 * the very atom `G` would; only a whole number needs saying, and for that this
 * is the only door.
 */
export function float(value: number): Grounded<number> {
  if (!Number.isSafeInteger(value) || Object.is(value, -0)) return G(value);
  return interned(`g f ${String(value)}`, () => new FloatAtom(value));
}

/** Lift a host value to an atom: `G(42)`, `G("text")`, `G(new Date())`. */
export function G<T>(value: T): Grounded<T> {
  const key = primitiveKey(value);
  if (key !== undefined) return interned(key, () => new Grounded(value)) as Grounded<T>;
  if (value === null || value === undefined) {
    return interned(`g z ${String(value)}`, () => new Grounded(value)) as Grounded<T>;
  }
  const held = byReference.get(value as WeakKey);
  if (held !== undefined) return held as Grounded<T>;
  const made = new Grounded(value);
  byReference.set(value as WeakKey, made);
  return made;
}

/**
 * The expression of an ARRAY of atoms.
 *
 * The primitive, and the one every builder with a list already in hand should
 * use. `expr(...items)` is the variadic sugar over it, and spreading is a real
 * limit rather than a style preference: `expr(...array)` with two hundred
 * thousand children raises `Maximum call stack size exceeded`, because a
 * spread becomes that many ARGUMENTS [measured 2026-08-27]. A collapse over a
 * long generator produces exactly that.
 */
export function exprOf(items: readonly Atom[]): Expression {
  const key: string[] = ["e"];
  for (const item of items) key.push(String(item.id));
  return interned(key.join(","), () => new Expression(items));
}

/** The expression of these atoms. `expr()` is `()`. */
export function expr(...items: readonly Atom[]): Expression {
  return exprOf(items);
}

// ---------------------------------------------------------------------------
// Term position: what a builder accepts where an atom is wanted.

/**
 * Anything that reads as a term.
 *
 * An ARRAY in term position is an EXPRESSION, everywhere, which is what makes
 * `[S.parent, S.tom, S.bob]` the same atom as `S.parent(S.tom, S.bob)` and a
 * whole program ordinary array code. MeTTa has no array type either: `(1 2 3)`
 * is an expression. Use `G([1, 2, 3])` where the array itself is the datum.
 */
export type Term = Atom | number | bigint | string | boolean | null | undefined | TermList | object;

/** An expression written as an array. An interface, so the recursion closes. */
export interface TermList extends ReadonlyArray<Term> {}

/**
 * The key a callable carries to say which atom it IS.
 *
 * `S.parent` is a function, so that `S.parent(...)` can build an expression,
 * and it is also the symbol `parent`, so that a bare `S.parent` is data. A
 * function is an object, so without this it would ground to a live host
 * reference and `(parent tom bob)` would come out as three JavaScript
 * functions. The key lives here rather than in the factory so that `toAtom`
 * needs no import from it.
 */
export const ATOM_OF: unique symbol = Symbol("metta.atom");

/** Anything carrying its own atom: a name, a defined callable, a space. */
export interface HasAtom {
  readonly [ATOM_OF]: Atom;
}

/** Coerce anything in term position to an atom. */
export function toAtom(value: Term): Atom {
  if (!Array.isArray(value)) return lift(value);
  // An explicit worklist rather than recursion: a term written as a nested
  // array is as deep as the caller wrote it, and depth belongs on the heap.
  const built: Atom[] = [];
  const work: unknown[] = [value];
  const arities: number[] = [];
  while (work.length > 0) {
    const step = work.pop();
    if (step === CLOSE) {
      const arity = arities.pop() as number;
      built.push(exprOf(gather(built, arity)));
      continue;
    }
    if (Array.isArray(step)) {
      const children = step as readonly Term[];
      arities.push(children.length);
      work.push(CLOSE);
      for (let at = children.length - 1; at >= 0; at -= 1) work.push(children[at]);
      continue;
    }
    built.push(lift(step));
  }
  return built[0] as Atom;
}

/**
 * Lift a host VALUE to an atom, reading an array as data rather than as an
 * expression.
 *
 * The difference from {@link toAtom} is one row and it is deliberate. In TERM
 * position an array is an expression, which is what makes `[S.parent, S.tom]`
 * a term. In VALUE position — what a host operation answered, what a provider
 * yielded — an array is the datum, and `[1, 2, 3]` means the array. A callable
 * carrying its own atom is honoured either way, so an operation answering
 * `S.done` answers the SYMBOL and not a live JavaScript function.
 */
export function lift(value: unknown): Atom {
  if (value instanceof Atom) return value;
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    const carried = (value as Partial<HasAtom>)[ATOM_OF];
    if (carried instanceof Atom) return carried;
  }
  return G(value);
}

// ---------------------------------------------------------------------------
// Printing a grounded value.

/**
 * How a caller's own type renders, when it has said.
 *
 * Keyed by the CONSTRUCTOR rather than by a name, so two libraries with one
 * class name do not collide and a renaming refactor carries the registration
 * with it.
 */
const renderings = new Map<Function, (value: never) => string>();

/**
 * Say how a host type renders inside an atom.
 *
 * ```ts
 * registerRepr(Date, (when) => `(date "${when.toISOString()}")`);
 * String(G(new Date(0)));      // (date "1970-01-01T00:00:00.000Z")
 * ```
 *
 * Without one, a live host value renders as `(js Date)`: honest, and useless
 * for reading a query's answers. This is the door that makes it readable
 * without pretending the value has a MeTTa form it does not have.
 */
export function registerRepr<T>(
  constructor: abstract new (...args: never[]) => T,
  render: (value: T) => string,
): void {
  renderings.set(constructor, render as (value: never) => string);
}

/** Forget a rendering. Answers whether one was registered. */
export function unregisterRepr(constructor: abstract new (...args: never[]) => unknown): boolean {
  return renderings.delete(constructor);
}

/** The rendering registered for a value's own constructor, or nothing. */
function registeredText(value: object): string | undefined {
  const own = (value as { constructor?: Function }).constructor;
  const render = own === undefined ? undefined : renderings.get(own);
  return render === undefined ? undefined : render(value as never);
}

/**
 * How a host value reads as MeTTa text.
 *
 * Numbers, strings and booleans have MeTTa spellings and take them; the
 * integer/float split follows the value, so an integral double keeps its
 * point. Anything else is a live host value, and the honest rendering names
 * its constructor rather than pretending it has a MeTTa form.
 */
function groundedText(value: unknown): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      // The engine's own spelling. The reader accepts True and False too and
      // maps both to the same constant, so this is the form they come back as
      // [source: PeTTa@ae66fa8 src/parser.pl:76-78].
      return value ? "true" : "false";
    case "bigint":
      return value.toString();
    case "number":
      // A whole number is the integer it reads as; everything else is a float
      // and keeps its point. Negative zero has meaning only as a float, so it
      // takes the float spelling and its sign survives.
      return Number.isSafeInteger(value) && !Object.is(value, -0)
        ? String(value)
        : floatText(value);
    default:
      break;
  }
  if (value === null) return "(js null)";
  if (value === undefined) return "(js undefined)";
  const registered = registeredText(value as object);
  if (registered !== undefined) return registered;
  const named = value as { constructor?: { name?: string } };
  return `(js ${named.constructor?.name ?? "Object"})`;
}

/** A JavaScript number spelled as a MeTTa FLOAT, whatever its value. */
export function floatText(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  const text = Object.is(value, -0) ? "-0" : String(value);
  if (text.includes(".") || text.includes("e") || text.includes("E")) return text;
  return `${text}.0`;
}

// ---------------------------------------------------------------------------
// The standard order.

const VARIABLE_RANK = 0;
const NUMBER_RANK = 1;
const SYMBOL_RANK = 2;
const TEXT_RANK = 3;
const REFERENCE_RANK = 4;
const SPACE_RANK = 5;
const EXPRESSION_RANK = 6;

function rank(atom: Atom): number {
  if (atom instanceof Grounded) {
    const kind = typeof atom.value;
    if (kind === "number" || kind === "bigint") return NUMBER_RANK;
    if (kind === "string") return TEXT_RANK;
    if (kind === "boolean") return TEXT_RANK;
    return REFERENCE_RANK;
  }
  switch (atom.kind) {
    case "variable":
      return VARIABLE_RANK;
    case "symbol":
      return SYMBOL_RANK;
    case "space":
      return SPACE_RANK;
    default:
      return EXPRESSION_RANK;
  }
}

function compareValues(left: unknown, right: unknown): number {
  if (
    (typeof left === "number" || typeof left === "bigint") &&
    (typeof right === "number" || typeof right === "bigint")
  ) {
    const a = Number(left);
    const b = Number(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function nameOf(atom: Atom): string {
  if (atom instanceof Sym || atom instanceof Var || atom instanceof SpaceHandle) return atom.name;
  return atom.text;
}

/**
 * The engine's own order over atoms, as a comparator.
 *
 * `atoms.sort(byStandardOrder)` where Python writes `sorted(atoms)`: one
 * argument where Python had none, because `Array.prototype.sort` wants a
 * comparator and inventing a default that is not the engine's would be worse.
 * The order is Prolog's standard order of terms, which is the order the engine
 * sorts by: variable, number, symbol, string, compound.
 */
export function byStandardOrder(left: Atom, right: Atom): number {
  // A worklist of PAIRS still to compare, deepest-first, so a term that is
  // deeper than the JavaScript stack still sorts. Children are pushed in
  // reverse, which is what keeps the comparison lexicographic.
  const work: Atom[] = [left, right];
  while (work.length > 0) {
    const b = work.pop() as Atom;
    const a = work.pop() as Atom;
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    if (a instanceof Expression && b instanceof Expression) {
      if (a.items.length !== b.items.length) return a.items.length - b.items.length;
      for (let at = a.items.length - 1; at >= 0; at -= 1) {
        work.push(a.items[at] as Atom, b.items[at] as Atom);
      }
      continue;
    }
    const order =
      a instanceof Grounded && b instanceof Grounded
        ? compareValues(a.value, b.value)
        : nameOf(a) < nameOf(b)
          ? -1
          : nameOf(a) > nameOf(b)
            ? 1
            : 0;
    if (order !== 0) return order;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Walking.

/** Every distinct named variable in a term, in first-seen order. */
export function termVars(atom: Atom): Var[] {
  const seen = new Map<string, Var>();
  const work: Atom[] = [atom];
  while (work.length > 0) {
    const node = work.pop() as Atom;
    if (node instanceof Var) {
      if (node.name !== "_" && !seen.has(node.name)) seen.set(node.name, node);
      continue;
    }
    // Reversed, so the walk stays first-seen order left to right.
    if (node instanceof Expression) {
      for (let at = node.items.length - 1; at >= 0; at -= 1) work.push(node.items[at] as Atom);
    }
  }
  return [...seen.values()];
}

/** Rebuild a term from the leaves upward. */
export function mapTerm(atom: Atom, transform: (leaf: Atom) => Atom): Atom {
  const built: Atom[] = [];
  const work: (Atom | typeof CLOSE)[] = [atom];
  const arities: number[] = [];
  while (work.length > 0) {
    const step = work.pop() as Atom | typeof CLOSE;
    if (step === CLOSE) {
      const arity = arities.pop() as number;
      built.push(exprOf(gather(built, arity)));
      continue;
    }
    if (step instanceof Expression) {
      arities.push(step.items.length);
      work.push(CLOSE);
      for (let at = step.items.length - 1; at >= 0; at -= 1) work.push(step.items[at] as Atom);
      continue;
    }
    built.push(transform(step));
  }
  return built[0] as Atom;
}

/** Substitute variables by name, leaving unmentioned ones alone. */
export function substitute(atom: Atom, bindings: Readonly<Record<string, Term>>): Atom {
  return mapTerm(atom, (leaf) =>
    leaf instanceof Var && Object.hasOwn(bindings, leaf.name)
      ? toAtom(bindings[leaf.name] as Term)
      : leaf,
  );
}
