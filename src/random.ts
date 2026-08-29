/**
 * Purpose: one deterministic pseudo-random source, shared by everything here
 *   that draws.
 * Assumes:
 *   - a caller who draws wants REPRODUCIBILITY before variety: a generated
 *     test that cannot reproduce the run that failed is not a test, and a
 *     seeded simulation that answers differently twice is not a simulation
 * Guarantees:
 *   - the same seed produces the same draws, on every platform and every run,
 *     because the source is arithmetic here rather than `Math.random`
 *     [tested: "generates the same atoms from the same seed"]
 * Decides: `mulberry32`. Thirty-two bits of state, four operations a draw, and
 *   a period long enough for any test or simulation this package hosts. It is
 *   not a cryptographic source and nothing here should use it as one.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { MettaError } from "./errors.ts";

/** A deterministic pseudo-random source. */
export class Random {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** The next draw, in `[0, 1)`. */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** An integer in `[low, high]`. */
  between(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  /** One of these, uniformly. */
  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new MettaError("cannot pick from nothing");
    return values[this.between(0, values.length - 1)] as T;
  }

  /**
   * One of these, with the given weights.
   *
   * The cumulative-sum selection: draw once into the total and walk until the
   * running sum passes it. A weight of zero is never selected, and the last
   * item absorbs the floating-point remainder so a draw can never fall off the
   * end.
   */
  weighted<T>(values: readonly T[], weights: readonly number[]): T {
    if (values.length === 0) throw new MettaError("cannot pick from nothing");
    let total = 0;
    for (const weight of weights) total += weight;
    if (total <= 0) throw new MettaError("every weight is zero, so nothing can be drawn");
    let at = this.next() * total;
    for (let index = 0; index < values.length; index += 1) {
      at -= weights[index] ?? 0;
      if (at < 0) return values[index] as T;
    }
    return values[values.length - 1] as T;
  }
}
