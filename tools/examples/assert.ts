/**
 * Purpose: stand in for `node:assert/strict` inside a program the runner
 *   executes, so every assertion the program makes is counted without the
 *   program importing anything but Node's own module.
 * Assumes: side.ts registers a resolve hook that points a program's
 *   `node:assert/strict` (and `assert/strict`) here, and this module's own
 *   import of the real module is exempt from that hook.
 * Guarantees:
 *   - every function `node:assert/strict` exports that asserts is counted once
 *     per call, whether it is reached as the default export's call, as a method
 *     of it, or as a named import [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "counts
 *     every way a program can reach an assertion"]
 *   - what an assertion does is untouched: the wrapper calls the real function
 *     with the same receiver and arguments and returns what it returns, so a
 *     failing claim still throws Node's own AssertionError
 *   - the classes (`AssertionError`, `CallTracker`, `Assert`) pass through
 *     unwrapped, so `instanceof` and construction keep working
 */
import real from "node:assert/strict";

let made = 0;

/** How many assertions this process has made so far. */
export function claims(): number {
  return made;
}

type Assertion = (...args: never[]) => unknown;

function counted<F extends Assertion>(assertion: F): F {
  return function (this: unknown, ...args: never[]): unknown {
    made += 1;
    return assertion.apply(this, args);
  } as F;
}

const CLASSES = new Set(["AssertionError", "CallTracker", "Assert"]);

const assert: typeof real = counted(real);
for (const [name, value] of Object.entries(real)) {
  (assert as unknown as Record<string, unknown>)[name] =
    typeof value === "function" && !CLASSES.has(name) ? counted(value as Assertion) : value;
}
(assert as unknown as { strict: typeof real }).strict = assert;

export default assert;
export const deepEqual: typeof real.deepEqual = assert.deepEqual;
export const deepStrictEqual: typeof real.deepStrictEqual = assert.deepStrictEqual;
export const doesNotMatch: typeof real.doesNotMatch = assert.doesNotMatch;
export const doesNotReject: typeof real.doesNotReject = assert.doesNotReject;
export const doesNotThrow: typeof real.doesNotThrow = assert.doesNotThrow;
export const equal: typeof real.equal = assert.equal;
export const fail: typeof real.fail = assert.fail;
export const ifError: typeof real.ifError = assert.ifError;
export const match: typeof real.match = assert.match;
export const notDeepEqual: typeof real.notDeepEqual = assert.notDeepEqual;
export const notDeepStrictEqual: typeof real.notDeepStrictEqual = assert.notDeepStrictEqual;
export const notEqual: typeof real.notEqual = assert.notEqual;
export const notStrictEqual: typeof real.notStrictEqual = assert.notStrictEqual;
export const ok: typeof real.ok = assert.ok;
export const partialDeepStrictEqual: typeof real.partialDeepStrictEqual =
  assert.partialDeepStrictEqual;
export const rejects: typeof real.rejects = assert.rejects;
export const strictEqual: typeof real.strictEqual = assert.strictEqual;
export const throws: typeof real.throws = assert.throws;
export const strict: typeof real = assert;
export const AssertionError: typeof real.AssertionError = real.AssertionError;
