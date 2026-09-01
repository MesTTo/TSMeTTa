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
 *   - successive deadlines and cancellation signals compose, so a wrapper
 *     cannot discard a bound the ask already carried
 *     [tested: "composes successive cancellation signals instead of replacing the first",
 *     "preserves a branch's own deadline while adding race cancellation"; commit=0fc1435242a699749fdd6ba3995239648c02242e]
 *   - rendering a row table scans widths iteratively, so the row count is not
 *     constrained by V8's function-argument ceiling [tested: "formats more
 *     rows than V8 accepts as function arguments"; commit=d3b3d62e19cd5dc941a6af8df24bc48992327236]
 *   - existence is decided by iterator completion rather than the answer's
 *     value, and invalid chunk sizes raise the matching `UnsupportedError`
 *     [tested: "finds an undefined answer by iterator completion";
 *     "classifies invalid chunk sizes as unsupported"; commit=WORKTREE]
 *   - negative positions retain a circular tail with constant work per answer
 *     and use `Array.prototype.at`'s numeric-index coercion
 *     [tested: "keeps a circular tail with Array.at index coercion";
 *     commit=WORKTREE]
 * Decides: an Answers is RE-RUNNABLE. Awaiting it twice asks twice, because a
 *   lazy description that cached would be a result pretending to be a query,
 *   and a knowledge base can change between the two asks.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, Sym } from "./atom.ts";
import type { Var } from "./atom.ts";
import { MettaError, ResultError, UnsupportedError, branchFailure } from "./errors.ts";
import { showsAs } from "./present.ts";

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
      /** The space to search, by its complete engine identity. */
      readonly space: Atom;
      /** The pattern, as written. */
      readonly pattern: Atom;
      /** Its variables, in first-seen order: the row's columns. */
      readonly vars: readonly Var[];
    }
  | {
      readonly kind: "eval";
      /** The space to reduce in, by its complete engine identity. */
      readonly space: Atom;
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
      throw new ResultError(`no answer to ${this.description}, where exactly one was required`);
    }
    const second = await iterator.next();
    if (second.done !== true) {
      await iterator.return?.(undefined);
      throw new ResultError(
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
    const iterator = this[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done === true) return false;
    await iterator.return?.(undefined);
    return true;
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

  /**
   * Every answer as a ROW TABLE, with the columns the pattern binds.
   *
   * The eager door for a query whose answers a program is about to show, sort
   * or write out: `await ans` gives loose rows, and this gives the same rows
   * knowing what their columns are.
   */
  async rows(this: Answers<Row>): Promise<Rows> {
    const collected = await this.toArray();
    const plan = this.plan;
    const columns =
      plan?.kind === "match"
        ? plan.vars.map((variable) => variable.name)
        : [...new Set(collected.flatMap((row) => Object.keys(row)))];
    return new Rows(columns, collected);
  }

  /** The same ask under a deadline or a cancellation. */
  until(signal: AbortSignal): Answers<T> {
    const combined =
      this.#signal === undefined ? signal : AbortSignal.any([this.#signal, signal]);
    return new Answers<T>(this.description, this.#open, combined, this.plan);
  }

  /**
   * The same ask, bounded by a deadline in milliseconds.
   *
   * `ans.timeout(50)` is `ans.until(AbortSignal.timeout(50))`, which is the
   * platform's own deadline and aborts with the platform's own `TimeoutError`.
   * Checkpoint-granular, like every other deadline here.
   */
  timeout(ms: number): Answers<T> {
    return this.until(AbortSignal.timeout(ms));
  }

  /**
   * The answer at one position, counting from the end when negative.
   *
   * `Array.prototype.at`'s contract, done lazily: a non-negative index stops
   * pulling as soon as it is reached, so `ans.at(0)` costs one answer.
   */
  async at(index: number): Promise<T | undefined> {
    const position = Number.isNaN(index) ? 0 : Math.trunc(index);
    if (position >= 0) {
      let seen = 0;
      for await (const answer of this) {
        if (seen === position) return answer;
        seen += 1;
      }
      return undefined;
    }
    if (position === Number.NEGATIVE_INFINITY) return undefined;
    // From the end: keep the last |index| answers in a ring rather than the
    // whole set, so `at(-1)` over a million answers holds one.
    const wanted = -position;
    const ring: T[] = [];
    let write = 0;
    for await (const answer of this) {
      if (ring.length < wanted) ring.push(answer);
      else {
        ring[write] = answer;
        write = (write + 1) % wanted;
      }
    }
    return ring.length === wanted ? ring[write] : undefined;
  }

  /** The last answer, or undefined. Pulls the whole set, holding one answer. */
  async last(): Promise<T | undefined> {
    return this.at(-1);
  }

  /**
   * Each distinct answer, lazily, keeping the first of each.
   *
   * Atoms are interned, so the default key IS the atom and a `Set` decides
   * distinctness structurally with no comparison written here. Pass `key` for
   * a row, where the whole row is rarely the identity that matters.
   *
   * Multiplicity is MeTTa's law, so this is an explicit narrowing rather than
   * something the ask does on its own.
   */
  unique(key?: (answer: T) => unknown): Answers<T> {
    return this.#derive<T>(`${this.description}.unique`, (source) => uniquely(source, key));
  }

  /**
   * The answers in runs of `size`, lazily; the last run may be short.
   *
   * The door for a bulk write: `for await (const batch of ans.chunk(500))
   * other.add(...batch)` costs one crossing per five hundred answers rather
   * than one per answer.
   */
  chunk(size: number): Answers<T[]> {
    if (!Number.isSafeInteger(size) || size <= 0) {
      throw new UnsupportedError(`a chunk needs a positive whole-number size, not ${String(size)}`);
    }
    return this.#derive<T[]>(`${this.description}.chunk(${String(size)})`, (source) =>
      chunking(source, size),
    );
  }

  /**
   * Each answer through `visit`, unchanged, lazily.
   *
   * The observation door: logging or counting inside a pipeline without
   * collapsing it. `map` would change the answers; this cannot.
   */
  tap(visit: (answer: T, index: number) => void | Promise<void>): Answers<T> {
    return this.#derive<T>(`${this.description}.tap`, (source) => tapping(source, visit));
  }

  /** Every answer as a Map, keyed by `key`. A repeated key keeps the last. */
  async toMap<K, V = T>(
    key: (answer: T, index: number) => K,
    value?: (answer: T, index: number) => V,
  ): Promise<Map<K, V>> {
    const collected = new Map<K, V>();
    let index = 0;
    for await (const answer of this) {
      collected.set(key(answer, index), value === undefined ? (answer as unknown as V) : value(answer, index));
      index += 1;
    }
    return collected;
  }

  /**
   * The answers grouped by a key, in first-seen order.
   *
   * `Map.groupBy`'s contract for an ASYNCHRONOUS source, which the platform
   * has no door for: `Map.groupBy` takes an iterable, and an ask is not one.
   */
  async groupBy<K>(key: (answer: T, index: number) => K): Promise<Map<K, T[]>> {
    const grouped = new Map<K, T[]>();
    let index = 0;
    for await (const answer of this) {
      const at = key(answer, index);
      const held = grouped.get(at);
      if (held === undefined) grouped.set(at, [answer]);
      else held.push(answer);
      index += 1;
    }
    return grouped;
  }

  /**
   * This ask as a Web `ReadableStream`, so it composes with the platform.
   *
   * The bridge to everything that speaks streams: `Response`, `pipeThrough`,
   * `Readable.fromWeb`. Backpressure is real, because a stream only pulls when
   * its consumer asks, and cancelling the reader closes the cursor behind it.
   */
  stream(): ReadableStream<T> {
    let iterator: AsyncIterator<T> | undefined;
    const open = (): AsyncIterator<T> => (iterator ??= this[Symbol.asyncIterator]());
    return new ReadableStream<T>({
      pull: async (controller): Promise<void> => {
        const step = await open().next();
        if (step.done === true) controller.close();
        else controller.enqueue(step.value);
      },
      cancel: async (): Promise<void> => {
        await iterator?.return?.(undefined);
      },
    });
  }
}

// Console honesty: a lazy ask prints as its description, and printing it does
// not consume it.
showsAs(Answers.prototype, (answers: Answers<unknown>) => answers.toString());

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

async function* uniquely<T>(
  source: AsyncIterable<T>,
  key: ((answer: T) => unknown) | undefined,
): AsyncGenerator<T> {
  const seen = new Set<unknown>();
  for await (const answer of source) {
    const at = key === undefined ? answer : key(answer);
    if (seen.has(at)) continue;
    seen.add(at);
    yield answer;
  }
}

async function* chunking<T>(source: AsyncIterable<T>, size: number): AsyncGenerator<T[]> {
  let run: T[] = [];
  for await (const answer of source) {
    run.push(answer);
    if (run.length >= size) {
      yield run;
      run = [];
    }
  }
  if (run.length > 0) yield run;
}

async function* tapping<T>(
  source: AsyncIterable<T>,
  visit: (answer: T, index: number) => void | Promise<void>,
): AsyncGenerator<T> {
  let index = 0;
  for await (const answer of source) {
    await visit(answer, index);
    index += 1;
    yield answer;
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

/**
 * Every answer to a query, in the order the engine produced them, with the
 * columns it was asked for.
 *
 * ```ts
 * const rows = await m.match(S.parent(V.parent, V.child)).rows();
 * rows.columns;                     // ["parent", "child"]
 * rows.column("child");             // every child, in order
 * console.log(rows.toTable());      // an aligned table, for a terminal
 * ```
 *
 * An ordinary array underneath, so `map`, `filter`, `length` and destructuring
 * all mean what they mean. What it adds is the two things an array of loose
 * objects cannot say: which columns there ARE, and how to show them.
 */
export class Rows extends Array<Row> {
  /** The columns, in the order the pattern binds them. */
  readonly columns: readonly string[];

  /** @internal Use `Answers.rows()`. */
  constructor(columns: readonly string[], rows: readonly Row[] = []) {
    super();
    // `Array`'s own constructor reads a single number as a LENGTH, so the rows
    // are pushed rather than spread into it.
    this.columns = [...columns];
    for (const row of rows) this.push(row);
  }

  /**
   * Answer plain arrays from `map`, `filter` and the rest.
   *
   * Without this, every derived array would be a `Rows` built by the species
   * constructor with a NUMBER, which `Array` reads as a length. The columns
   * belong to the query, not to whatever a caller mapped its rows into.
   */
  static override get [Symbol.species](): ArrayConstructor {
    return Array;
  }

  /** One column's values, in row order. */
  column(name: string): Atom[] {
    if (!this.columns.includes(name)) {
      throw new MettaError(
        `no column ${name}; this query binds ${this.columns.join(", ") || "nothing"}`,
      );
    }
    return this.map((row) => row[name] as Atom);
  }

  /** Every row as plain text, which is what a log or a CSV wants. */
  toTable(): string {
    const widths = this.columns.map((name) => name.length);
    const rendered: string[][] = [];
    for (const row of this) {
      const cells: string[] = [];
      for (let at = 0; at < this.columns.length; at += 1) {
        const name = this.columns[at] as string;
        const cell = String(row[name] ?? "");
        cells.push(cell);
        widths[at] = Math.max(widths[at] ?? 0, cell.length);
      }
      rendered.push(cells);
    }
    const line = (cells: readonly string[]): string =>
      cells.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join("  ").trimEnd();
    const lines = [
      line(this.columns),
      line(this.columns.map((_, at) => "-".repeat(widths[at] ?? 0))),
    ];
    for (const cells of rendered) lines.push(line(cells));
    return lines.join("\n");
  }

  override toString(): string {
    return `Rows(${String(this.length)} x ${this.columns.join(", ")})`;
  }
}

showsAs(Rows.prototype, (rows: Rows) => (rows.length === 0 ? rows.toString() : rows.toTable()));

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
