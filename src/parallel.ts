/**
 * Purpose: the coordination verbs, spelled with the platform's own
 *   concurrency rather than the engine's.
 * Assumes:
 *   - a WebAssembly SWI has no `library(thread)`, so the engine's own
 *     `spawn`, `every`, `par-map`, `par-race` and `channel` heads are ABSENT
 *     from this build [source: ai-node-typescript-constraints.md, constraint C11, measured 2026-08-27]. That is
 *     not a gap to paper over: JavaScript's concurrency is the event loop, and
 *     the event loop is exactly where a reduction that reaches an asynchronous
 *     host operation yields
 *   - therefore concurrency here is real wherever the work AWAITS, which is
 *     every host operation that touches a network, a file or a timer, and it
 *     is interleaving rather than parallelism for pure reduction, which is
 *     what one engine can honestly offer
 * Guarantees:
 *   - every verb here takes an `AbortSignal`, and cancelling one cancels the
 *     work under it: `race` aborts its losers, `parMap` stops starting new
 *     work, `every` stops repeating [tested: "cancels the losing branches"]
 *   - `parMap` preserves INPUT order in its answer whatever order the work
 *     finished in, which is what makes it a map rather than a gather
 *   - a `Channel` bounded by `max` makes a sender WAIT rather than dropping,
 *     which is `queue.Queue`'s policy and not `deque(maxlen=)`'s
 *   - `Channel.size` is the one queued-value count; the surface carries no
 *     synonymous alias [tested: "keeps one name for the queued count";
 *     commit=WORKTREE]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Answers } from "./answers.ts";
import { MettaError } from "./errors.ts";
import { showsAs } from "./present.ts";

/** What a concurrent verb accepts beside its work. */
export interface ConcurrencyOptions {
  /** A deadline or a cancellation. */
  readonly signal?: AbortSignal;
  /** How many pieces of work may be in flight at once. Unbounded by default. */
  readonly concurrency?: number;
}

/**
 * The first answer wins, and the losers are cancelled.
 *
 * ```ts
 * const first = await race([m.eval(slow), m.eval(fast)]);
 * ```
 *
 * `Promise.any` is the platform's word for "the first that succeeds", and this
 * is that word with the cancellation wired: each ask runs under a signal of
 * its own, and the winner aborts its siblings.
 */
export async function race<T>(asks: readonly Answers<T>[]): Promise<T> {
  if (asks.length === 0) throw new MettaError("a race needs at least one ask");
  const controller = new AbortController();
  try {
    return await Promise.any(
      asks.map(async (ask) => {
        const first = await ask.until(controller.signal).find();
        if (first === undefined) throw new MettaError("this branch answered nothing");
        return first;
      }),
    );
  } finally {
    controller.abort(new MettaError("another branch answered first"));
  }
}

/**
 * Every ask's answers, interleaved as they arrive.
 *
 * The gather to `race`'s first-past-the-post: nothing waits for a slow branch
 * before yielding a fast one's answer, and the whole thing ends when every
 * branch has.
 */
export function merge<T>(...asks: readonly Answers<T>[]): Answers<T> {
  const description = `merge(${asks.map((ask) => ask.description).join(", ")})`;
  return new Answers<T>(description, (signal) => interleave(asks, signal));
}

function interleave<T>(
  asks: readonly Answers<T>[],
  signal: AbortSignal | undefined,
): AsyncIterator<T> {
  const open = asks.map((ask) =>
    (signal === undefined ? ask : ask.until(signal))[Symbol.asyncIterator](),
  );
  // One outstanding pull per branch, each tagged with its own index, so a
  // finished branch is dropped and the rest keep going. `Promise.race` over
  // the pending pulls is what makes the interleaving arrival-ordered.
  const pending = new Map<number, Promise<{ at: number; step: IteratorResult<T> }>>();
  const pull = (at: number): void => {
    const source = open[at];
    if (source === undefined) return;
    pending.set(
      at,
      source.next().then((step) => ({ at, step })),
    );
  };
  open.forEach((_, at) => pull(at));
  return {
    async next(): Promise<IteratorResult<T>> {
      for (;;) {
        if (pending.size === 0) return { done: true, value: undefined as never };
        const { at, step } = await Promise.race(pending.values());
        pending.delete(at);
        if (step.done === true) continue;
        pull(at);
        return { done: false, value: step.value };
      }
    },
    async return(): Promise<IteratorResult<T>> {
      pending.clear();
      await Promise.all(open.map((source) => source.return?.(undefined)));
      return { done: true, value: undefined as never };
    },
  };
}

/**
 * Map over items with a bound on how many run at once, in INPUT order.
 *
 * ```ts
 * const rows = await parMap(ids, (id) => m.eval(S.fetch(id)).one(), { concurrency: 8 });
 * ```
 *
 * The shape `p-map` made the Node convention, and the reason it is here rather
 * than assumed: an unbounded `Promise.all` over ten thousand items opens ten
 * thousand host operations at once, and a bound is the difference between
 * concurrency and a denial of service against your own process.
 */
export async function parMap<T, R>(
  items: Iterable<T>,
  work: (item: T, index: number) => R | Promise<R>,
  options: ConcurrencyOptions = {},
): Promise<R[]> {
  const list = [...items];
  const limit = Math.max(1, options.concurrency ?? list.length);
  const answers = new Array<R>(list.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) throw options.signal.reason as Error;
      const at = next;
      next += 1;
      if (at >= list.length) return;
      answers[at] = await work(list[at] as T, at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runner));
  return answers;
}

/**
 * Repeat work on an interval until the signal aborts, answering each result.
 *
 * ```ts
 * const stop = AbortSignal.timeout(5_000);
 * for await (const rows of every(1_000, () => m.match(pattern).toArray(), { signal: stop })) {
 *   console.log(rows.length);
 * }
 * ```
 *
 * The interval is between the END of one run and the start of the next, so a
 * run slower than the interval never overlaps itself.
 */
export async function* every<T>(
  ms: number,
  work: () => T | Promise<T>,
  options: { readonly signal?: AbortSignal } = {},
): AsyncGenerator<T> {
  // Read through a CALL rather than a property test: the signal is aborted by
  // something outside this loop, and TypeScript's narrowing would otherwise
  // conclude from the first test that the second cannot be true.
  const stopped = (): boolean => options.signal?.aborted === true;
  for (;;) {
    if (stopped()) return;
    yield await work();
    if (stopped()) return;
    if (!(await sleep(ms, options.signal))) return;
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resume) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resume(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resume(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * A mailbox: values in on one side, out on the other, with backpressure.
 *
 * ```ts
 * const jobs = new Channel<Atom>({ max: 100 });
 * void producer(jobs);
 * for await (const job of jobs) await handle(job);
 * ```
 *
 * `max` bounds what is queued and makes a sender WAIT when it is reached,
 * which is `queue.Queue`'s policy rather than a ring buffer's: a full channel
 * slows the producer down instead of silently discarding what it produced.
 */
export class Channel<T> implements AsyncIterable<T> {
  readonly #queued: T[] = [];
  readonly #waitingReceivers: ((value: IteratorResult<T>) => void)[] = [];
  readonly #waitingSenders: (() => void)[] = [];
  readonly #max: number;
  #closed = false;

  constructor(options: { readonly max?: number } = {}) {
    this.#max = options.max ?? Number.POSITIVE_INFINITY;
  }

  /** How many values are queued and not yet received. */
  get size(): number {
    return this.#queued.length;
  }

  /** Whether the channel has been closed. */
  get closed(): boolean {
    return this.#closed;
  }

  /** Put one value in, waiting while the channel is full. */
  async send(value: T): Promise<void> {
    if (this.#closed) throw new MettaError("this channel is closed");
    while (this.#queued.length >= this.#max) {
      await new Promise<void>((resume) => this.#waitingSenders.push(resume));
      if (this.#closed) throw new MettaError("this channel is closed");
    }
    const waiting = this.#waitingReceivers.shift();
    if (waiting !== undefined) {
      waiting({ done: false, value });
      return;
    }
    this.#queued.push(value);
  }

  /** Take one value out, waiting for one; `undefined` once closed and drained. */
  async receive(): Promise<T | undefined> {
    const step = await this.#next();
    return step.done === true ? undefined : step.value;
  }

  /**
   * Take one value out only if one is already there. Never waits.
   *
   * `undefined` means nothing was queued, which a caller polling several
   * sources needs to be able to find out without committing to one of them.
   * It does not distinguish empty from closed, because neither has a value:
   * `closed` says which.
   */
  tryReceive(): T | undefined {
    const held = this.#queued.shift();
    if (held === undefined) return undefined;
    // A send that was blocked on a full channel may now proceed, exactly as
    // the waiting path releases it.
    this.#waitingSenders.shift()?.();
    return held;
  }

  async #next(): Promise<IteratorResult<T>> {
    const held = this.#queued.shift();
    if (held !== undefined) {
      this.#waitingSenders.shift()?.();
      return { done: false, value: held };
    }
    if (this.#closed) return { done: true, value: undefined as never };
    return new Promise<IteratorResult<T>>((resume) => this.#waitingReceivers.push(resume));
  }

  /** Close the channel: no more sends, and every waiting receiver finishes. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiting of this.#waitingReceivers.splice(0)) {
      waiting({ done: true, value: undefined as never });
    }
    for (const waiting of this.#waitingSenders.splice(0)) waiting();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => this.#next(),
      return: (): Promise<IteratorResult<T>> => {
        this.close();
        return Promise.resolve({ done: true, value: undefined as never });
      },
    };
  }

  get [Symbol.toStringTag](): string {
    return "Channel";
  }
}

showsAs(
  Channel.prototype,
  (channel: Channel<unknown>) =>
    `Channel(${String(channel.size)}${channel.closed ? ", closed" : ""})`,
);

/**
 * Work started NOW, collected in the background.
 *
 * ```ts
 * const job = spawn(m.eval(expensive));
 * ...
 * const answers = await job;      // or job.cancel()
 * ```
 *
 * The handle is a promise, so it awaits like one, and it carries a `cancel`
 * the promise alone cannot: abandoning a promise leaves its work running,
 * where cancelling one stops the pull and closes the engine behind it.
 */
export class Task<T> implements PromiseLike<T[]>, Disposable {
  readonly #controller = new AbortController();
  readonly #answers: Promise<T[]>;
  #settled = false;

  /** @internal Use {@link spawn}. */
  constructor(ask: Answers<T>) {
    this.#answers = ask
      .until(this.#controller.signal)
      .toArray()
      .finally(() => {
        this.#settled = true;
      });
    // Nothing may reject an unobserved promise: a task the caller never awaits
    // must not take the process down with an unhandled rejection.
    this.#answers.catch(() => undefined);
  }

  /** Whether the work has finished, one way or the other. */
  get settled(): boolean {
    return this.#settled;
  }

  then<R1 = T[], R2 = never>(
    onFulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onRejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.#answers.then(onFulfilled, onRejected);
  }

  /** Stop the work at its next answer boundary. */
  cancel(reason?: unknown): void {
    this.#controller.abort(reason ?? new MettaError("this task was cancelled"));
  }

  [Symbol.dispose](): void {
    this.cancel();
  }

  get [Symbol.toStringTag](): string {
    return "Task";
  }
}

showsAs(Task.prototype, (task: Task<unknown>) => `Task(${task.settled ? "settled" : "running"})`);

/** Start an ask now and answer the handle its results fill. */
export function spawn<T>(ask: Answers<T>): Task<T> {
  return new Task<T>(ask);
}
