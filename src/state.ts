/**
 * Purpose: a state cell, spelled the way JavaScript's own mutable collections
 *   are spelled.
 * Assumes:
 *   - the engine carries `new-state`, `get-state` and `change-state!`
 *     [tested: "answers itself on write, as Map.set does"]
 * Guarantees:
 *   - `set` answers the CELL, so a write composes with a read in one
 *     expression, which is what `Map.prototype.set` and `Set.prototype.add`
 *     already do [tested: "reads, transforms and writes in one step"]
 *   - the cell's type parameter and the engine's parametric `StateMonad` type
 *     are ONE declaration read in two realms
 * Decides: the Python side records that attribute assignment answers nothing
 *   there, so a write-then-read composition needed the engine's own names.
 *   Assignment IS an expression in JavaScript and the platform's collections
 *   answer their subject on write, so the wart dissolves and the cell takes
 *   the native convention instead of the engine's spelling.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, expr, sym, toAtom } from "./atom.ts";
import { type Space, hostValue } from "./space.ts";
import { showsAs } from "./present.ts";

/**
 * A literal widened to the type it is a literal OF.
 *
 * `m.state(1)` means a cell of numbers, not a cell of the number 1, so
 * `cell.set(2)` is legal. Without this, inference pins `T` to `1` and the
 * second write is a type error, which is a promise the cell never meant to
 * make.
 */
export type Widen<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends bigint
        ? bigint
        : T;

/** What a cell is created with. */
export interface StateOptions {
  /** The space the cell lives in. The engine's own, by default. */
  readonly space?: Space;
  /** The MeTTa type the cell's contents carry, declared when it is created. */
  readonly type?: Term;
}

/** What a cell needs of the surface, structurally, so there is no cycle. */
interface CellHost {
  readonly self: Space;
  eval(term: Term): { one(): Promise<Atom> };
  runOne(term: Atom, space: Space): Atom;
}

/**
 * A state cell: one mutable slot the engine holds.
 *
 * ```ts
 * const cell = m.state(S.rest);
 * cell.set(S.active).value;     // "the write answers the cell", as Map.set does
 * ```
 *
 * The handle is opaque and records its type when it is created, so a cell of
 * `Number` refuses a `String` at the write rather than at the next read.
 */
export class State<T extends Term = Term> {
  #host: CellHost;
  #space: Space;

  /** The engine-side handle. It is an atom, so it goes into a term. */
  readonly handle: Atom;

  /** @internal Use `m.state(...)`. */
  constructor(host: CellHost, initial: T, options: StateOptions = {}) {
    this.#host = host;
    this.#space = options.space ?? host.self;
    const made =
      options.type === undefined
        ? expr(sym("new-state"), toAtom(initial))
        : expr(sym("new-state"), expr(sym(":"), toAtom(initial), toAtom(options.type)));
    this.handle = host.runOne(made, this.#space);
  }

  /** What the cell holds now. */
  get value(): Atom {
    return this.#host.runOne(expr(sym("get-state"), this.handle), this.#space);
  }

  /** The host value the cell holds, for a cell of ordinary data. */
  get held(): unknown {
    return hostValue(this.value);
  }

  /**
   * Write, and answer the CELL.
   *
   * `Map.prototype.set` answers the map and `Set.prototype.add` answers the
   * set; a cell answers itself for the same reason, so `cell.set(x).value` is
   * one expression and needs no engine name to compose.
   */
  set(next: T): this {
    this.#host.runOne(expr(sym("change-state!"), this.handle, toAtom(next)), this.#space);
    return this;
  }

  /** Read, transform, write, and answer the cell. */
  update(step: (current: Atom) => T): this {
    return this.set(step(this.value));
  }

  toString(): string {
    return this.handle.text;
  }

  get [Symbol.toStringTag](): string {
    return `State(${this.handle.text})`;
  }
}

showsAs(State.prototype, (cell: State) => `State(${cell.handle.text})`);
