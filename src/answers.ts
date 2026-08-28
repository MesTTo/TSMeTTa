/**
 * Purpose: what an ask answers. A lazy description that streams when iterated,
 *   collapses when awaited, and carries the stream family the platform has not
 *   yet standardised for async iterators.
 * Assumes:
 *   - ES2025 shipped iterator helpers for SYNCHRONOUS iterators only; the async
 *     twins are a separate TC39 proposal still in flight, so the family is
 *     carried here, isomorphic to the synchronous one by construction
 *     [source: tc39/proposal-async-iterator-helpers, Stage 2 as of 2026-08]
 * Guarantees:
 *   - nothing runs until something consumes: building an ask costs no engine
 *     work at all
 *   - `await ans` executes and collapses, which is where Drizzle and Kysely put
 *     execution and is the platform's own promise protocol rather than an
 *     invented `.all()`
 *   - leaving a `for await` early calls the iterator's `return()`, which closes
 *     the cursor and destroys the engine behind it, so an unbounded generator
 *     is safe to walk
 *   - `one()` refuses on zero AND on more than one; `find()` answers
 *     `T | undefined` so `??` composes, which is the contract `Array.find` and
 *     `Map.get` already put in every reader's head
 *   - an `AbortSignal` stops the pull at the next answer boundary, which is
 *     best-effort in exactly the way `fetch` states, because the engine polls
 *     at answer boundaries and nowhere finer
 * Decides: an Answers is RE-RUNNABLE. Awaiting it twice asks twice, because a
 *   lazy description that cached would be a result pretending to be a query,
 *   and a knowledge base can change between the two asks.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { inspect } from "node:util";

import { Atom, Expression, Sym } from "./atom.ts";
import type { Var } from "./atom.ts";
import { MettaError, branchFailure } from "./errors.ts";

/**
 * Whether an atom is one of MeTTa's own error atoms, `(Error culprit why)`.
 *
 * An error is DATA here, which is MeTTa's law and not this binding's choice: a
 * reduction answers one error atom per failing branch, and successful branches
 * answer beside them, so a program may match on one, count them, or ignore
 * them. `orThrow` is the opt-in door for a caller who would rather be
 * interrupted.
 */
export function isError(atom: unknown): atom is Expression {
  return (
    atom instanceof Expression &&
    atom.items.length > 0 &&
    atom.items[0] instanceof Sym &&
    (atom.items[0] as Sym).name === "Error"
  );
}

/** One error atom, as the host error it describes. The atom rides as the cause. */
export function errorOf(atom: Expression): MettaError {
  const why = atom.items[2];
  const culprit = atom.items[1];
  const message =
    why === undefined
      ? atom.text
      : `${String(culprit ?? "")} ${why instanceof Sym ? why.name : why.text}`.trim();
  return new MettaError(message, { cause: atom });
}

/**
 * What an ask IS, in a form a traced body can lower instead of running.
 *
 * An ask is lazy, so under the define door it is never run at all: the tracer
 * reads this and builds the equation the goal belongs to. Under the op door
 * the same ask runs. One notation, and the door chooses the meaning.
 */
export type Plan =
  | {
      readonly kind: "match";
      /** The space to search, by engine name. */
      readonly space: string;
      /** The pattern, as written. */
      readonly pattern: Atom;
      /** Its variables, in first-seen order: the row's columns. */
      readonly vars: readonly Var[];
    }
  | {
      readonly kind: "eval";
      /** The space to reduce in, by engine name. */
      readonly space: string;
      /** The term to reduce. */
      readonly term: Atom;
    };

/** The marker a yieldable ask produces, so a driver can tell it from an emission. */
export const GOAL: unique symbol = Symbol("metta.goal");

/** One asked goal, as it reaches the body's driver. */
export interface GoalRequest<T = unknown> {
  readonly [GOAL]: true;
  readonly answers: Answers<T>;
}

/** Whether a yielded value is an asked goal rather than an emitted answer. */
export function isGoalRequest(value: unknown): value is GoalRequest {
  return typeof value === "object" && value !== null && GOAL in value;
}

/**
 * One binding row: each asked-for variable mapped to the atom it took.
 *
 * The values are ATOMS rather than unwrapped host values, so an answer
 * composes straight back into the next term: `m.match(p).map(({x, y}) =>
 * S.edge(x, y))` needs no lifting. `hostValue(atom)` is the door for the
 * plain value.
 */
export type Row = Record<string, Atom>;

/** What an ask accepts beside the pattern itself. */
export interface AskOptions {
  /**
   * A deadline or a cancellation.
   *
   * `AbortSignal.timeout(50)` is the deadline and `AbortSignal.any([...])`
   * composes several. Cancellation is checkpoint-granular: the engine is asked
   * to stop between answers, so a single very long reduction runs to its next
   * answer before it notices. That is `fetch`'s own contract, said plainly.
   */
  readonly signal?: AbortSignal;
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw signal.reason as Error;
}

/**
 * Let the event loop run one turn.
 *
 * The engine is IN this process and a pull is synchronous, so a loop that only
 * awaits already-resolved promises never leaves the microtask queue and no
 * timer ever fires. `AbortSignal.timeout(80)` on an unbounded generator then
 * never aborts at all: the deadline is a timer, and the timer is starved by
 * the very loop it was meant to stop. Measured 2026-08-27, before this: the
 * process ran until it was killed.
 *
 * `setImmediate` is a MACROTASK, so timers get their turn. It costs about a
 * microsecond, and it is paid only by an ask that actually carries a signal.
 */
function breathe(): Promise<void> {
  return new Promise((resume) => setImmediate(resume));
}

/**
 * The answers to one ask: a description first, a stream second, a set third.
 *
 * ```ts
 * const ans = m.match(S.parent(V.x, S.bob));  // nothing has run
 * for await (const { x } of ans) { ... }       // one answer at a time
 * const rows = await ans;                      // the whole answer set
 * const who = await ans.one();                 // exactly one
 * const maybe = (await ans.find()) ?? S.none;  // at most one
 * ```
 */
export class Answers<T> implements AsyncIterable<T>, PromiseLike<T[]> {
  /** How this ask reads, for a console that must not consume it to print it. */
  readonly description: string;

  /**
   * What this ask is, when something needs to lower it rather than run it.
   *
   * Present on an ask a body can name as a goal; absent on one derived by
   * `map` or `filter`, because a host-side transform has no MeTTa spelling.
   */
  readonly plan: Plan | undefined;

  #open: (signal: AbortSignal | undefined) => AsyncIterator<T>;
  #signal: AbortSignal | undefined;

  /** @internal Built by the ask doors; not a constructor a program calls. */
  constructor(
    description: string,
    open: (signal: AbortSignal | undefined) => AsyncIterator<T>,
    signal?: AbortSignal,
    plan?: Plan,
  ) {
    this.description = description;
    this.#open = open;
    this.#signal = signal;
    this.plan = plan;
  }

  /**
   * The yieldable protocol: inside a body, `yield* ans` ASKS this goal.
   *
   * ```ts
   * const { y } = yield* m.match(S.parent(x, V.y));
   * ```
   *
   * The generator yields a request, the driver decides what asking means under
   * the door it is running, and `yield*` answers with what the driver sends
   * back: the pattern's own variables while a body is being traced, and a real
   * binding row while one is running. This is the same typing trick Effect uses
   * to make generators TypeScript's do-notation.
   *
   * The fence, said once: this makes an ask synchronously iterable, so
   * `for (const x of ans)` walks the PROTOCOL and not the answers. The loop
   * over answers is `for await`.
   */
  *[Symbol.iterator](): Generator<GoalRequest<T>, T, unknown> {
    return (yield { [GOAL]: true, answers: this }) as T;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    // The signal is honoured HERE, on the base iterator, and not only on the
    // derived ones. Accepting a deadline and then not checking it is worse
    // than refusing one: an unbounded generator would run until the process
    // ran out of memory, having been asked politely to stop.
    const source = this.#open(this.#signal);
    if (this.#signal === undefined) return source;
    return withSignal(source, this.#signal)[Symbol.asyncIterator]();
  }

  get [Symbol.toStringTag](): string {
    return "Answers";
  }

  /** A lazy ask prints as the ask it is, never as a half-consumed object. */
  toString(): string {
    return `Answers(${this.description})`;
  }

  /**
   * The collapse door.
   *
   * `await ans` runs the ask and answers the whole set. One fence to know:
   * returning an Answers from an `async function` awaits it implicitly, so the
   * lazy handle does not survive an async return. Say `return { ans }` or
   * hand it back from a synchronous function when the laziness is the point.
   */
  then<R1 = T[], R2 = never>(
    onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.toArray().then(onFulfilled, onRejected);
  }

  /** Every answer, collected. `Array.fromAsync(ans)` is the same door, spelled by the platform. */
  async toArray(): Promise<T[]> {
    const collected: T[] = [];
    for await (const answer of this) collected.push(answer);
    return collected;
  }

  /** How many answers there are. Multiplicity is law, so a repeat counts twice. */
  async count(): Promise<number> {
    let total = 0;
    for await (const _answer of this) total += 1;
    return total;
  }

  /**
   * Exactly one answer, or a refusal naming what there was instead.
   *
   * The door for an ask whose answer the program's logic requires to be
   * unique. `const [x] = await ans` cannot enforce that: it takes the first and
   * ignores the rest in silence.
   */
  async one(): Promise<T> {
    const iterator = this[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) {
      throw new MettaError(`no answer to ${this.description}, where exactly one was required`, {
        code: "ERR_METTA_ABSENT",
      });
    }
    const second = await iterator.next();
    if (second.done !== true) {
      await iterator.return?.(undefined);
      throw new MettaError(
        `more than one answer to ${this.description}, where exactly one was required`,
        { code: "ERR_METTA_AMBIGUOUS" },
      );
    }
    return first.value;
  }

  /**
   * At most one answer: the first, or undefined.
   *
   * `Array.prototype.find` and `Map.get` both spell "maybe absent" this way and
   * `??` composes with it, so `await ans.find() ?? fallback` needs no teaching.
   * Pulling stops after the first answer.
   */
  async find(): Promise<T | undefined> {
    const iterator = this[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) return undefined;
    await iterator.return?.(undefined);
    return first.value;
  }

  /** Whether there is any answer at all. Stops at the first one. */
  async exists(): Promise<boolean> {
    return (await this.find()) !== undefined;
  }

  /**
   * Every answer, or a refusal built from the ones that failed.
   *
   * MeTTa answers an ERROR ATOM per failing branch and keeps the successful
   * branches beside them, which is what makes an error data. This is the
   * opt-in door for a caller who would rather be interrupted: one failing
   * branch raises its own error, several raise the platform's own
   * `AggregateError` with one entry per branch, each carrying its error atom
   * as `cause`. Nothing is invented; `AggregateError` is ECMAScript's word for
   * exactly this.
   *
   * ```ts
   * try { await m.eval(term).orThrow(); }
   * catch (e) { if (e instanceof AggregateError) console.log(e.errors); }
   * ```
   */
  async orThrow(): Promise<T[]> {
    const answers = await this.toArray();
    const failed = answers.filter((answer): answer is T & Expression => isError(answer));
    if (failed.length === 0) return answers;
    throw branchFailure(
      failed.map((atom) => errorOf(atom)),
      `${this.description} failed in ${String(failed.length)} branches`,
    );
  }

  #derive<U>(description: string, step: (source: AsyncIterable<T>) => AsyncIterator<U>): Answers<U> {
    const source: Answers<T> = this;
    // A derived ask carries no plan: a host-side transform has no MeTTa
    // spelling, so a traced body that yields one refuses by name rather than
    // lowering something that would not mean the same thing.
    return new Answers<U>(
      description,
      () => step({ [Symbol.asyncIterator]: () => source[Symbol.asyncIterator]() }),
      this.#signal,
    );
  }

  /** Each answer through `transform`, lazily. */
  map<U>(transform: (answer: T, index: number) => U | Promise<U>): Answers<U> {
    return this.#derive<U>(`${this.description}.map`, (source) => mapping(source, transform));
  }

  /** The answers `keep` admits, lazily. */
  filter(keep: (answer: T, index: number) => boolean | Promise<boolean>): Answers<T> {
    return this.#derive<T>(`${this.description}.filter`, (source) => filtering(source, keep));
  }

  /** The first `count` answers; the rest are never computed. */
  take(count: number): Answers<T> {
    return this.#derive<T>(`${this.description}.take(${String(count)})`, (source) =>
      taking(source, count),
    );
  }

  /** Every answer past the first `count`. */
  drop(count: number): Answers<T> {
    return this.#derive<T>(`${this.description}.drop(${String(count)})`, (source) =>
      dropping(source, count),
    );
  }

  /** Each answer expanded into many, lazily. */
  flatMap<U>(transform: (answer: T, index: number) => Iterable<U> | AsyncIterable<U>): Answers<U> {
    return this.#derive<U>(`${this.description}.flatMap`, (source) => flatMapping(source, transform));
  }

  /** Fold the answers, left to right. */
  async reduce<A>(step: (accumulator: A, answer: T, index: number) => A | Promise<A>, seed: A): Promise<A> {
    let accumulator = seed;
    let index = 0;
    for await (const answer of this) {
      accumulator = await step(accumulator, answer, index);
      index += 1;
    }
    return accumulator;
  }

  /** Run `visit` for each answer. */
  async forEach(visit: (answer: T, index: number) => void | Promise<void>): Promise<void> {
    let index = 0;
    for await (const answer of this) {
      await visit(answer, index);
      index += 1;
    }
  }

  /** Whether any answer satisfies `test`. Stops at the first that does. */
  async some(test: (answer: T, index: number) => boolean | Promise<boolean>): Promise<boolean> {
    let index = 0;
    for await (const answer of this) {
      if (await test(answer, index)) return true;
      index += 1;
    }
    return false;
  }

  /** Whether every answer satisfies `test`. Stops at the first that does not. */
  async every(test: (answer: T, index: number) => boolean | Promise<boolean>): Promise<boolean> {
    let index = 0;
    for await (const answer of this) {
      if (!(await test(answer, index))) return false;
      index += 1;
    }
    return true;
  }

  /** The same ask under a deadline or a cancellation. */
  until(signal: AbortSignal): Answers<T> {
    return new Answers<T>(this.description, this.#open, signal, this.plan);
  }
}

/** Console honesty: a lazy ask prints as its description. */
Object.defineProperty(Answers.prototype, inspect.custom, {
  value: function inspectAnswers(this: Answers<unknown>): string {
    return this.toString();
  },
  enumerable: false,
  writable: false,
  configurable: false,
});

// ---------------------------------------------------------------------------
// The helper family. Each one closes the source it wraps when it stops early,
// which is what keeps `take(1)` from leaving an engine open behind it.

function withSignal<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal | undefined,
): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      async next(): Promise<IteratorResult<T>> {
        aborted(signal);
        // One event-loop turn per answer, so a deadline that is a TIMER gets
        // to fire; without it the synchronous pull starves its own signal.
        await breathe();
        aborted(signal);
        const step = await iterator.next();
        aborted(signal);
        return step;
      },
      async return(value?: unknown): Promise<IteratorResult<T>> {
        await iterator.return?.(value);
        return { done: true, value: undefined as never };
      },
    }),
  };
}

async function* mapping<T, U>(
  source: AsyncIterable<T>,
  transform: (answer: T, index: number) => U | Promise<U>,
): AsyncGenerator<U> {
  let index = 0;
  for await (const answer of source) {
    yield await transform(answer, index);
    index += 1;
  }
}

async function* filtering<T>(
  source: AsyncIterable<T>,
  keep: (answer: T, index: number) => boolean | Promise<boolean>,
): AsyncGenerator<T> {
  let index = 0;
  for await (const answer of source) {
    if (await keep(answer, index)) yield answer;
    index += 1;
  }
}

async function* taking<T>(source: AsyncIterable<T>, count: number): AsyncGenerator<T> {
  if (count <= 0) return;
  let taken = 0;
  for await (const answer of source) {
    yield answer;
    taken += 1;
    // The `break` is what calls the source's return(), which closes the
    // cursor: the answers past this one are never computed.
    if (taken >= count) break;
  }
}

async function* dropping<T>(source: AsyncIterable<T>, count: number): AsyncGenerator<T> {
  let seen = 0;
  for await (const answer of source) {
    if (seen >= count) yield answer;
    seen += 1;
  }
}

async function* flatMapping<T, U>(
  source: AsyncIterable<T>,
  transform: (answer: T, index: number) => Iterable<U> | AsyncIterable<U>,
): AsyncGenerator<U> {
  let index = 0;
  for await (const answer of source) {
    const inner = transform(answer, index);
    if (Symbol.asyncIterator in inner) {
      for await (const item of inner as AsyncIterable<U>) yield item;
    } else {
      for (const item of inner as Iterable<U>) yield item;
    }
    index += 1;
  }
}

/** An ask over answers already in hand. The empty case and the test case. */
export function answersOf<T>(description: string, values: readonly T[]): Answers<T> {
  return new Answers<T>(description, () => {
    let index = 0;
    return {
      next: (): Promise<IteratorResult<T>> =>
        Promise.resolve(
          index < values.length
            ? { done: false, value: values[index++] as T }
            : { done: true, value: undefined as never },
        ),
      return: (): Promise<IteratorResult<T>> =>
        Promise.resolve({ done: true, value: undefined as never }),
    };
  });
}
