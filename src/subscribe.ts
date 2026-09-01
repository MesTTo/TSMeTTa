/**
 * Purpose: standing queries. A pattern, a space, and something that happens
 *   every time an atom matching it arrives or leaves.
 * Assumes:
 *   - `Space.watch` is the engine's own admission stream, and everything here
 *     is built on it rather than beside it
 * Guarantees:
 *   - a subscription is a RESOURCE: `using` ends it, and so does
 *     `unsubscribe()`, and ending it twice is not an error
 *   - a queue nobody drains does not grow without bound. `queueMax` refuses a
 *     further event rather than discarding the oldest, which is `queue.Queue`'s
 *     policy: a dropped event is a wrong answer nobody is told about, where a
 *     refusal is a defect somebody can fix
 *   - a handler that throws does not stop the subscription; the error reaches
 *     `onError`, or is re-raised on the next drain when there is none
 *   - `LiveView` counts MULTIPLICITY, because a space is a multiset and a view
 *     that collapsed duplicates would be answering a different question
 *   - `LiveView.open` seeds from stored atoms, so its snapshot and later
 *     admission events carry the same values [tested: "seeds with stored atoms
 *     rather than reductions of the pattern"; commit=6b117a66f6d1028496594942d4b4bdb4cc2b14fe]
 *   - `LiveView.size` is a maintained multiplicity total, updated by the same
 *     seed, admission, removal, and clear events as its count map, so a read is
 *     constant time [tested: "maintains total multiplicity through seed, updates,
 *     removals, and clear", "reads size without scanning the multiplicity map";
 *     commit=c61a50dfa9c1a958ec1aa67b0070d50b9b32fa7b]
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import type { Atom, Term } from "./atom.ts";
import { substitute, toAtom } from "./atom.ts";
import { SubscriberError } from "./errors.ts";
import { showsAs } from "./present.ts";
import type { Admission, Space, WatchOptions } from "./space.ts";
import type { SubscriptionEdge } from "./vocabularies.ts";

/** One change a subscription saw. */
export type Event = Admission;

/** How many undrained events one subscription holds before it refuses more. */
export const SUBSCRIPTION_QUEUE_MAX = 10_000;

/** What `subscribe` accepts beside the pattern. */
export interface SubscribeOptions extends WatchOptions {
  /** Which edges to report. Both, by default. */
  readonly on?: SubscriptionEdge;
  /** What to run for each event. Without one, events queue for `drain`. */
  readonly onEvent?: (event: Event) => void | Promise<void>;
  /** What to do with an error a handler raised. */
  readonly onError?: (error: unknown, event: Event) => void;
  /** How many undrained events to hold. Ten thousand, by default. */
  readonly queueMax?: number;
}

/**
 * One standing query. `unsubscribe()` ends it, and so does leaving its block.
 *
 * ```ts
 * using watch = subscribe(kb, S.alarm(V.what), {
 *   onEvent: ({ edge, atom }) => console.log(edge, String(atom)),
 * });
 * ```
 *
 * Without a handler the events queue instead, and `drain()` empties the queue:
 *
 * ```ts
 * const seen = subscribe(kb, S.alarm(V.what));
 * kb.add(S.alarm(S.fire));
 * await seen.settled();
 * seen.drain();          // [{ edge: "add", atom: (alarm fire), ... }]
 * ```
 */
export class Subscription implements Disposable, AsyncIterable<Event> {
  readonly #space: Space;
  readonly #pattern: Atom;
  readonly #controller = new AbortController();
  readonly #queue: Event[] = [];
  readonly #queueMax: number;
  readonly #onEvent: ((event: Event) => void | Promise<void>) | undefined;
  readonly #onError: ((error: unknown, event: Event) => void) | undefined;
  readonly #pump: Promise<void>;
  readonly #watchId: number;
  #taken = 0;
  #delivered = 0;
  #failure: unknown;
  #ended = false;

  /** @internal Use {@link subscribe}. */
  constructor(space: Space, pattern: Term, options: SubscribeOptions = {}) {
    this.#space = space;
    this.#pattern = toAtom(pattern);
    this.#queueMax = options.queueMax ?? SUBSCRIPTION_QUEUE_MAX;
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    const edges: readonly ("add" | "remove")[] =
      options.edges ??
      (options.on === undefined || options.on === "both" ? ["add", "remove"] : [options.on]);
    // The id is minted HERE rather than inside the watch, because `settled()`
    // has to ask the engine about this watch in particular.
    this.#watchId = space.nextWatchId();
    const watch = space.watch(this.#pattern, {
      ...options,
      edges,
      watchId: this.#watchId,
      signal: this.#controller.signal,
    });
    this.#pump = this.#run(watch);
    // A subscription nobody awaits must not take the process down when it is
    // cancelled, which is what ending it does to the pull.
    this.#pump.catch(() => undefined);
  }

  async #run(watch: AsyncIterable<Event>): Promise<void> {
    try {
      for await (const event of watch) {
        // Counted on both sides of the delivery, because an event taken from
        // the engine and not yet handed on is invisible to both the engine's
        // queue and this one's: `settled()` needs the pair to see it.
        this.#taken += 1;
        if (this.#ended) return;
        await this.#deliver(event);
        this.#delivered += 1;
      }
    } catch (error) {
      if (!this.#ended) this.#failure = error;
    }
  }

  async #deliver(event: Event): Promise<void> {
    if (this.#onEvent === undefined) {
      if (this.#queue.length >= this.#queueMax) {
        this.#failure = new SubscriberError(
          `this subscription holds ${String(this.#queueMax)} undrained events; ` +
            `drain it, give it an onEvent handler, or raise queueMax`,
        );
        this.unsubscribe();
        return;
      }
      this.#queue.push(event);
      return;
    }
    try {
      await this.#onEvent(event);
    } catch (error) {
      if (this.#onError !== undefined) this.#onError(error, event);
      else this.#failure ??= error;
    }
  }

  /** The pattern this subscription stands on. */
  get pattern(): Atom {
    return this.#pattern;
  }

  /** The space it watches. */
  get space(): Space {
    return this.#space;
  }

  /** Whether it is still running. */
  get active(): boolean {
    return !this.#ended;
  }

  /** How many events are queued and not yet drained. */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Wait until every write made so far has been seen.
   *
   * The watch is polled, so an event is not delivered the instant the write
   * happens. This is the door a test uses instead of sleeping.
   */
  async settled(): Promise<void> {
    // A BARRIER, not a sleep. This used to wait a fixed 20 milliseconds and
    // call that settled, which is a race the caller loses whenever a poll plus
    // its crossing plus its delivery takes longer than that: on a loaded box
    // it returned before the last write had arrived and the reader saw a short
    // queue [measured 2026-08-31, C53].
    //
    // Two readings answer it exactly. The engine's own queue for this watch
    // holds what no poll has fetched; `taken` against `delivered` holds what a
    // poll fetched and the pump has not handed on. The macrotask between them
    // is what makes them comparable, because a macrotask runs after every
    // pending microtask, the pump's own continuation included.
    for (;;) {
      if (this.#ended || this.#failure !== undefined) return;
      const queued = this.#space.pendingAdmissions(this.#watchId);
      await new Promise((resume) => setTimeout(resume, 0));
      if (queued === 0 && this.#taken === this.#delivered) return;
      await new Promise((resume) => setTimeout(resume, 1));
    }
  }

  /** Take every queued event, leaving the queue empty. */
  drain(): Event[] {
    const failure = this.#failure;
    if (failure !== undefined) {
      this.#failure = undefined;
      throw failure;
    }
    return this.#queue.splice(0);
  }

  /** End the subscription. Idempotent. */
  unsubscribe(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#controller.abort(new SubscriberError("this subscription ended"));
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }

  /** Every event as it arrives, for a caller that would rather loop than queue. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Event> {
    for (;;) {
      const held = this.#queue.shift();
      if (held !== undefined) {
        yield held;
        continue;
      }
      if (this.#ended) return;
      await new Promise((resume) => setTimeout(resume, 5));
    }
  }

  get [Symbol.toStringTag](): string {
    return "Subscription";
  }
}

showsAs(
  Subscription.prototype,
  (subscription: Subscription) =>
    `Subscription(${subscription.space.name}, ${subscription.pattern.text}` +
    `${subscription.active ? "" : ", ended"})`,
);

/** Start a standing query over a space. */
export function subscribe(
  space: Space,
  pattern: Term,
  options: SubscribeOptions = {},
): Subscription {
  return new Subscription(space, pattern, options);
}

/**
 * A live multiset of everything in a space matching one pattern.
 *
 * Seeded once, then kept current by a subscription. Reading it costs nothing:
 * the count is already here, so a loop that asks "how many alarms" ten
 * thousand times crosses to the engine once.
 *
 * ```ts
 * await using alarms = await LiveView.open(kb, S.alarm(V.what));
 * kb.add(S.alarm(S.fire));
 * await alarms.settled();
 * alarms.size;                    // 1
 * alarms.has(S.alarm(S.fire));    // true
 * ```
 *
 * Multiplicity is kept, because a space is a multiset: adding one atom twice
 * makes `count` two and one removal takes it back to one.
 */
export class LiveView implements Disposable, Iterable<Atom> {
  readonly #counts = new Map<Atom, number>();
  readonly #subscription: Subscription;
  #total = 0;

  /** @internal Use {@link LiveView.open}. */
  constructor(space: Space, pattern: Term, seed: readonly Atom[]) {
    for (const atom of seed) this.#bump(atom, 1);
    this.#subscription = subscribe(space, pattern, {
      onEvent: (event) => {
        this.#bump(event.atom, event.edge === "add" ? 1 : -1);
      },
    });
  }

  /** Seed the view from the space, then keep it current. */
  static async open(space: Space, pattern: Term): Promise<LiveView> {
    const matched = toAtom(pattern);
    const seed = await space
      .match(matched)
      .map((row) => substitute(matched, row))
      .toArray();
    return new LiveView(space, matched, seed);
  }

  // A cached aggregate updated by the accepted occurrence delta is the same
  // invariant used by Guava's map-backed multiset:
  // https://github.com/google/guava/blob/3de1f25e258ef6fd887595cc865efe185b373aa6/guava/src/com/google/common/collect/AbstractMapBasedMultiset.java#L267-L333
  #bump(atom: Atom, by: number): void {
    const before = this.#counts.get(atom) ?? 0;
    const after = Math.max(0, before + by);
    if (after === 0) this.#counts.delete(atom);
    else this.#counts.set(atom, after);
    this.#total += after - before;
  }

  /** How many atoms match, counting a duplicate twice. */
  get size(): number {
    return this.#total;
  }

  /** How many copies of one atom are here. */
  count(atom: Term): number {
    return this.#counts.get(toAtom(atom)) ?? 0;
  }

  /** Whether any copy of one atom is here. */
  has(atom: Term): boolean {
    return this.count(atom) > 0;
  }

  /** Wait until every write made so far has been seen. */
  async settled(): Promise<void> {
    await this.#subscription.settled();
  }

  /** Each DISTINCT atom, once. `count` is the multiplicity door. */
  [Symbol.iterator](): IterableIterator<Atom> {
    return this.#counts.keys();
  }

  /** Stop keeping the view current. */
  close(): void {
    this.#subscription.unsubscribe();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  get [Symbol.toStringTag](): string {
    return "LiveView";
  }
}

showsAs(LiveView.prototype, (view: LiveView) => `LiveView(${String(view.size)})`);
