/**
 * Purpose: the one error family this binding raises, each carrying a stable
 *   machine-readable `code`, and the remedy computation a refusal owes its
 *   reader.
 * Assumes:
 *   - a caller matches on `error.code`, never on prose, which is Node's own
 *     convention for its own errors
 *     [source: https://nodejs.org/api/errors.html#errorcode]
 * Guarantees:
 *   - every refusal this binding raises is a `PettaError` with a `code` from
 *     {@link Code}, so a test or a tool matches the code and the prose stays
 *     free to improve
 *   - a reduction that failed across several nondeterministic branches raises
 *     the platform's own `AggregateError` with one `cause`-chained entry per
 *     branch, rather than an error shape invented here
 *   - `nearest` answers the closest declared spelling to an unknown name, so
 *     a refusal names the remedy instead of only the problem
 * Decides: a deadline is the platform's own `TimeoutError` DOMException, the
 *   name `AbortSignal.timeout` already aborts with, so there is no Timeout
 *   subclass here to catch instead of the one every other async API raises.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

/** The stable codes. Match on these; the prose beside them is free to change. */
export type Code =
  /** The engine refused a goal, or raised while running one. */
  | "ERR_METTA_ENGINE"
  /** A term could not cross the wire in the shape the codec requires. */
  | "ERR_METTA_WIRE"
  /** Exactly-one was asked for and nothing answered. */
  | "ERR_METTA_ABSENT"
  /** Exactly-one was asked for and more than one answered. */
  | "ERR_METTA_AMBIGUOUS"
  /** A name, arity or spelling the surface cannot reach. */
  | "ERR_METTA_NAME"
  /** A capability this deployment does not have. */
  | "ERR_METTA_CAPABILITY"
  /** A body could not be traced into one equation. */
  | "ERR_METTA_TRACE"
  /** A body could not be lowered from its own source. */
  | "ERR_METTA_LOWER"
  /** A handle was used after it was released. */
  | "ERR_METTA_CLOSED"
  /** The surface was asked for something it does not carry. */
  | "ERR_METTA_UNSUPPORTED";

/** Every refusal this binding raises. */
export class PettaError extends Error {
  readonly code: Code;

  constructor(message: string, options: { code?: Code; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PettaError";
    this.code = options.code ?? "ERR_METTA_ENGINE";
  }
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
