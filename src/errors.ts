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
 *   - a reduction that failed across several nondeterministic branches raises
 *     the platform's own `AggregateError` with one `cause`-chained entry per
 *     branch, rather than an error shape invented here
 *   - `nearest` answers the closest declared spelling to an unknown name, so
 *     a refusal names the remedy instead of only the problem
 * Decides: an ABORT is the platform's own `TimeoutError` DOMException, the name
 *   `AbortSignal.timeout` already aborts with, so there is no class here to
 *   catch instead of the one every other async API raises. `TimeLimitError` is
 *   a different thing: the ENGINE's own budget, thrown from inside a reduction.
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
  /** A directive answered itself, where a strict scope required a reduction. */
  | "ERR_METTA_STRICT"
  /** A term the engine has no equation for, where one was required. */
  | "ERR_METTA_NOT_REDUCIBLE"
  /** A value the engine's type discipline will not accept as the target type. */
  | "ERR_METTA_CAST"
  /** The engine's own inference budget ran out inside a reduction. */
  | "ERR_METTA_INFERENCES"
  /** The engine's own deadline ran out inside a reduction. */
  | "ERR_METTA_TIME"
  /** The engine's own stack limit ran out building or reading a term. */
  | "ERR_METTA_STACK"
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

/** Source text the engine's own reader would not read. */
export class MettaSyntaxError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_SYNTAX";
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

/** A capability this deployment, or this restricted space, does not have. */
export class CapabilityError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_CAPABILITY";
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

/** A directive answered itself, where a strict scope required a reduction. */
export class StrictError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_STRICT";
}

/**
 * A term the engine has no equation for, where the caller required one.
 *
 * MeTTa's own answer to an unreduced call is the call itself, which is data
 * rather than a failure. This is the opt-in refusal for a caller who asked for
 * a value and got the question back.
 */
export class NotReducibleError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_NOT_REDUCIBLE";
}

/** A value the engine's type discipline will not accept as the target type. */
export class CastError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_CAST";
}

/** A budget the engine enforces inside a reduction ran out. */
export class ResourceLimitError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_INFERENCES";

  /** The bound that was exceeded, in the unit the scope declared it in. */
  readonly limit: number;

  constructor(message: string, limit: number, options: MettaErrorOptions = {}) {
    super(message, options);
    this.limit = limit;
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

/**
 * A test assertion a MeTTa program made did not hold.
 *
 * `assertEqual` and its siblings answer an error ATOM, which is data; this is
 * what a caller who asked to be interrupted instead is interrupted with.
 */
export class AssertionError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_ASSERTION";
}

/** A file, module or library a program named is not there. */
export class SourceNotFoundError extends MettaError {
  static override readonly defaultCode: Code = "ERR_METTA_SOURCE";
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

/** How many bytes each unit SWI spells a stack ceiling in stands for. */
const STACK_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  Kb: 1024,
  Mb: 1024 * 1024,
  Gb: 1024 * 1024 * 1024,
};

/**
 * The class the engine's own signal names, so an engine refusal arrives as the
 * condition it is rather than as generic prose.
 *
 * The engine writes a control signal into its error term before the text
 * reaches this side; the bridge renders it, and this reads the rendering back.
 * Beside the two control signals it reads three of the engine's own wordings:
 * a stack ceiling, a failed MeTTa assertion and a source it could not open,
 * each of which has a class here and used to arrive as generic prose. A text
 * with none of them in it is an `EngineError`, which is the honest default.
 */
export function engineError(text: string): MettaError {
  const trimmed = text.trimEnd();
  // The engine names its own control signal in the rendered message, either as
  // the raw term or as the parenthesised word its message writer appends:
  // "the evaluation passed its 500 inference bound and was stopped
  // (inference_limit)". Both spellings are read, because a host that matched
  // only the raw term would classify the shipped wording as generic prose.
  const signal = /metta_control_signal\((\w+)|\((inference_limit|time_limit)\)/.exec(trimmed);
  if (signal !== null) {
    const named = signal[1] ?? signal[2];
    const bound = /\bits (\d+)\b|metta_control_signal\(\w+,\s*(\d+)/.exec(trimmed);
    const limit = Number(bound?.[1] ?? bound?.[2] ?? 0);
    if (named === "inference_limit") return new InferenceLimitError(trimmed, limit);
    if (named === "time_limit") return new TimeLimitError(trimmed, limit);
  }
  // SWI's own wording for its stacks running out, which is what bounds a
  // term's DEPTH now that nothing on this side recurses per level: a term
  // 500,000 deep crosses and a million raises this
  // [measured 2026-08-31, see C47].
  const stack = /Stack limit \(([\d.]+)(b|Kb|Mb|Gb)\) exceeded|resource_error\(stack\)/.exec(
    trimmed,
  );
  if (stack !== null) {
    const size = Number(stack[1] ?? 0) * (STACK_UNITS[stack[2] ?? "b"] ?? 1);
    return new StackLimitError(
      `${trimmed}\nthe term was deeper or larger than the engine's own stack; raise ` +
        `METTA_STACK_LIMIT (or config.configure({ stackLimit }) before the first boot), ` +
        `which a 32-bit WebAssembly build must still fit in its address space`,
      size,
    );
  }
  // A MeTTa program's own assertion, which the engine raises rather than
  // answering as data, so a caller who wants to catch a failed assertEqual
  // has a class for it rather than a prose match.
  if (/MeTTa assertion failed/.test(trimmed)) return new AssertionError(trimmed);
  if (/^ERROR:.*[Ss]yntax|cannot be read|operator expected/.test(trimmed)) {
    return new MettaSyntaxError(trimmed);
  }
  // The engine's own words for a file it could not open. `source_sink` is
  // SWI's existence-error culprit and `does not exist` is its message.
  if (/source_sink|does not exist/.test(trimmed)) return new SourceNotFoundError(trimmed);
  if (/\bcapabilit/.test(trimmed)) return new CapabilityError(trimmed);
  return new EngineError(trimmed);
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
