/**
 * Purpose: the three doors a program installs meaning through: `define` for an
 *   equation the engine holds, `op` for host code the engine calls, and
 *   `cache` for a definition the engine tables.
 * Assumes:
 *   - `fn.name` is the head, mapped through TypeScript's own casing, so
 *     `function balanceOf` installs `balance-of`; `{ name: "prime?" }` opts in
 *     to any exact head
 *   - a GENERATOR body is traced and a plain body is lowered from its own
 *     source, and the door is chosen by which one was written
 * Guarantees:
 *   - what `define` returns IS the callable, and calling it ASKS, so there is
 *     one call door rather than three
 *   - a definition costs ZERO host crossings per call: the whole body is in the
 *     engine
 *   - `op` keeps host code as host code, and its yields are what it costs
 * Decides: recursion inside a TRACED body is written as a mention,
 *   `S.descendants(c)`, not as a call. A named function expression binds its
 *   own name to the generator function, so calling it inside the body would
 *   make a generator rather than a term, and the const being defined is still
 *   in its temporal dead zone. The mention law already says this: `S.f()`
 *   builds the term and `f(...)` asks. A LOWERED body needs no such care,
 *   because its own source is read and its own name resolves to its head.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Sym, type Term, expr, sym, toAtom, variable } from "../atom.ts";
import { type Answers, type AskOptions } from "../answers.ts";
import { type EffectClass, type OpKind } from "../engine.ts";
import { MettaError } from "../errors.ts";
import { mettaName } from "../naming.ts";
import { type Space } from "../space.ts";
import { type Body, type Clause, nest, trace } from "./trace.ts";
import { lower } from "./lower.ts";

/** What a definition may say about itself. */
export interface DefineOptions {
  /** The exact head to install under, for a name the casing map cannot say. */
  readonly name?: string;
  /** Where the equations go. The engine's own self space, by default. */
  readonly space?: Space;
  /** Values a lowered body reaches by name that its own source cannot resolve. */
  readonly scope?: Readonly<Record<string, Term>>;
  /** An arrow type to declare beside the equations. */
  readonly type?: Term;
  /** Whether the engine should table this definition's answers. */
  readonly cache?: boolean;
}

/** What `op` may say about itself. */
export interface OpOptions extends Omit<DefineOptions, "cache"> {
  /**
   * The weakest effect class that is honestly true of the body.
   *
   * It is what a world's coverage is checked against, so overstating it
   * refuses programs that should run and understating it admits ones that
   * should not. A body whose behaviour is decided by data at run time, or by a
   * library the engine cannot bound, is `oracleIO`.
   */
  readonly effect?: EffectClass;
  /**
   * Whether the body receives its arguments as ATOMS rather than host values.
   *
   * The raw door is for a body that looks at structure: unevaluated arguments,
   * a pattern, a variable. An ordinary body wants the value and gets it.
   */
  readonly raw?: boolean;
}

/**
 * A name this engine holds a meaning for.
 *
 * Calling it ASKS, which is the one call door. Its `atom` MENTIONS it, which is
 * what a body writes when it means the term and not the answers.
 */
export interface Defined {
  (...args: readonly Term[]): Answers<Atom>;
  /** The engine head this installed under. */
  readonly head: string;
  /** The head as an atom, for a mention. */
  readonly atom: Sym;
  /** How many arguments the head takes. */
  readonly arity: number;
  /** The equations this definition put in the space, for a program that reads its own. */
  readonly equations: readonly Atom[];
  /** Remove the definition from the space it went into. */
  forget(): void;
}

/** What a door needs from the engine to install and to ask. */
export interface Installer {
  /** The space a definition goes into when none is named. */
  readonly self: Space;
  /** Whether a head is already known here. */
  knows(name: string): boolean;
  /** Register a host operation. */
  register(name: string, arity: number, kind: OpKind, effect: EffectClass, run: (args: readonly unknown[]) => unknown): void;
  /** Forget a host operation. */
  unregister(name: string, arity: number): void;
  /** Ask a term. */
  ask(term: Atom, space: Space, options?: AskOptions): Answers<Atom>;
  /** Note that a head now exists. */
  remember(name: string, arity: number): void;
  /** Every head this engine knows, so a refusal can name the nearest one. */
  declared(): Iterable<string>;
}

let tracing = 0;

/** Whether a body is being traced right now, so a call mentions instead of asking. */
export function isTracing(): boolean {
  return tracing > 0;
}

/** @internal Run `walk` with the trace flag set. */
export function whileTracing<T>(walk: () => T): T {
  tracing += 1;
  try {
    return walk();
  } finally {
    tracing -= 1;
  }
}

function isGenerator(target: (...args: never[]) => unknown): boolean {
  const tag = (target as { constructor?: { name?: string } }).constructor?.name;
  return tag === "GeneratorFunction" || tag === "AsyncGeneratorFunction";
}

function headOf(
  target: (...args: never[]) => unknown,
  options: { name?: string },
  door: string,
): string {
  const explicit = options.name;
  if (explicit !== undefined && explicit !== "") return explicit;
  const own = target.name;
  if (own === "") {
    throw new MettaError(
      `${door} needs a name: give the function one (${door}(function myName() {...})) ` +
        `or say the head exactly with { name: "my-name" }`,
      { code: "ERR_METTA_NAME" },
    );
  }
  return mettaName(own);
}

/** The head's parameters, named after the function's own where the source has them. */
function paramsOf(target: (...args: never[]) => unknown, arity: number): Atom[] {
  const names = parameterNames(target, arity);
  return names.map((name) => variable(name));
}

/**
 * The parameter names a function's own source spells.
 *
 * Cosmetic and best effort: an equation reads far better as
 * `(= (find-divisor $n $d) ...)` than as `(= (find-divisor $a1 $a2) ...)`, and
 * a minified build simply falls back to the positional names, where nothing is
 * lost but the reading.
 */
function parameterNames(target: (...args: never[]) => unknown, arity: number): string[] {
  const fallback = Array.from({ length: arity }, (_, index) => `a${String(index + 1)}`);
  const source = Function.prototype.toString.call(target);
  const opened = source.indexOf("(");
  const closed = source.indexOf(")", opened);
  if (opened < 0 || closed < 0) return fallback;
  const written = source
    .slice(opened + 1, closed)
    .split(",")
    .map((part) => part.trim().split(/[:=\s]/)[0] ?? "")
    .filter((part) => /^[A-Za-z_$][\w$]*$/.test(part));
  return written.length === arity ? written : fallback;
}

/** `(= (head p1 ... pn) body)`. */
function equationOf(head: string, params: readonly Atom[], body: Atom): Atom {
  return expr(sym("="), expr(sym(head), ...params), body);
}

/**
 * Install a definition and answer the callable it names.
 *
 * A generator body is TRACED once with symbolic arguments and becomes one
 * equation per emission; a plain body is LOWERED from its own source and
 * becomes one. Either way the whole body lives in the engine afterwards, so a
 * call costs no host crossing at all.
 */
export function define(
  install: Installer,
  target: (...args: never[]) => unknown,
  options: DefineOptions = {},
): Defined {
  const head = headOf(target, options, "define");
  const arity = target.length;
  const space = options.space ?? install.self;
  const params = paramsOf(target, arity);

  let bodies: Atom[];
  if (isGenerator(target)) {
    const clauses: Clause[] = whileTracing(() => trace(target as Body, params, head));
    bodies = clauses.map((clause) => nest(clause));
  } else {
    const lowered = lower(target, {
      selfName: head,
      ...(target.name === "" ? {} : { selfIdentifier: target.name }),
      knows: (name) => install.knows(name),
      declared: () => install.declared(),
      ...(options.scope === undefined ? {} : { scope: options.scope }),
    });
    // The lowering names the head's parameters from the source, so the
    // equation is written over those and not over the ones minted above.
    return finish(install, head, lowered.params, [lowered.body], space, options, arity);
  }
  return finish(install, head, params, bodies, space, options, arity);
}

function finish(
  install: Installer,
  head: string,
  params: readonly Atom[],
  bodies: readonly Atom[],
  space: Space,
  options: DefineOptions,
  arity: number,
): Defined {
  const equations = bodies.map((body) => equationOf(head, params, body));
  if (options.type !== undefined) {
    space.add(expr(sym(":"), sym(head), toAtom(options.type)));
  }
  space.add(...equations);
  install.remember(head, arity);
  if (options.cache === true) {
    // The word `cache` here always means the ENGINE's tabling. A host-side
    // memoize would cache handles rather than answer sets and would break
    // multiplicity, so it is not what this door does.
    space.add(expr(sym("memoize"), sym(head)));
  }
  return callable(install, head, arity, equations, space);
}

function callable(
  install: Installer,
  head: string,
  arity: number,
  equations: readonly Atom[],
  space: Space,
): Defined {
  const symbol = sym(head);
  const ask = (...args: readonly Term[]): Answers<Atom> =>
    install.ask(expr(symbol, ...args.map(toAtom)), space);
  return Object.assign(ask, {
    head,
    atom: symbol,
    arity,
    equations,
    forget: (): void => {
      for (const equation of equations) space.delete(equation);
    },
    toString: (): string => head,
  }) as Defined;
}

/**
 * Keep a body as HOST code the engine calls, and answer the callable it names.
 *
 * A plain body answers once. A GENERATOR body is nondeterminism from
 * JavaScript: each `yield` is an answer, and the engine pulls them one at a
 * time, so an unbounded generator is usable. An ASYNC body, or an async
 * generator, is awaited between the engine's ask and its answer, which is what
 * the suspendable engine underneath buys.
 */
export function op(
  install: Installer,
  target: (...args: never[]) => unknown,
  options: OpOptions = {},
): Defined {
  const head = headOf(target, options, "op");
  const arity = target.length;
  const space = options.space ?? install.self;
  const many = isGenerator(target);
  const raw = options.raw === true;
  const kind: OpKind = many ? (raw ? "raw_many" : "many") : raw ? "raw_det" : "det";
  // An unstated effect is oracleIO, which is the fail-closed reading: a world
  // refuses to admit what it has not covered, rather than admitting something
  // it should not have.
  const effect = options.effect ?? "oracleIO";
  // The body is called with its own arguments, not with the array the pump
  // carries them in: an op is an ordinary TypeScript function and its
  // signature is the declaration.
  const run = (args: readonly unknown[]): unknown =>
    (target as (...spread: readonly unknown[]) => unknown)(...args);
  install.register(head, arity, kind, effect, run);
  if (options.type !== undefined) {
    space.add(expr(sym(":"), sym(head), toAtom(options.type)));
  }
  install.remember(head, arity);
  const defined = callable(install, head, arity, [], space);
  return Object.assign(defined, {
    forget: (): void => {
      install.unregister(head, arity);
    },
  });
}
