/**
 * Purpose: declare value algebras, check their laws over a finite carrier, and
 *   run the one generic tagged-rule form under any of them.
 * Assumes:
 *   - facts and rules rest in a space as ordinary `(fact tag proposition)` and
 *     `(rule tag head (premises ...))` atoms, so a tagged program is DATA and
 *     nothing here invents a second store
 *   - the engine reads an `(algebra ...)` row out of `&metta` for its own
 *     purposes — `top k` is the k best in a context's declared semiring order
 *     — so declaring one here is declaring it to the engine as well
 *     [source: engine/spaces/bounded_matching.pl, metta_top_match/5]
 * Guarantees:
 *   - only laws CHECKED over a finite carrier, or a trusted shipped preset's,
 *     license answer fusion, and the decision is reported rather than assumed
 *     [tested: "fuses only under a law it has checked"]
 *   - a linear algebra refuses the second spend of one premise before it
 *     publishes a derived answer [tested: "refuses the second spend of one
 *     premise"]
 *   - a tagged answer retains its derivation, so `why()` and `under()` cost no
 *     second query [tested: "reinterprets a retained derivation without
 *     asking again"]
 *   - `Amplitude` is EXACT: rational components over bigint, so interference
 *     is not floating-point noise
 * Decides: the reads are asynchronous where the Python original is
 *   synchronous, because reading a space's atoms is asynchronous on this
 *   transport and pretending otherwise would mean draining a cursor behind the
 *   caller's back. Everything that does not read a space — building a tagged
 *   fact, the carriers themselves, the exact arithmetic — stays synchronous.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  G,
  Grounded,
  Sym,
  type Term,
  Var,
  expr,
  substitute,
  sym,
  toAtom,
} from "./atom.ts";
import { MettaError } from "./errors.ts";
import { matchTerms } from "./matching.ts";
import { showsAs } from "./present.ts";
import { Random } from "./random.ts";
import { type Space, hostValue } from "./space.ts";
import type { SemiringOrder } from "./vocabularies.ts";

/** A declaration is incomplete, conflicting, or cannot be certified. */
export class AlgebraDeclarationError extends MettaError {
  static override readonly defaultCode = "ERR_METTA_CAPABILITY" as const;
}

/** A declared law does not hold over the declared carrier. */
export class AlgebraLawError extends AlgebraDeclarationError {}

/** A context does not declare a capability the algebra requires. */
export class AlgebraRequirementError extends AlgebraDeclarationError {}

/** A declared operation answered no value, or more than one. */
export class AlgebraOperationError extends MettaError {
  static override readonly defaultCode = "ERR_METTA_ENGINE" as const;
}

/** A rate tag is not a nonnegative finite number. */
export class RateDeclarationError extends AlgebraDeclarationError {}

/** A linear algebra was asked to spend one premise twice. */
export class LinearEvidenceError extends MettaError {
  static override readonly defaultCode = "ERR_METTA_ENGINE" as const;
}

/** A tagged program exceeded its declared finite evaluation boundary. */
export class AlgebraEvaluationError extends MettaError {
  static override readonly defaultCode = "ERR_METTA_ENGINE" as const;
}

// ---------------------------------------------------------------------------
// Exact arithmetic, for the carriers that need it.

function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a;
  let right = b < 0n ? -b : b;
  while (right !== 0n) [left, right] = [right, left % right];
  return left === 0n ? 1n : left;
}

/**
 * An exact rational.
 *
 * JavaScript has no rational and its `number` is a binary float, so a carrier
 * whose point is that values INTERFERE — where a sixteenth plus a sixteenth
 * must be exactly an eighth — cannot be built on one. This is the smallest
 * thing that can be: a bigint numerator over a bigint denominator, normalised.
 */
export class Rational {
  /** The numerator, sign included. */
  readonly numerator: bigint;
  /** The denominator, always positive. */
  readonly denominator: bigint;

  constructor(numerator: bigint | number, denominator: bigint | number = 1n) {
    let top = BigInt(numerator);
    let bottom = BigInt(denominator);
    if (bottom === 0n) throw new MettaError("a rational cannot have a zero denominator");
    if (bottom < 0n) {
      top = -top;
      bottom = -bottom;
    }
    const divisor = gcd(top, bottom);
    this.numerator = top / divisor;
    this.denominator = bottom / divisor;
    Object.freeze(this);
  }

  /** The sum, exactly. */
  plus(other: Rational): Rational {
    return new Rational(
      this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator,
    );
  }

  /** The product, exactly. */
  times(other: Rational): Rational {
    return new Rational(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  /** The additive inverse. */
  negated(): Rational {
    return new Rational(-this.numerator, this.denominator);
  }

  /** Whether two rationals are the same number. */
  equals(other: Rational): boolean {
    return this.numerator === other.numerator && this.denominator === other.denominator;
  }

  /** The nearest `number`, for a caller that wants an inexact reading. */
  valueOf(): number {
    return Number(this.numerator) / Number(this.denominator);
  }

  toString(): string {
    return this.denominator === 1n
      ? String(this.numerator)
      : `${String(this.numerator)}/${String(this.denominator)}`;
  }
}

/** An exact complex value, with rational real and imaginary components. */
export class Amplitude {
  /** The real component. */
  readonly real: Rational;
  /** The imaginary component. */
  readonly imaginary: Rational;

  constructor(real: Rational | bigint | number, imaginary: Rational | bigint | number = 0n) {
    this.real = real instanceof Rational ? real : new Rational(real);
    this.imaginary = imaginary instanceof Rational ? imaginary : new Rational(imaginary);
    Object.freeze(this);
  }

  /** The sum, exactly. */
  plus(other: Amplitude): Amplitude {
    return new Amplitude(this.real.plus(other.real), this.imaginary.plus(other.imaginary));
  }

  /** The product, exactly. `i * i` is `-1` and nothing rounds. */
  times(other: Amplitude): Amplitude {
    return new Amplitude(
      this.real.times(other.real).plus(this.imaginary.times(other.imaginary).negated()),
      this.real.times(other.imaginary).plus(this.imaginary.times(other.real)),
    );
  }

  /** Whether two amplitudes are the same value. */
  equals(other: Amplitude): boolean {
    return this.real.equals(other.real) && this.imaginary.equals(other.imaginary);
  }

  toString(): string {
    const negative = this.imaginary.numerator < 0n;
    const magnitude = negative ? this.imaginary.negated() : this.imaginary;
    return `${this.real.toString()}${negative ? "-" : "+"}${magnitude.toString()}i`;
  }
}

showsAs(Rational.prototype, (value: Rational) => value.toString());
showsAs(Amplitude.prototype, (value: Amplitude) => value.toString());

// ---------------------------------------------------------------------------
// Laws.

/** One law an algebra may declare, in the catalog's own spelling. */
export type Law =
  | "combine-associative"
  | "combine-commutative"
  | "extend-associative"
  | "extend-commutative"
  | "left-distributive"
  | "right-distributive"
  | "combine-idempotent"
  | "combine-zero-identity"
  | "extend-one-identity"
  | "extend-zero-annihilates"
  | "contraction";

/** The shorthand a declaration may write, and what each expands to. */
const LAW_ALIASES: Readonly<Record<string, readonly Law[]>> = {
  associative: ["combine-associative", "extend-associative"],
  commutative: ["combine-commutative"],
  distributive: ["left-distributive", "right-distributive"],
  idempotent: ["combine-idempotent"],
  contraction: ["contraction"],
};

/** The laws checkable by exhaustion over a finite carrier. */
const EQUATIONAL: ReadonlySet<Law> = new Set<Law>([
  "combine-associative",
  "combine-commutative",
  "extend-associative",
  "extend-commutative",
  "left-distributive",
  "right-distributive",
  "combine-idempotent",
  "combine-zero-identity",
  "extend-one-identity",
  "extend-zero-annihilates",
]);

const KNOWN: ReadonlySet<Law> = new Set<Law>([...EQUATIONAL, "contraction"]);

/** What a semiring promises, and what the shipped presets are trusted for. */
const SEMIRING: readonly Law[] = [
  "combine-associative",
  "combine-commutative",
  "extend-associative",
  "left-distributive",
  "right-distributive",
  "combine-zero-identity",
  "extend-one-identity",
  "extend-zero-annihilates",
  "contraction",
];

function canonicalLaws(laws: Iterable<string>): Set<Law> {
  const out = new Set<Law>();
  for (const law of laws) {
    const expanded = LAW_ALIASES[law] ?? [law as Law];
    for (const each of expanded) {
      if (!KNOWN.has(each)) {
        throw new AlgebraDeclarationError(`algebra_law_unknown(${JSON.stringify(each)})`);
      }
      out.add(each);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A declared algebra.

/** What `declare` accepts. */
export interface AlgebraDeclaration {
  /** The operation that combines ALTERNATIVE derivations of one conclusion. */
  readonly combine: string;
  /** The operation that extends ONE derivation through a premise. */
  readonly extend: string;
  /** The identity of `combine`, and the annihilator of `extend`. */
  readonly zero: Term;
  /** The identity of `extend`. */
  readonly one: Term;
  /** The laws this algebra claims. Checked over `carrier` when finite. */
  readonly laws?: Iterable<string>;
  /** A finite carrier, which is what makes a law checkable at all. */
  readonly carrier?: Iterable<Term>;
  /** Capabilities a context must declare before it may use this algebra. */
  readonly requires?: Iterable<string>;
  /** Which direction counts as best, for `top k` and for ordering answers. */
  readonly order?: SemiringOrder;
}

/**
 * One algebra after law and requirement normalisation.
 *
 * The two operations are named rather than given as functions, because a
 * declaration is DATA: it lands in `&metta` as an `(algebra ...)` row, the
 * engine reads it for its own `top k`, and a MeTTa program can read it too.
 */
export class Algebra {
  /** The algebra's own name, which is how a carrier is spelled. */
  readonly name: string;
  /** The operation combining alternative derivations. */
  readonly combine: string;
  /** The operation extending one derivation through a premise. */
  readonly extend: string;
  /** The identity of `combine`. */
  readonly zero: Atom;
  /** The identity of `extend`. */
  readonly one: Atom;
  /** The laws it claims, expanded from any shorthand. */
  readonly laws: ReadonlySet<Law>;
  /** Its finite checking carrier, empty when it has none. */
  readonly carrier: readonly Atom[];
  /** The capabilities a context must declare to use it. */
  readonly requires: ReadonlySet<string>;
  /** Which direction counts as best, or nothing for an unordered algebra. */
  readonly order: SemiringOrder | undefined;

  /** @internal Built by {@link declare} or read from the catalog. */
  constructor(
    name: string,
    declaration: AlgebraDeclaration & { readonly laws?: Iterable<string> },
  ) {
    this.name = name;
    this.combine = declaration.combine;
    this.extend = declaration.extend;
    this.zero = toAtom(declaration.zero);
    this.one = toAtom(declaration.one);
    this.laws = canonicalLaws(declaration.laws ?? []);
    this.carrier = [...(declaration.carrier ?? [])].map(toAtom);
    this.requires = new Set(declaration.requires ?? []);
    this.order = declaration.order;
    Object.freeze(this);
  }

  /**
   * Apply a declared binary operation, and require exactly one answer.
   *
   * Three paths, in order. Two ground NUMBERS take the host's own arithmetic,
   * because asking the engine to add two numbers is a crossing for something
   * JavaScript already knows. Two exact carriers — a `Rational` or an
   * `Amplitude` — take theirs, which is a divergence from the Python original
   * and the reason the amplitude preset works here rather than only being
   * declarable. Everything else is the ENGINE's, because the operation is a
   * MeTTa head and its meaning belongs there.
   */
  apply(space: Space, operation: string, left: Atom, right: Atom): Atom {
    const exact = applyExactly(operation, left, right);
    if (exact !== undefined) return exact;
    // `plus` and `times` are the provenance carrier's own role names: it
    // builds the term rather than reducing it, because a provenance value IS
    // the shape of its own derivation.
    if (operation === "plus" || operation === "times") {
      return expr(sym(operation), left, right);
    }
    try {
      return space.runOne(expr(sym(operation), left, right));
    } catch (error) {
      throw new AlgebraOperationError(
        `algebra_operation_not_single(${this.name}, ${operation}, ${left.text}, ${right.text})`,
        { cause: error },
      );
    }
  }

  /** Combine alternative derivations of one conclusion. */
  combineValues(space: Space, left: Atom, right: Atom): Atom {
    return this.apply(space, this.combine, left, right);
  }

  /** Extend one derivation through a premise. */
  extendValues(space: Space, left: Atom, right: Atom): Atom {
    return this.apply(space, this.extend, left, right);
  }

  /** The `(algebra ...)` row this declaration is, as data. */
  get atom(): Atom {
    return expr(
      sym("algebra"),
      sym(this.name),
      sym(this.combine),
      sym(this.extend),
      this.zero,
      this.one,
      expr(sym("laws"), ...[...this.laws].sort().map((law) => sym(law))),
      expr(sym("carrier"), ...this.carrier),
      expr(sym("requires"), ...[...this.requires].sort().map((each) => sym(each))),
    );
  }

  toString(): string {
    return `Algebra(${this.name}, ${this.combine}/${this.extend})`;
  }
}

showsAs(Algebra.prototype, (algebra: Algebra) => algebra.toString());

/** The host-side arithmetic, or nothing when the operands are not its business. */
function applyExactly(operation: string, left: Atom, right: Atom): Atom | undefined {
  if (!(left instanceof Grounded) || !(right instanceof Grounded)) return undefined;
  const a = left.value;
  const b = right.value;
  if (a instanceof Amplitude && b instanceof Amplitude) {
    if (operation === "amplitude-add") return G(a.plus(b));
    if (operation === "amplitude-multiply") return G(a.times(b));
    return undefined;
  }
  if (a instanceof Rational && b instanceof Rational) {
    if (operation === "+") return G(a.plus(b));
    if (operation === "*") return G(a.times(b));
    return undefined;
  }
  const numeric =
    (typeof a === "number" || typeof a === "bigint") &&
    (typeof b === "number" || typeof b === "bigint");
  if (!numeric) return undefined;
  const x = Number(a);
  const y = Number(b);
  switch (operation) {
    case "+":
      return G(x + y);
    case "*":
      return G(x * y);
    case "min":
      return G(Math.min(x, y));
    case "max":
      return G(Math.max(x, y));
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// The shipped presets.

function preset(
  name: string,
  combine: string,
  extend: string,
  zero: Term,
  one: Term,
  extra: { laws?: readonly Law[]; requires?: readonly string[]; order?: SemiringOrder } = {},
): Algebra {
  return new Algebra(name, {
    combine,
    extend,
    zero,
    one,
    laws: extra.laws ?? SEMIRING,
    requires: extra.requires ?? [],
    ...(extra.order === undefined ? {} : { order: extra.order }),
  });
}

/**
 * Every algebra this package ships, by name.
 *
 * Each is trusted for the semiring laws rather than checked, because each is a
 * standard structure with a published proof; a declaration a program writes is
 * checked over its own finite carrier instead.
 */
export const PRESETS: Readonly<Record<string, Algebra>> = Object.freeze({
  bool: preset("bool", "max", "*", 0, 1),
  bag: preset("bag", "+", "*", 0, 1),
  counting: preset("counting", "+", "*", 0, 1),
  set: preset("set", "max", "*", 0, 1, { laws: [...SEMIRING, "combine-idempotent"] }),
  ranked: preset("ranked", "max", "*", 0, 1, { order: "descending" }),
  tropical: preset("tropical", "min", "+", sym("infinity"), 0, { order: "ascending" }),
  prob: preset("prob", "+", "*", 0, 1, { order: "descending" }),
  prov: preset("prov", "plus", "times", sym("zero"), sym("one")),
  budget: preset("budget", "min", "+", sym("infinity"), 0, { order: "ascending" }),
  amplitude: preset("amplitude", "amplitude-add", "amplitude-multiply", G(new Amplitude(0n)), G(new Amplitude(1n)), {
    requires: ["finite", "contractive", "staged"],
  }),
});

/** Counting derivations: how many ways a conclusion holds. */
export const counting: Algebra = PRESETS["counting"] as Algebra;
/** The tropical semiring: the cheapest derivation, by cost. */
export const tropical: Algebra = PRESETS["tropical"] as Algebra;
/** Probabilities, best-first. */
export const prob: Algebra = PRESETS["prob"] as Algebra;
/** Provenance: the derivation's own shape, as a term. */
export const prov: Algebra = PRESETS["prov"] as Algebra;
/** Ranking, best-first. */
export const ranked: Algebra = PRESETS["ranked"] as Algebra;

// ---------------------------------------------------------------------------
// The catalog.

/** Anything that names an algebra: the object, its name, or its symbol. */
export type Carrier = Algebra | string | Sym;

function carrierName(carrier: Carrier): string {
  if (carrier instanceof Algebra) return carrier.name;
  if (carrier instanceof Sym) return carrier.name;
  return carrier;
}

/** The algebra one name resolves to here, or nothing. */
export async function algebraOf(catalog: Space, name: string): Promise<Algebra | undefined> {
  const shipped = PRESETS[name];
  if (shipped !== undefined) return shipped;
  return catalogDeclaration(catalog, name);
}

/** The algebra one name resolves to here, or a refusal naming the presets. */
export async function requireAlgebra(catalog: Space, name: string): Promise<Algebra> {
  const found = await algebraOf(catalog, name);
  if (found !== undefined) return found;
  throw new AlgebraDeclarationError(
    `algebra_not_declared(${name}); shipped presets are ${Object.keys(PRESETS).join(", ")}, ` +
      `or declare() may add another`,
  );
}

/** Resolve any carrier spelling against one runtime catalog. */
export async function resolve(catalog: Space, carrier: Carrier): Promise<Algebra> {
  if (carrier instanceof Algebra) {
    const registered = await algebraOf(catalog, carrier.name);
    return registered ?? carrier;
  }
  return requireAlgebra(catalog, carrierName(carrier));
}

function headed(atom: Atom, name: string): atom is Expression {
  return (
    atom instanceof Expression &&
    atom.items.length > 0 &&
    atom.items[0] instanceof Sym &&
    (atom.items[0] as Sym).name === name
  );
}

function namesIn(atom: Atom | undefined, head: string): string[] {
  if (atom === undefined || !headed(atom, head)) return [];
  return atom.items.slice(1).filter((item): item is Sym => item instanceof Sym).map((s) => s.name);
}

async function catalogDeclaration(catalog: Space, name: string): Promise<Algebra | undefined> {
  for await (const atom of catalog.atoms()) {
    if (!headed(atom, "algebra") || atom.items.length !== 9) continue;
    const declared = atom.items[1];
    if (!(declared instanceof Sym) || declared.name !== name) continue;
    const combine = atom.items[2];
    const extend = atom.items[3];
    if (!(combine instanceof Sym) || !(extend instanceof Sym)) {
      throw new AlgebraDeclarationError(`algebra_catalog_operations_malformed(${name})`);
    }
    const carrier = atom.items[7];
    return new Algebra(name, {
      combine: combine.name,
      extend: extend.name,
      zero: atom.items[4] as Atom,
      one: atom.items[5] as Atom,
      laws: namesIn(atom.items[6], "laws"),
      carrier: headed(carrier as Atom, "carrier") ? (carrier as Expression).items.slice(1) : [],
      requires: namesIn(atom.items[8], "requires"),
      ...(await catalogOrder(catalog, name)),
    });
  }
  return undefined;
}

async function catalogOrder(
  catalog: Space,
  name: string,
): Promise<{ order?: SemiringOrder }> {
  for await (const atom of catalog.atoms()) {
    if (!headed(atom, "claim") || atom.items.length < 4) continue;
    const [, semiring, named, ordered] = atom.items;
    if (String(semiring) !== "semiring" || String(named) !== name) continue;
    if (String(ordered) !== "ordered") continue;
    const direction = atom.items[4];
    if (direction === undefined) return { order: "descending" };
    const word = String(direction);
    if (word === "ascending" || word === "descending") return { order: word };
  }
  return {};
}

/**
 * Check one algebra and add its catalog row, without replacing an old one.
 *
 * The laws are checked by EXHAUSTION over the declared carrier before the row
 * lands, so a declaration that does not hold is refused with the
 * counterexample rather than admitted and trusted.
 */
export async function declare(
  space: Space,
  name: string,
  declaration: AlgebraDeclaration,
): Promise<Atom> {
  const catalog = space.catalog;
  if (name === "") throw new AlgebraDeclarationError("algebra_name_must_be_a_nonempty_symbol");
  if ((await algebraOf(catalog, name)) !== undefined) {
    throw new AlgebraDeclarationError(`algebra_already_declared(${name})`);
  }
  if (declaration.combine === "") {
    throw new AlgebraDeclarationError(`algebra_operation_invalid(${name}, combine)`);
  }
  if (declaration.extend === "") {
    throw new AlgebraDeclarationError(`algebra_operation_invalid(${name}, extend)`);
  }
  const algebra = new Algebra(name, declaration);
  // The laws are checked in the SPACE, because a declared operation may be an
  // equation that space holds; the row lands in the catalog, because that is
  // where the engine reads it from.
  validateLaws(space, algebra);
  catalog.add(algebra.atom);
  return algebra.atom;
}

function counterexample(
  algebra: Algebra,
  law: Law,
  inputs: readonly Atom[],
  left: Atom,
  right: Atom,
): AlgebraLawError {
  return new AlgebraLawError(
    `algebra_law_violation(${algebra.name}, ${law}, ` +
      `inputs=[${inputs.map((atom) => atom.text).join(", ")}], ` +
      `left=${left.text}, right=${right.text})`,
  );
}

/** Every law an algebra claims, checked over its own finite carrier. */
export function validateLaws(space: Space, algebra: Algebra): void {
  const equational = [...algebra.laws].filter((law) => EQUATIONAL.has(law)).sort();
  if (equational.length > 0 && algebra.carrier.length === 0) {
    throw new AlgebraLawError(
      `algebra_law_uncheckable(${algebra.name}, laws=[${equational.join(", ")}], ` +
        `reason=finite_carrier_required)`,
    );
  }
  if (equational.length === 0) return;
  for (const operation of [algebra.combine, algebra.extend]) {
    for (const left of algebra.carrier) {
      for (const right of algebra.carrier) {
        const result = algebra.apply(space, operation, left, right);
        if (!algebra.carrier.includes(result)) {
          throw new AlgebraLawError(
            `algebra_carrier_not_closed(${algebra.name}, ${operation}, ` +
              `inputs=(${left.text}, ${right.text}), result=${result.text})`,
          );
        }
      }
    }
  }
  for (const law of equational) checkLaw(space, algebra, law);
}

function checkLaw(space: Space, algebra: Algebra, law: Law): void {
  const carrier = algebra.carrier;
  const combine = (a: Atom, b: Atom): Atom => algebra.combineValues(space, a, b);
  const extend = (a: Atom, b: Atom): Atom => algebra.extendValues(space, a, b);
  const operation = law.startsWith("combine-") ? combine : extend;
  if (law.endsWith("-associative")) {
    for (const a of carrier) {
      for (const b of carrier) {
        for (const c of carrier) {
          const left = operation(operation(a, b), c);
          const right = operation(a, operation(b, c));
          if (left !== right) throw counterexample(algebra, law, [a, b, c], left, right);
        }
      }
    }
    return;
  }
  if (law.endsWith("-commutative")) {
    for (const a of carrier) {
      for (const b of carrier) {
        const left = operation(a, b);
        const right = operation(b, a);
        if (left !== right) throw counterexample(algebra, law, [a, b], left, right);
      }
    }
    return;
  }
  if (law === "combine-idempotent") {
    for (const value of carrier) {
      const result = combine(value, value);
      if (result !== value) throw counterexample(algebra, law, [value], result, value);
    }
    return;
  }
  if (law === "left-distributive" || law === "right-distributive") {
    for (const a of carrier) {
      for (const b of carrier) {
        for (const c of carrier) {
          const left =
            law === "left-distributive" ? extend(a, combine(b, c)) : extend(combine(a, b), c);
          const right =
            law === "left-distributive"
              ? combine(extend(a, b), extend(a, c))
              : combine(extend(a, c), extend(b, c));
          if (left !== right) throw counterexample(algebra, law, [a, b, c], left, right);
        }
      }
    }
    return;
  }
  if (law === "combine-zero-identity" || law === "extend-one-identity") {
    const identity = law === "combine-zero-identity" ? algebra.zero : algebra.one;
    const under = law === "combine-zero-identity" ? combine : extend;
    for (const value of carrier) {
      for (const answered of [under(identity, value), under(value, identity)]) {
        if (answered !== value) throw counterexample(algebra, law, [value], answered, value);
      }
    }
    return;
  }
  if (law === "extend-zero-annihilates") {
    for (const value of carrier) {
      for (const answered of [extend(algebra.zero, value), extend(value, algebra.zero)]) {
        if (answered !== algebra.zero) {
          throw counterexample(algebra, law, [value], answered, algebra.zero);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// A tagged program.

/** The stored form of one tagged fact: `(fact tag proposition)`. */
export function taggedFact(tag: Term, proposition: Term): Atom {
  const built = toAtom(tag);
  validateRateTag(built);
  return expr(sym("fact"), built, toAtom(proposition));
}

/** The stored form of one tagged rule: `(rule tag head (premises ...))`. */
export function taggedRule(tag: Term, head: Term, ...premises: readonly Term[]): Atom {
  const built = toAtom(tag);
  validateRateTag(built);
  return expr(
    sym("rule"),
    built,
    toAtom(head),
    expr(sym("premises"), ...premises.map(toAtom)),
  );
}

/** One retained, algebra-neutral derivation node. */
interface Trace {
  readonly source: number;
  readonly raw: Atom;
  readonly children: readonly Trace[];
  readonly isRule: boolean;
}

function trace(source: number, raw: Atom, children: readonly Trace[] = [], isRule = false): Trace {
  return { source, raw, children, isRule };
}

/** A law-gated evaluation choice, including one that was withheld. */
export interface PlanDecision {
  /** Which optimisation was considered. */
  readonly optimization: string;
  /** Whether it was applied. */
  readonly applied: boolean;
  /** The laws whose absence withheld it. */
  readonly missingLaws: readonly Law[];
}

/** The derivation forest captured while one annotated answer was produced. */
export class AlgebraDerivation {
  /** The conclusion this derivation is of. */
  readonly answer: Atom;
  /** The algebra it was read under. */
  readonly algebra: string;
  /** Each independent derivation of that conclusion. */
  readonly alternatives: readonly Trace[];

  /** @internal Built by {@link TaggedAnswer.why}. */
  constructor(answer: Atom, algebra: string, alternatives: readonly Trace[]) {
    this.answer = answer;
    this.algebra = algebra;
    this.alternatives = alternatives;
    Object.freeze(this);
  }

  toString(): string {
    const lines = [`${this.answer.text} under ${this.algebra}`];
    const visit = (node: Trace, indent: number): void => {
      lines.push(`${"  ".repeat(indent)}${node.isRule ? "rule" : "source"} ${String(node.source)}: ${node.raw.text}`);
      for (const child of node.children) visit(child, indent + 1);
    };
    for (const alternative of this.alternatives) visit(alternative, 1);
    return lines.join("\n");
  }
}

showsAs(AlgebraDerivation.prototype, (value: AlgebraDerivation) => value.toString());

/** A proposition, its annotation, and the derivation that made it. */
export class TaggedAnswer {
  /** The conclusion. */
  readonly value: Atom;
  /** Its annotation in the algebra it was read under. */
  readonly tag: Atom;
  /** Which stored atoms it consumed, by position. */
  readonly tokens: ReadonlySet<number>;
  /** The stored positions it rests on, in order. */
  readonly proof: readonly number[];
  /** The law decisions that produced it. */
  readonly plan: readonly PlanDecision[];

  readonly #derivations: readonly Trace[];
  readonly #space: Space | undefined;
  readonly #algebra: string;

  /** @internal Built by {@link evaluate}. */
  constructor(
    value: Atom,
    tag: Atom,
    tokens: ReadonlySet<number>,
    proof: readonly number[],
    derivations: readonly Trace[] = [],
    space?: Space,
    algebra = "unknown",
    plan: readonly PlanDecision[] = [],
  ) {
    this.value = value;
    this.tag = tag;
    this.tokens = tokens;
    this.proof = proof;
    this.plan = plan;
    this.#derivations = derivations;
    this.#space = space;
    this.#algebra = algebra;
  }

  /** The carrier value, unwrapped when it is an ordinary ground value. */
  get annotation(): unknown {
    return hostValue(this.tag);
  }

  /** The derivation the original ask captured. No second query. */
  why(): AlgebraDerivation {
    const traces = this.#derivations.length > 0 ? this.#derivations : [trace(-1, this.tag)];
    return new AlgebraDerivation(this.value, this.#algebra, traces);
  }

  /**
   * The same retained derivation, read under another algebra.
   *
   * The point of keeping the derivation rather than only its value: asking
   * "and what would this cost under the tropical semiring" costs a walk over
   * a tree already in hand, not a second evaluation.
   */
  async under(carrier: Carrier): Promise<TaggedAnswer> {
    const space = this.#space;
    if (space === undefined) {
      throw new AlgebraEvaluationError(
        "this answer carries no owning space for algebra reinterpretation",
      );
    }
    const algebra = await resolve(space, carrier);
    const traces = this.#derivations.length > 0 ? this.#derivations : [trace(-1, this.tag)];
    return new TaggedAnswer(
      this.value,
      interpretAlternatives(space, algebra, traces),
      this.tokens,
      this.proof,
      this.#derivations,
      space,
      algebra.name,
      this.plan,
    );
  }

  toString(): string {
    return `${this.value.text} @ ${this.tag.text}`;
  }
}

showsAs(TaggedAnswer.prototype, (value: TaggedAnswer) => value.toString());

/** Answers, and the observable law decisions that produced them. */
export interface AlgebraEvaluation {
  readonly answers: readonly TaggedAnswer[];
  readonly plan: readonly PlanDecision[];
}

interface Rule {
  readonly order: number;
  readonly tag: Atom;
  readonly head: Atom;
  readonly premises: readonly Atom[];
}

function coefficient(tag: Atom): Atom {
  if (headed(tag, "rate") && tag.items.length === 2) return tag.items[1] as Atom;
  return tag;
}

function programOf(atoms: readonly Atom[]): { facts: TaggedAnswer[]; rules: Rule[] } {
  const facts: TaggedAnswer[] = [];
  const rules: Rule[] = [];
  atoms.forEach((atom, order) => {
    if (headed(atom, "fact") && atom.items.length === 3) {
      const tag = atom.items[1] as Atom;
      facts.push(
        new TaggedAnswer(
          atom.items[2] as Atom,
          coefficient(tag),
          new Set([order]),
          [order],
          [trace(order, tag)],
        ),
      );
      return;
    }
    if (headed(atom, "rule") && atom.items.length === 4) {
      const body = atom.items[3] as Atom;
      if (!headed(body, "premises")) {
        throw new AlgebraDeclarationError(
          `tagged_rule_body_malformed(${atom.text}, expected=(premises ...))`,
        );
      }
      rules.push({
        order,
        tag: coefficient(atom.items[1] as Atom),
        head: atom.items[2] as Atom,
        premises: body.items.slice(1),
      });
    }
  });
  return { facts, rules };
}

function mergeBindings(
  current: Readonly<Record<string, Atom>>,
  extra: Readonly<Record<string, Atom>>,
): Record<string, Atom> | undefined {
  const merged: Record<string, Atom> = { ...current };
  for (const [name, value] of Object.entries(extra)) {
    const previous = merged[name];
    if (previous !== undefined && previous !== value) return undefined;
    merged[name] = value;
  }
  return merged;
}

interface State {
  readonly bindings: Record<string, Atom>;
  readonly tag: Atom;
  readonly tokens: Set<number>;
  readonly proof: number[];
  readonly traces: readonly Trace[];
}

function deriveRule(
  space: Space,
  algebra: Algebra,
  rule: Rule,
  available: readonly TaggedAnswer[],
): TaggedAnswer[] {
  let states: State[] = [
    { bindings: {}, tag: rule.tag, tokens: new Set(), proof: [rule.order], traces: [] },
  ];
  const linear = algebra.requires.has("linear");
  for (const premise of rule.premises) {
    const next: State[] = [];
    for (const state of states) {
      const pattern = substitute(premise, state.bindings);
      for (const candidate of available) {
        const matched = matchTerms(pattern, candidate.value);
        if (matched === undefined) continue;
        const overlap = [...state.tokens].filter((token) => candidate.tokens.has(token));
        if (linear && overlap.length > 0) {
          throw new LinearEvidenceError(
            `linear_evidence_already_spent(${algebra.name}, token=${String(Math.min(...overlap))})`,
          );
        }
        const merged = mergeBindings(state.bindings, matched);
        if (merged === undefined) continue;
        next.push({
          bindings: merged,
          tag: algebra.extendValues(space, state.tag, candidate.tag),
          tokens: new Set([...state.tokens, ...candidate.tokens]),
          proof: [...state.proof, ...candidate.proof],
          traces: [...state.traces, ...candidate.why().alternatives],
        });
      }
    }
    states = next;
    if (states.length === 0) break;
  }
  const answers: TaggedAnswer[] = [];
  for (const state of states) {
    const value = substitute(rule.head, state.bindings);
    if (hasVariable(value)) continue;
    answers.push(
      new TaggedAnswer(value, state.tag, state.tokens, state.proof, [
        trace(rule.order, rule.tag, state.traces, true),
      ]),
    );
  }
  return answers;
}

function hasVariable(atom: Atom): boolean {
  const stack: Atom[] = [atom];
  while (stack.length > 0) {
    const node = stack.pop() as Atom;
    if (node instanceof Var) return true;
    if (node instanceof Expression) for (const item of node.items) stack.push(item);
  }
  return false;
}

function signature(answer: TaggedAnswer): string {
  return `${answer.value.text}|${answer.tag.text}|${[...answer.tokens].sort().join(",")}|${answer.proof.join(",")}`;
}

function fuse(space: Space, algebra: Algebra, answers: readonly TaggedAnswer[]): TaggedAnswer[] {
  const fused: TaggedAnswer[] = [];
  const positions = new Map<string, number>();
  for (const answer of answers) {
    const key = answer.value.text;
    const at = positions.get(key);
    if (at === undefined) {
      positions.set(key, fused.length);
      fused.push(answer);
      continue;
    }
    const previous = fused[at] as TaggedAnswer;
    fused[at] = new TaggedAnswer(
      previous.value,
      algebra.combineValues(space, previous.tag, answer.tag),
      new Set([...previous.tokens, ...answer.tokens]),
      [...previous.proof, ...answer.proof],
      [...previous.why().alternatives, ...answer.why().alternatives],
    );
  }
  return fused;
}

/** How one universal source node reads as this carrier's generator value. */
function carrierInput(algebra: Algebra, node: Trace): Atom {
  if (["bool", "bag", "set", "counting"].includes(algebra.name)) return algebra.one;
  if (algebra.name === "prov") {
    if (!node.isRule && headed(node.raw, "src")) return node.raw;
    if (node.isRule) return algebra.one;
    return expr(sym("src"), G(node.source));
  }
  if (headed(node.raw, "rate") && node.raw.items.length === 2) return node.raw.items[1] as Atom;
  return node.raw;
}

function interpretTrace(space: Space, algebra: Algebra, node: Trace): Atom {
  let value = carrierInput(algebra, node);
  for (const child of node.children) {
    value = algebra.extendValues(space, value, interpretTrace(space, algebra, child));
  }
  return value;
}

function interpretAlternatives(
  space: Space,
  algebra: Algebra,
  alternatives: readonly Trace[],
): Atom {
  let value = algebra.zero;
  for (const alternative of alternatives) {
    value = algebra.combineValues(space, value, interpretTrace(space, algebra, alternative));
  }
  return value;
}

function orderAnswers(algebra: Algebra, answers: readonly TaggedAnswer[]): TaggedAnswer[] {
  if (algebra.order === undefined) return [...answers];
  const rank = (answer: TaggedAnswer): number => {
    const held = hostValue(answer.tag);
    return typeof held === "number" || typeof held === "bigint" ? Number(held) : Number.NaN;
  };
  // A STABLE sort, so answers that tie keep their derivation order, which is
  // what makes a `top k` over an ordered carrier reproducible.
  return [...answers].sort((left, right) => {
    const a = rank(left);
    const b = rank(right);
    if (Number.isNaN(a) || Number.isNaN(b)) return 0;
    return algebra.order === "descending" ? b - a : a - b;
  });
}

/** What `evaluate` accepts beside the query. */
export interface EvaluateOptions {
  /** The carrier to read annotations in. */
  readonly algebra: Carrier;
  /** How many derivation rounds to run before refusing. Sixty-four by default. */
  readonly maxRounds?: number;
  /** The catalog to resolve the algebra against. This space's own, by default. */
  readonly catalog?: Space;
}

/**
 * Evaluate every finite tagged derivation, in declaration order.
 *
 * ```ts
 * const kb = m.space(S.paths);
 * kb.add(taggedFact(1, S.edge(S.a, S.b)), taggedFact(2, S.edge(S.b, S.c)));
 * kb.add(taggedRule(1, S.path(V.x, V.z), S.edge(V.x, V.y), S.edge(V.y, V.z)));
 * const { answers } = await evaluate(kb, S.path(V.from, V.to), { algebra: tropical });
 * ```
 *
 * The prover is the naive fixpoint: derive, keep what is new, repeat until
 * nothing is. `maxRounds` bounds it, and exceeding the bound is a refusal
 * rather than a truncated answer set, because a partial fixpoint answers a
 * different question.
 */
export async function evaluate(
  space: Space,
  query: Term,
  options: EvaluateOptions,
): Promise<AlgebraEvaluation> {
  const catalog = options.catalog ?? space.catalog;
  const algebra = await resolve(catalog, options.algebra);
  await requireContextCapabilities(catalog, space, algebra);
  const goal = toAtom(query);
  const stored = await space.atoms().toArray();
  const { facts, rules } = programOf(stored);
  const available = [...facts];
  const seen = new Set(available.map(signature));
  const rounds = options.maxRounds ?? 64;
  let settled = false;
  for (let round = 0; round < rounds; round += 1) {
    const added: TaggedAnswer[] = [];
    for (const rule of rules) {
      for (const answer of deriveRule(space, algebra, rule, available)) {
        const key = signature(answer);
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(answer);
      }
    }
    if (added.length === 0) {
      settled = true;
      break;
    }
    available.push(...added);
  }
  if (!settled) {
    throw new AlgebraEvaluationError(
      `algebra_derivation_did_not_reach_fixpoint(${algebra.name}, rounds=${String(rounds)})`,
    );
  }
  let matched = available.filter((answer) => matchTerms(goal, answer.value) !== undefined);
  // Fusing two derivations of one conclusion needs the combine operation to be
  // ASSOCIATIVE, because the order the derivations arrived in is not part of
  // the question. Without that law the answers stay separate and the decision
  // is reported rather than taken silently.
  const licence: Law = "combine-associative";
  const canFuse = algebra.laws.has(licence);
  const plan: readonly PlanDecision[] = [
    { optimization: "fuse-equal-conclusions", applied: canFuse, missingLaws: canFuse ? [] : [licence] },
  ];
  if (canFuse) matched = fuse(space, algebra, matched);
  const answers = orderAnswers(algebra, matched).map(
    (answer) =>
      new TaggedAnswer(
        answer.value,
        answer.tag,
        answer.tokens,
        answer.proof,
        answer.why().alternatives,
        space,
        algebra.name,
        plan,
      ),
  );
  return { answers, plan };
}

async function requireContextCapabilities(
  catalog: Space,
  space: Space,
  algebra: Algebra,
): Promise<void> {
  if (algebra.requires.size === 0) return;
  const declared = await contextCapabilities(catalog, space, algebra.name);
  const missing = [...algebra.requires].filter((each) => !declared.has(each)).sort();
  if (missing.length === 0) return;
  const refusal =
    algebra.name === "amplitude" ? "amplitude_fragment_refused" : "algebra_requirements_missing";
  throw new AlgebraRequirementError(
    `${refusal}(${space.name}, ${algebra.name}, missing=[${missing.join(", ")}])`,
  );
}

async function contextCapabilities(
  catalog: Space,
  space: Space,
  algebra: string,
): Promise<Set<string>> {
  for await (const atom of catalog.atoms()) {
    if (!headed(atom, "annotations")) continue;
    if (atom.items.length !== 3 && atom.items.length !== 4) continue;
    if (String(atom.items[1]) !== space.name || String(atom.items[2]) !== algebra) continue;
    return new Set(namesIn(atom.items[3], "capabilities"));
  }
  return new Set();
}

/**
 * Declare which algebra a space's answer annotations live in.
 *
 * The `(annotations <space> <algebra> (capabilities ...))` row the ENGINE
 * reads too: it is what makes `top k` mean "the k best" rather than "any k",
 * and what licenses an algebra whose requirements a context must meet.
 */
export function annotate(
  space: Space,
  algebra: Carrier,
  capabilities: readonly string[] = [],
): Atom {
  const row =
    capabilities.length === 0
      ? expr(sym("annotations"), sym(space.name), sym(carrierName(algebra)))
      : expr(
          sym("annotations"),
          sym(space.name),
          sym(carrierName(algebra)),
          expr(sym("capabilities"), ...capabilities.map((each) => sym(each))),
        );
  space.catalog.add(row);
  return row;
}

// ---------------------------------------------------------------------------
// Rates.

function rateOf(tag: Atom): number {
  const inner = headed(tag, "rate") && tag.items.length === 2 ? (tag.items[1] as Atom) : tag;
  const held = hostValue(inner);
  if (typeof held !== "number" && typeof held !== "bigint") {
    throw new RateDeclarationError(`rate_not_numeric(${tag.text})`);
  }
  const numeric = Number(held);
  if (numeric < 0 || !Number.isFinite(numeric)) {
    throw new RateDeclarationError(`negative_or_nonfinite_rate(${tag.text})`);
  }
  return numeric;
}

function validateRateTag(tag: Atom): void {
  if (headed(tag, "rate")) rateOf(tag);
}

/** What `sample` accepts beside the query. */
export interface SampleOptions extends EvaluateOptions {
  /** How many draws to take. */
  readonly draws: number;
  /** The seed, so the same draw sequence is reproducible. */
  readonly seed: number;
}

/**
 * Draw from the answers, weighted by their rates, from a seeded source.
 *
 * The isolated seeded state is the point: two runs of one program with one
 * seed draw the same answers, and drawing here never disturbs anything else
 * that draws.
 */
export async function sample(
  space: Space,
  query: Term,
  options: SampleOptions,
): Promise<Atom[]> {
  if (!Number.isInteger(options.draws) || options.draws < 0) {
    throw new MettaError("draws must be a nonnegative integer");
  }
  const { answers } = await evaluate(space, query, options);
  const weights = answers.map((answer) => rateOf(answer.tag));
  const total = weights.reduce((sum, each) => sum + each, 0);
  if (!Number.isFinite(total)) {
    throw new RateDeclarationError(`rate_total_nonfinite(${carrierName(options.algebra)})`);
  }
  if (total <= 0) return [];
  const random = new Random(options.seed);
  const values = answers.map((answer) => answer.value);
  return Array.from({ length: options.draws }, () => random.weighted(values, weights));
}

/** Whether a tagged fact or rule here could answer this query at all. */
export async function hasTaggedProgram(space: Space, query: Term): Promise<boolean> {
  const goal = toAtom(query);
  for await (const atom of space.atoms()) {
    if (headed(atom, "fact") && atom.items.length === 3) {
      if (matchTerms(goal, atom.items[2] as Atom) !== undefined) return true;
    }
    if (headed(atom, "rule") && atom.items.length === 4) {
      if (matchTerms(goal, atom.items[2] as Atom) !== undefined) return true;
    }
  }
  return false;
}

/** Every exported carrier, so a program may enumerate what it can read under. */
export const CARRIERS: readonly string[] = Object.freeze(Object.keys(PRESETS));
