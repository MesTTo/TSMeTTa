/**
 * Purpose: the word door. Every operator MeTTa spells with punctuation gets a
 *   TypeScript word here, and every control form gets its capitalised builder,
 *   so a program never writes an engine head as a bare string.
 * Assumes:
 *   - every head named here exists in the engine
 *     [tested: "reduce to what they claim"]
 *   - fork 1 of `ai-typescript-design.md`, option C: the free functions ARE
 *     the word door's words, so `import { lte }` and `word.lte` are one
 *     mechanism in two positions and the proxy still spells the long tail
 * Guarantees:
 *   - the roster is TypeScript's ecosystem's own: `eq ne gt gte lt lte`, not
 *     the Python operator module's `ge`/`le`, because `gte` is what Drizzle,
 *     Prisma, Mongo, Sequelize and lodash all say
 *     [tested: "are the ecosystem's own roster, not the Python operator
 *     module's"]
 *   - `neg(x)` builds `(- 0 x)`, the composite MeTTa actually has, rather than
 *     pretending there is a unary minus head
 *     [tested: "negate by subtracting from zero, which is the composite MeTTa
 *     has"]
 *   - a control form is CAPITALISED (`If`, `Let`, `Case`, `Match`), which is
 *     forced for `if` and `let` by JavaScript's reserved words and kept for the
 *     rest so the whole family reads alike
 * Decides: `div` is MeTTa's own `/` and inherits MeTTa's division semantics,
 *   which are the engine's to define and not this door's to normalise. The
 *   Python table flags `truediv` for the same reason.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, type Var, expr, exprOf, sym, toAtom, variable } from "./atom.ts";
import { PettaError } from "./errors.ts";

function apply(head: string, ...args: readonly Term[]): Atom {
  return expr(sym(head), ...args.map(toAtom));
}

/**
 * The word each operator is reached by, and the engine head it names.
 *
 * The `fn` door consults this before the casing map, because an operator's
 * head is punctuation and no casing map could ever reach it. It is the same
 * table the free functions above are written from, so `fn.gte` and `gte` name
 * one head by construction.
 *
 * `neg` is absent on purpose: MeTTa has no unary minus head, so the word is a
 * composite `(- 0 x)` and only the free function can build it.
 */
export const OPERATOR_HEADS: Readonly<Record<string, string>> = {
  eq: "==",
  ne: "!=",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
  pow: "pow-math",
  abs: "abs-math",
  sqrt: "sqrt-math",
  floor: "floor-math",
  ceil: "ceil-math",
};

// ---------------------------------------------------------------------------
// Comparison. The ecosystem's own roster.

/** `(== a b)`. MeTTa's equality, which tells the integer 2 from the float 2.0. */
export function eq(a: Term, b: Term): Atom {
  return apply("==", a, b);
}

/** `(!= a b)`. */
export function ne(a: Term, b: Term): Atom {
  return apply("!=", a, b);
}

/** `(< a b)`. */
export function lt(a: Term, b: Term): Atom {
  return apply("<", a, b);
}

/** `(<= a b)`. */
export function lte(a: Term, b: Term): Atom {
  return apply("<=", a, b);
}

/** `(> a b)`. */
export function gt(a: Term, b: Term): Atom {
  return apply(">", a, b);
}

/** `(>= a b)`. */
export function gte(a: Term, b: Term): Atom {
  return apply(">=", a, b);
}

// ---------------------------------------------------------------------------
// Arithmetic.

/** `(+ a b)`. */
export function add(a: Term, b: Term): Atom {
  return apply("+", a, b);
}

/** `(- a b)`. */
export function sub(a: Term, b: Term): Atom {
  return apply("-", a, b);
}

/** `(* a b)`. */
export function mul(a: Term, b: Term): Atom {
  return apply("*", a, b);
}

/**
 * `(/ a b)`.
 *
 * MeTTa's own division, with MeTTa's own semantics for what two integers
 * divide to. This door names the head and normalises nothing.
 */
export function div(a: Term, b: Term): Atom {
  return apply("/", a, b);
}

/** `(% a b)`. */
export function mod(a: Term, b: Term): Atom {
  return apply("%", a, b);
}

/** `(pow-math a b)`. */
export function pow(a: Term, b: Term): Atom {
  return apply("pow-math", a, b);
}

/**
 * `(- 0 x)`.
 *
 * MeTTa has no unary minus head, so negation is subtraction from zero, which
 * is the composite the Python table records for the same word.
 */
export function neg(x: Term): Atom {
  return apply("-", 0, x);
}

/** `(abs-math x)`. */
export function abs(x: Term): Atom {
  return apply("abs-math", x);
}

/** `(sqrt-math x)`. */
export function sqrt(x: Term): Atom {
  return apply("sqrt-math", x);
}

/** `(floor-math x)`. */
export function floor(x: Term): Atom {
  return apply("floor-math", x);
}

/** `(ceil-math x)`. */
export function ceil(x: Term): Atom {
  return apply("ceil-math", x);
}

/** `(min-atom xs)`, over an expression of numbers. */
export function minAtom(xs: Term): Atom {
  return apply("min-atom", xs);
}

/** `(max-atom xs)`, over an expression of numbers. */
export function maxAtom(xs: Term): Atom {
  return apply("max-atom", xs);
}

// ---------------------------------------------------------------------------
// Logic. Lowercase, because these are value operations and not control forms.

/** `(and a b)`. */
export function and(a: Term, b: Term): Atom {
  return apply("and", a, b);
}

/** `(or a b)`. */
export function or(a: Term, b: Term): Atom {
  return apply("or", a, b);
}

/** `(not a)`. */
export function not(a: Term): Atom {
  return apply("not", a);
}

/** `(xor a b)`. */
export function xor(a: Term, b: Term): Atom {
  return apply("xor", a, b);
}

// ---------------------------------------------------------------------------
// Structure.

/** `(car-atom xs)`. */
export function carAtom(xs: Term): Atom {
  return apply("car-atom", xs);
}

/** `(cdr-atom xs)`. */
export function cdrAtom(xs: Term): Atom {
  return apply("cdr-atom", xs);
}

/** `(cons-atom x xs)`. */
export function consAtom(x: Term, xs: Term): Atom {
  return apply("cons-atom", x, xs);
}

/** `(get-type x)`. */
export function getType(x: Term): Atom {
  return apply("get-type", x);
}

/** `(: x T)`, a type CLAIM, which is a value here and never an annotation. */
export function typed(x: Term, type: Term): Atom {
  return apply(":", x, type);
}

/** `(-> a b ... r)`, an arrow type as a value. */
export function arrow(...types: readonly Term[]): Atom {
  if (types.length < 2) {
    throw new PettaError("an arrow type needs at least an argument and a result", {
      code: "ERR_METTA_NAME",
    });
  }
  return apply("->", ...types);
}

// ---------------------------------------------------------------------------
// Control forms. Capitalised: `if` and `let` are reserved words in JavaScript,
// and the rest of the family keeps the casing so it reads as one family.

/** `(if condition then else)`. */
export function If(condition: Term, then: Term, otherwise: Term): Atom {
  return apply("if", condition, then, otherwise);
}

/** `(let pattern value body)`. */
export function Let(pattern: Term, value: Term, body: Term): Atom {
  return apply("let", pattern, value, body);
}

/** `(let* ((p1 v1) (p2 v2) ...) body)`. */
export function LetStar(bindings: readonly (readonly [Term, Term])[], body: Term): Atom {
  const pairs = bindings.map(([pattern, value]) => expr(toAtom(pattern), toAtom(value)));
  return expr(sym("let*"), exprOf(pairs), toAtom(body));
}

/** `(collapse x)`: every answer of `x`, as one expression. */
export function Collapse(x: Term): Atom {
  return apply("collapse", x);
}

/** `(superpose (a b c))`: one answer per item. */
export function Superpose(items: readonly Term[]): Atom {
  return expr(sym("superpose"), exprOf(items.map(toAtom)));
}

/** `(quote x)`: the atom, unreduced. */
export function Quote(x: Term): Atom {
  return apply("quote", x);
}

/** `(empty)`: no answers at all. */
export function Empty(): Atom {
  return expr(sym("empty"));
}

/** `(match space pattern template)`, the space query as a term. */
export function Match(space: Term, pattern: Term, template: Term): Atom {
  return apply("match", space, pattern, template);
}

/**
 * Whether two atoms unify, and the engine's own conditional form.
 *
 * `unify(a, b)` asks the question and answers `True` or `False`;
 * `unify(a, b, then, otherwise)` is the four-argument form the engine has, in
 * expression position, which the Python side records as a residue it wanted
 * closed and which exists here from day one.
 *
 * The two-argument form is the four-argument one with the two answers filled
 * in, rather than a second engine head: `unify/2` is not a MeTTa builtin, and
 * a door that named one would name nothing [measured 2026-08-27: `(unify (f 1)
 * (f $x))` does not reduce].
 */
export function unify(a: Term, b: Term): Atom;
export function unify(a: Term, b: Term, then: Term, otherwise: Term): Atom;
export function unify(a: Term, b: Term, then?: Term, otherwise?: Term): Atom {
  return then === undefined
    ? apply("unify", a, b, sym("True"), sym("False"))
    : apply("unify", a, b, then, otherwise);
}

// ---------------------------------------------------------------------------
// The case tower, built rather than written.

/** The variables a pattern binds, as an object keyed by their names. */
export type Bound = Readonly<Record<string, Var>>;

/** One arm being assembled. */
interface Arm {
  readonly pattern: Atom;
  readonly body: Atom;
}

function boundOf(pattern: Atom): Bound {
  const bound: Record<string, Var> = {};
  const walk = (atom: Atom): void => {
    const shape = atom as { kind: string; name?: string; items?: readonly Atom[] };
    if (shape.kind === "variable" && shape.name !== undefined && shape.name !== "_") {
      bound[shape.name] = variable(shape.name);
    } else if (shape.items !== undefined) {
      for (const item of shape.items) walk(item);
    }
  };
  walk(pattern);
  return bound;
}

/**
 * The case tower under construction.
 *
 * TypeScript has no `match` statement and TC39's is Stage 1, so the case tower
 * is a builder, in the shape ts-pattern already taught the ecosystem. It BUILDS
 * the case term, so it works under every door: as data, inside a definition,
 * or handed straight to `eval`.
 *
 * ```ts
 * caseOf(V.x)
 *   .with(4, () => 42)
 *   .with(S.pair(V.a, V.b), ({ a }) => a)
 *   .otherwise(() => 44)
 * ```
 *
 * An arm's body is a FUNCTION of the variables its pattern binds, so a name is
 * written once, in the pattern, and read back by that name.
 */
export class CaseBuilder {
  #subject: Atom;
  #arms: readonly Arm[];

  /** @internal Use {@link caseOf}. */
  constructor(subject: Atom, arms: readonly Arm[]) {
    this.#subject = subject;
    this.#arms = arms;
  }

  /** One arm: this pattern, and the term its bindings build. */
  with(pattern: Term, body: (bound: Bound) => Term): CaseBuilder {
    const matched = toAtom(pattern);
    return new CaseBuilder(this.#subject, [
      ...this.#arms,
      { pattern: matched, body: toAtom(body(boundOf(matched))) },
    ]);
  }

  /** The irrefutable last arm, and the whole case term. */
  otherwise(body: () => Term): Atom {
    return this.#build([...this.#arms, { pattern: variable("_"), body: toAtom(body()) }]);
  }

  /**
   * The whole case term with no catch-all.
   *
   * A subject no arm matches answers nothing, which is MeTTa's own reading of
   * an unmatched case and not an error.
   */
  end(): Atom {
    return this.#build(this.#arms);
  }

  #build(arms: readonly Arm[]): Atom {
    return expr(
      sym("case"),
      this.#subject,
      exprOf(arms.map((arm) => expr(arm.pattern, arm.body))),
    );
  }
}

/** Start a case tower over `subject`. */
export function caseOf(subject: Term): CaseBuilder {
  return new CaseBuilder(toAtom(subject), []);
}
