/**
 * Purpose: the error FAMILY this binding raises. One base class carrying a
 *   stable machine-readable `code`, one named subclass per condition a caller
 *   can act on differently, and the remedy computation a refusal owes its
 *   reader.
 * Assumes:
 *   - a caller matches on `error.code` or on `instanceof`, never on prose,
 *     which is Node's own convention for its own errors
 *     [source: https://nodejs.org/api/errors.html#errorcode]
 * Guarantees:
 *   - every refusal this binding raises is a `MettaError` with a `code` from
 *     {@link Code}, so a test or a tool matches the code and the prose stays
 *     free to improve
 *   - each subclass carries its own default code, so `throw new CastError(...)`
 *     needs no options bag and a `catch` can narrow by class instead of by
 *     string comparison [tested: "each error subclass carries its own code"]
 *   - every concrete exported condition has a source producer; retired strict
 *     scope conditions are absent rather than reserving unreachable catch arms
 *     [tested: "discovers every published condition and its producer";
 *     "contains no retired strict-scope conditions";
 *     commit=f634a8072585acef6195994b1220cb822575822e]
 *   - a refusal is classified from the KIND the engine read off the raised
 *     ball, never from the rendered sentence, and this seat maps every kind
 *     the engine's own table publishes: the list is
 *     `tests/data/error-kinds.json`, which the Python seat's suite reads
 *     against its own map
 *     [tested: "covers every kind the engine publishes";
 *     "classifies every kind the engine publishes, from a real ball";
 *     commit=52e95b50cc5acdc0e41f97b444ab244ad1301433]
 *   - a bound the engine could not name is `undefined` rather than 0
 *     [tested: "carries a limit on a resource refusal"; commit=52e95b50cc5acdc0e41f97b444ab244ad1301433]
 *   - a reduction that failed across several nondeterministic branches raises
 *     the platform's own `AggregateError` with one `cause`-chained entry per
 *     branch, rather than an error shape invented here
 *   - `nearest` answers the closest declared spelling to an unknown name, so
 *     a refusal names the remedy instead of only the problem
 * Decides: an ABORT is the platform's own `TimeoutError` DOMException, the name
 *   `AbortSignal.timeout` already aborts with, so there is no class here to
 *   catch instead of the one every other async API raises. `TimeLimitError` is
 *   a different thing: the ENGINE's own budget, thrown from inside a reduction.
 *   The engine's two CODEC kinds stay inside this family as `WireError` and
 *   `CastError` where the Python seat spells them with the language's own
 *   `ValueError` and `TypeError`: each seat spells a meaning its host's way,
 *   and this host's way is one family every refusal is inside.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

/** The stable codes. Match on these; the prose beside them is free to change. */
export type Code =
  /** The engine refused a goal, or raised while running one. */
  | "ERR_METTA_ENGINE"
  /** Source text the engine's reader would not read. */
  | "ERR_METTA_SYNTAX"
  /** A term could not cross the wire in the shape the codec requires. */
  | "ERR_METTA_WIRE"
  /** Exactly-one was asked for and nothing answered. */
  | "ERR_METTA_ABSENT"
  /** Exactly-one was asked for and more than one answered. */
  | "ERR_METTA_AMBIGUOUS"
  /** A name, arity or spelling the surface cannot reach. */
  | "ERR_METTA_NAME"
  /** A capability this deployment, or this restricted space, does not have. */
  | "ERR_METTA_CAPABILITY"
  /** A body could not be traced into one equation. */
  | "ERR_METTA_TRACE"
  /** A body could not be lowered from its own source. */
  | "ERR_METTA_LOWER"
  /** A handle was used after it was released. */
  | "ERR_METTA_CLOSED"
  /** The surface was asked for something it does not carry. */
  | "ERR_METTA_UNSUPPORTED"
  /** A value the engine's type discipline will not accept as the target type. */
  | "ERR_METTA_CAST"
  /** The engine's own inference budget ran out inside a reduction. */
  | "ERR_METTA_INFERENCES"
  /** The engine's own deadline ran out inside a reduction. */
  | "ERR_METTA_TIME"
  /** The engine's own stack limit ran out building or reading a term. */
  | "ERR_METTA_STACK"
  /** A restraint the program declared for one of its own tables tripped. */
  | "ERR_METTA_RESTRAINT"
  /** The evaluation was stopped from outside, mid-goal. */
  | "ERR_METTA_INTERRUPTED"
  /** A builtin refused a value, naming the operation the source wrote. */
  | "ERR_METTA_OPERATION"
  /** A space implemented in TypeScript raised, or refused. */
  | "ERR_METTA_PROVIDER"
  /** A standing query's own callback raised, or its queue overflowed. */
  | "ERR_METTA_SUBSCRIBER"
  /** The transport between this host and the engine failed structurally. */
  | "ERR_METTA_TRANSPORT"
  /** A test assertion a program made did not hold. */
  | "ERR_METTA_ASSERTION"
  /** A source a program named is not there. */
  | "ERR_METTA_SOURCE";

/** What every constructor in the family accepts. */
export interface MettaErrorOptions extends ErrorOptions {
  /** Override the subclass's own default code. */
  readonly code?: Code;
}

/**
 * Every refusal this binding raises.
 *
 * The base of the family. Catch this to catch all of them; catch a subclass to
 * catch one condition. `error.code` is the same discrimination for a caller
 * that would rather switch than chain `instanceof`.
 *
 * ```ts
 * try { await m.eval(term).one(); }
 * catch (error) {
 *   if (error instanceof ResultError) console.log("not exactly one");
 *   else if (MettaError.is(error, "ERR_METTA_ENGINE")) console.log(error.message);
 *   else throw error;
 * }
 * ```
 */
export class MettaError extends Error {
  /** The stable code. Match on this, never on the prose. */
  readonly code: Code;

  constructor(message: string, options: MettaErrorOptions = {}) {
    super(message, "cause" in options ? { cause: options.cause } : undefined);
    // `new.target.name` rather than a literal: every subclass then names
    // itself in a stack trace without restating its own name in a constructor.
    this.name = new.target.name;
    this.code = options.code ?? (new.target as typeof MettaError).defaultCode;
  }

  /** The code instances of this class carry unless told otherwise. */
  static readonly defaultCode: Code = "ERR_METTA_ENGINE";

  /**
   * Whether a caught value is one of this family, optionally with one code.
   *
   * The type guard door, so a `catch (error: unknown)` narrows in one call
   * rather than in an `instanceof` plus a property test.
   */
  static is(value: unknown, code?: Code): value is MettaError {
    return value instanceof MettaError && (code === undefined || value.code === code);
  }

  /** The wire shape, so a refusal survives a structured log. */
  toJSON(): { name: string; code: Code; message: string } {
    return { name: this.name, code: this.code, message: this.message };
  }
}

/** The engine refused a goal, or raised while running one. */
export class EngineError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_ENGINE";
}

/** What a reader failure knows about itself, beyond its sentence. */
export interface MettaSyntaxErrorOptions extends MettaErrorOptions {
  /** The 1-based line the reader stopped at. */
  readonly line?: number | undefined;
}

/** Source text the engine's own reader would not read. */
export class MettaSyntaxError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_SYNTAX";

  /**
   * The 1-based line the reader stopped at, where it named one.
   *
   * A file reader records the line in the refusal itself; a single form read
   * out of a string has no line to record, and this is then undefined rather
   * than a guessed 1.
   */
  readonly line: number | undefined;

  constructor(message: string, options: MettaSyntaxErrorOptions = {}) {
    super(message, options);
    this.line = options.line;
  }
}

/** A term could not cross the wire in the shape the codec requires. */
export class WireError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_WIRE";
}

/**
 * An ask answered a number of times the caller had ruled out.
 *
 * `ERR_METTA_ABSENT` for none where one was required, `ERR_METTA_AMBIGUOUS`
 * for more than one. One class, because the caller's recovery is the same
 * shape either way and the code says which happened.
 */
export class ResultError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_ABSENT";
}

/** A name, arity or spelling the surface cannot reach. */
export class NameError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_NAME";
}

/** What a restricted space was asked for, and the capability it lacks. */
export interface CapabilityErrorOptions extends MettaErrorOptions {
  /** The restricted space the operation ran in. */
  readonly space?: string | undefined;
  /** The operation it tried. */
  readonly operation?: string | undefined;
  /** The capability its creation did not grant. */
  readonly capability?: string | undefined;
}

/**
 * A capability this deployment, or this restricted space, does not have.
 *
 * A refusal from a restricted space carries the three parts the engine names,
 * so a caller grants the missing capability without reading the sentence. A
 * refusal about the BUILD (a platform library this deployment was made
 * without) names none of them and carries its message alone.
 */
export class CapabilityError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_CAPABILITY";

  /** The restricted space, when a space is what refused. */
  readonly space: string | undefined;
  /** The operation that was refused. */
  readonly operation: string | undefined;
  /** The capability that would have allowed it. */
  readonly capability: string | undefined;

  constructor(message: string, options: CapabilityErrorOptions = {}) {
    super(message, options);
    this.space = options.space;
    this.operation = options.operation;
    this.capability = options.capability;
  }
}

/**
 * A body this surface could not turn into equations.
 *
 * `ERR_METTA_TRACE` when a generator body could not be traced,
 * `ERR_METTA_LOWER` when a plain body could not be lowered from its own
 * source. Both are the same failure to a caller: the definition did not
 * install, and the message names the construct and the remedy.
 */
export class CompileError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_LOWER";
}

/** A handle was used after it was released. */
export class ClosedError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_CLOSED";
}

/** The surface was asked for something this build does not carry. */
export class UnsupportedError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_UNSUPPORTED";
}

/** A value the engine's type discipline will not accept as the target type. */
export class CastError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_CAST";
}

/** The ceiling a resource refusal names. */
export interface ResourceLimitErrorOptions extends MettaErrorOptions {
  /** The bound that was exceeded, in the unit the scope declared it in. */
  readonly limit?: number | undefined;
}

/** A budget the engine enforces inside a reduction ran out. */
export class ResourceLimitError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_INFERENCES";

  /**
   * The bound that was exceeded, in the unit the scope declared it in.
   *
   * Undefined where the engine could not name it: a budget that expires
   * inside a NESTED query raises SWI's own resource ball, which says which
   * resource ran out and not what the number was, because the number lives in
   * the frame that installed it and that frame has already unwound. It used
   * to arrive here as 0, which reads as a bound of zero.
   */
  readonly limit: number | undefined;

  constructor(message: string, options: ResourceLimitErrorOptions = {}) {
    super(message, options);
    this.limit = options.limit;
  }
}

/** The engine's own inference budget ran out inside a reduction. */
export class InferenceLimitError extends ResourceLimitError {
  static override readonly defaultCode: Code = "ERR_METTA_INFERENCES";
}

/**
 * The engine's own deadline ran out inside a reduction.
 *
 * Distinct from an aborted ask: `AbortSignal.timeout` bounds the HOST's pull
 * and aborts with the platform's `TimeoutError` DOMException, which is what
 * every other async API raises. This is the engine stopping itself.
 */
export class TimeLimitError extends ResourceLimitError {
  static override readonly defaultCode: Code = "ERR_METTA_TIME";
}

/**
 * The engine ran out of its own Prolog stack, which is what bounds a term's
 * DEPTH once nothing on this side recurses per level.
 *
 * `limit` is the ceiling in bytes as the engine reported it. The remedy is a
 * larger `stack_limit`, which is a startup setting here (`METTA_STACK_LIMIT`,
 * or `config.configure({ stackLimit })` before the first boot) and which a
 * 32-bit WebAssembly build must still fit in its address space.
 */
export class StackLimitError extends ResourceLimitError {
  static override readonly defaultCode: Code = "ERR_METTA_STACK";
}

/** The three parts a tripped restraint names. */
export interface RestraintErrorOptions extends MettaErrorOptions {
  /** The restraint word the row declared. */
  readonly restraint?: string | undefined;
  /** The bound that row set, which is this refusal's `limit`. */
  readonly bound?: number | undefined;
  /** The tabled call the engine was evaluating, as MeTTa text. */
  readonly call?: string | undefined;
}

/**
 * A restraint the program declared for one of its own tables tripped.
 *
 * The bound is the program's own `(cache f (max-answers 2))`,
 * `(subgoal-abstract n)` or `(answer-abstract n)` row rather than a caller's
 * scope, which is the one difference from the two limits above; `limit` is
 * that bound, under the family's own name for the ceiling that was exceeded.
 * Whatever the goal completed before the stop stands, and the table keeps the
 * answers it had, so the same call signals again until the table is cleared.
 */
export class RestraintError extends ResourceLimitError {
  static override readonly defaultCode: Code = "ERR_METTA_RESTRAINT";

  /** `max-answers`, `subgoal-abstract` or `answer-abstract`. */
  readonly restraint: string | undefined;
  /** The tabled call the engine was evaluating, as the MeTTa the program wrote. */
  readonly call: string | undefined;

  constructor(message: string, options: RestraintErrorOptions = {}) {
    super(message, { ...options, limit: options.bound });
    this.restraint = options.restraint;
    this.call = options.call;
  }
}

/**
 * The evaluation was stopped from outside, mid-goal.
 *
 * Whatever the goal completed before the stop, writes included, stands, which
 * is what stopping a computation mid-way means everywhere. Distinct from a
 * budget: nothing was exceeded, something asked for the stop.
 */
export class InterruptedError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_INTERRUPTED";
}

/** What a builtin refusal names about itself. */
export interface OperationErrorOptions extends MettaErrorOptions {
  /** The MeTTa operation as the source wrote it. */
  readonly operation?: string | undefined;
  /** The formal's own word: `type_error`, `domain_error`, `evaluation_error`. */
  readonly kind?: string | undefined;
  /** The type it wanted, where the formal names one. */
  readonly expected?: string | undefined;
  /** The value it got, where the formal names one. */
  readonly culprit?: string | undefined;
}

/**
 * A builtin refused a value, naming the operation the source wrote.
 *
 * `(+ 1 "a")` answers an error ATOM by default, which is data; this is what a
 * caller who asked to be interrupted instead is interrupted with, and it
 * names the MeTTa the program wrote rather than the Prolog predicate that
 * raised. `expected` and `culprit` are present only where the formal carries
 * them, which is every type error and nothing else.
 */
export class OperationError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_OPERATION";

  /** The MeTTa operation as the source wrote it. */
  readonly operation: string | undefined;
  /** The formal's own word. */
  readonly kind: string | undefined;
  /** The type it wanted. */
  readonly expected: string | undefined;
  /** The value it got. */
  readonly culprit: string | undefined;

  constructor(message: string, options: OperationErrorOptions = {}) {
    super(message, options);
    this.operation = options.operation;
    this.kind = options.kind;
    this.expected = options.expected;
    this.culprit = options.culprit;
  }
}

/** A space implemented in TypeScript raised, or refused a capability. */
export class ProviderError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_PROVIDER";
}

/** A standing query's own callback raised, or its queue overflowed. */
export class SubscriberError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_SUBSCRIBER";
}

/** The transport between this host and the engine failed structurally. */
export class TransportError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_TRANSPORT";
}

/** Which assertion form failed. */
export interface AssertionErrorOptions extends MettaErrorOptions {
  /** The form the engine reports through, `assert` or `test`. */
  readonly operation?: string | undefined;
}

/**
 * A test assertion a MeTTa program made did not hold.
 *
 * `assertEqual` and its siblings answer an error ATOM, which is data; this is
 * what a caller who asked to be interrupted instead is interrupted with.
 */
export class AssertionError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_ASSERTION";

  /**
   * The assertion form that failed, `assert` or `test`.
   *
   * The form, not the head: `assertEqual`, `assertIncludes` and a program's
   * own assertion over answer bags all report through `assert`, and the
   * message names the head the program actually wrote.
   */
  readonly operation: string | undefined;

  constructor(message: string, options: AssertionErrorOptions = {}) {
    super(message, options);
    this.operation = options.operation;
  }
}

/** Which source a program named. */
export interface SourceNotFoundErrorOptions extends MettaErrorOptions {
  /** The path the engine could not open, as the program named it. */
  readonly source?: string | undefined;
}

/** A file, module or library a program named is not there. */
export class SourceNotFoundError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_SOURCE";

  /** The path the engine could not open, as the program named it. */
  readonly source: string | undefined;

  constructor(message: string, options: SourceNotFoundErrorOptions = {}) {
    super(message, options);
    this.source = options.source;
  }
}

/**
 * Whether a caught value is a TRANSPORT failure rather than a refusal.
 *
 * The distinction that matters to a retry: a transport failure may succeed on
 * a second attempt, and a refusal will not.
 */
export function isTransportError(value: unknown): value is TransportError {
  return value instanceof TransportError;
}

/** The engine's own kind word for a refusal, one per row of its table. */
export type RefusalKind =
  /** Source text the engine's reader would not read. */
  | "syntax"
  /** A time budget a scope declared ran out. */
  | "time_limit"
  /** An inference budget a scope declared ran out. */
  | "inference_limit"
  /** A restraint a `(cache ...)` row declared for a table tripped. */
  | "restraint"
  /** The evaluation was stopped from outside. */
  | "interrupted"
  /** A value the engine's codec would not carry. */
  | "value"
  /** A value of the wrong type for what the codec was asked to do with it. */
  | "type"
  /** A `test` or `assert` a MeTTa program made did not hold. */
  | "assertion"
  /** A restricted space lacks the capability an operation needed. */
  | "capability"
  /** A builtin refused a value, naming the operation the source wrote. */
  | "operation"
  /** The engine's own Prolog stack ran out. */
  | "stack"
  /** A file, module or library a program named is not there. */
  | "source"
  /** A ball the engine did not shape, which is the honest default. */
  | "engine";

/** One refusal's fields, by the engine's own name for each, as text. */
export type Fields = Readonly<Record<string, string>>;

/** A numeric field, or undefined where the refusal did not carry one. */
function measure(fields: Fields, name: string): number | undefined {
  const text = fields[name];
  return text === undefined ? undefined : Number(text);
}

/**
 * The class this seat raises for each kind the engine publishes.
 *
 * One row per kind, and the compiler requires the set to be complete: a kind
 * added to {@link RefusalKind} with no row here does not build. The kinds and
 * their fields are the ENGINE's, declared once in
 * `engine/metta/registration.pl` as `metta_host_error_kind_row/3`;
 * `tests/data/error-kinds.json` carries that list with this seat's class and
 * the Python seat's beside each, and each seat's suite reads it against its
 * own map, so the two cannot drift apart in silence.
 *
 * Two rows spell the same kind differently from the Python seat on purpose.
 * `value` and `type` are the codec refusing the caller's own data, which
 * Python spells with the language's own `ValueError` and `TypeError`; this
 * seat's family already has a class for each of those meanings, and keeping
 * them inside it is what makes "catch `MettaError` and you have caught every
 * refusal" true here.
 */
const KINDS: Readonly<Record<RefusalKind, (text: string, fields: Fields) => MettaError>> = {
  syntax: (text, fields) => new MettaSyntaxError(text, { line: measure(fields, "line") }),
  time_limit: (text, fields) => new TimeLimitError(text, { limit: measure(fields, "limit") }),
  inference_limit: (text, fields) =>
    new InferenceLimitError(text, { limit: measure(fields, "limit") }),
  restraint: (text, fields) =>
    new RestraintError(text, {
      restraint: fields["restraint"],
      bound: measure(fields, "bound"),
      call: fields["call"],
    }),
  interrupted: (text) => new InterruptedError(text),
  value: (text) => new WireError(text),
  type: (text) => new CastError(text),
  assertion: (text, fields) => new AssertionError(text, { operation: fields["operation"] }),
  capability: (text, fields) =>
    new CapabilityError(text, {
      space: fields["space"],
      operation: fields["operation"],
      capability: fields["capability"],
    }),
  operation: (text, fields) =>
    new OperationError(text, {
      operation: fields["operation"],
      kind: fields["kind"],
      expected: fields["expected"],
      culprit: fields["culprit"],
    }),
  // The one refusal that says more than the engine did: the ceiling is a
  // startup setting here, so the remedy is not in the engine's own message.
  stack: (text, fields) =>
    new StackLimitError(
      `${text}\nthe term was deeper or larger than the engine's own stack; raise ` +
        `METTA_STACK_LIMIT (or config.configure({ stackLimit }) before the first boot), ` +
        `which a 32-bit WebAssembly build must still fit in its address space`,
      { limit: measure(fields, "limit") },
    ),
  source: (text, fields) => new SourceNotFoundError(text, { source: fields["source"] }),
  engine: (text) => new EngineError(text),
};

/** Every kind this seat maps, which is every kind the engine publishes. */
export const REFUSAL_KINDS: readonly RefusalKind[] = Object.keys(KINDS) as RefusalKind[];

/**
 * The class the engine's own classification names.
 *
 * `bridge.pl` reads the KIND off the raised ball through the engine's own
 * refusal table and sends it with the rendered sentence and the fields that
 * kind carries; this turns that into the condition it is. It used to read the
 * sentence instead and knew seven kinds that way, so a tripped restraint, an
 * interrupt, a builtin's own refusal and both codec kinds arrived as a generic
 * `EngineError` and no field survived at all.
 *
 * A kind this seat does not know is an `EngineError` carrying the engine's
 * own sentence, which loses nothing a caller had before; the drift itself is
 * caught by the suite that reads the shared kind list rather than by
 * replacing a real refusal with a complaint about the wire.
 */
export function engineError(text: string, kind: string, fields: Fields = {}): MettaError {
  const build = Object.hasOwn(KINDS, kind) ? KINDS[kind as RefusalKind] : undefined;
  return build === undefined ? new EngineError(text) : build(text, fields);
}

/**
 * Gather branch failures the way the platform already names them.
 *
 * A reduction that failed in one branch raises that branch's error; one that
 * failed in several raises `AggregateError`, which is ECMAScript's own word
 * for "several things failed at once" and needs no library equivalent. Each
 * entry keeps the error ATOM as its `cause`, so the data is never lost by
 * being reported.
 */
export function branchFailure(errors: readonly unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, message);
}

/** Levenshtein distance, bounded: anything past `limit` answers `limit + 1`. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  // One rolling row rather than the full matrix: the classic two-row
  // Wagner-Fischer, which is O(min(|a|,|b|)) space and enough for names.
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row.push(Math.min(row[j - 1]! + 1, previous[j]! + 1, substitution));
    }
    previous = row;
  }
  return previous[b.length]!;
}

/**
 * The closest declared spelling to `wanted`, or undefined when nothing is near.
 *
 * Ruling 10 of the design ledger: refuse loudly with the remedy shown. A head
 * nobody declared is usually a typo of one somebody did, and saying which turns
 * a refusal into a fix.
 */
export function nearest(wanted: string, declared: Iterable<string>): string | undefined {
  // A third of the name's length, at least one: far enough to catch a
  // transposition or a dropped letter, near enough that an unrelated name is
  // never offered as the remedy.
  const limit = Math.max(1, Math.floor(wanted.length / 3));
  let best: string | undefined;
  let bestAt = limit + 1;
  for (const candidate of declared) {
    if (candidate === wanted) return candidate;
    const at = distance(wanted, candidate, limit);
    if (at < bestAt) {
      best = candidate;
      bestAt = at;
    }
  }
  return bestAt <= limit ? best : undefined;
}

/**
 * A refusal that names the remedy, when there is one to name.
 *
 * The shape every "unknown name" refusal in this package takes, said once:
 * the problem, then `did you mean X?` when a declared spelling is close
 * enough to be the typo, and nothing extra when none is.
 */
export function unknownName(
  wanted: string,
  declared: Iterable<string>,
  what: string,
): NameError {
  const suggestion = nearest(wanted, declared);
  const remedy = suggestion === undefined ? "" : `; did you mean ${suggestion}?`;
  return new NameError(`${what} ${wanted}${remedy}`);
}
