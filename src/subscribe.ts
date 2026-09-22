/**
 * Purpose: standing queries. A pattern, a space, and something that happens
 *   every time an atom matching it arrives or leaves.
 * Assumes:
 *   - subscriptions consume `Space.watch`; live values use committed queries
 * Guarantees:
 *   - a subscription is a RESOURCE: `using` ends it, and so does
 *     `unsubscribe()`, and ending it twice is not an error
 *   - a queue nobody drains does not grow without bound. `queueMax` refuses a
 *     further event rather than discarding the oldest, which is `queue.Queue`'s
 *     policy: a dropped event is a wrong answer nobody is told about, where a
 *     refusal is a defect somebody can fix
 *   - a handler that throws does not stop the subscription; the error reaches
 *     `onError`, or is re-raised on the next drain when there is none
 *   - `LiveView` projects the committed row multiset, so variable removals and
 *     writes made during opening cannot leave stale counts. Count reads use
 *     the cached snapshot [tested: "includes writes made while a view is opening", "recomputes a variable-pattern removal against the committed store"; commit=94e5fc7eb685b895dde2878e7054332a0cb61c7d].
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
import { type LiveQuery, SUBSCRIPTION_QUEUE_MAX } from "./live.ts";
import type { Row } from "./answers.ts";

/** One change a subscription saw. */
export type Event = Admission;

/** How many undrained events one subscription holds before it refuses more. */
export { SUBSCRIPTION_QUEUE_MAX } from "./live.ts";

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
  readonly #signal: AbortSignal | undefined;
  readonly #abort = (): void => { this.unsubscribe(); };
  #taken = 0;
  #delivered = 0;
  #failure: unknown;
  #ended = false;

  /** @internal Use {@link subscribe}. */
  constructor(space: Space, pattern: Term, options: SubscribeOptions = {}) {
    this.#space = space;
    this.#pattern = toAtom(pattern);
    this.#queueMax = options.queueMax ?? SUBSCRIPTION_QUEUE_MAX;
    if (!Number.isSafeInteger(this.#queueMax) || this.#queueMax < 1) throw new SubscriberError("queueMax must be a positive safe integer");
    this.#onEvent = options.onEvent;
    this.#onError = options.onError;
    this.#signal = options.signal;
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
    this.#signal?.addEventListener("abort", this.#abort, { once: true });
    if (this.#signal?.aborted === true) this.unsubscribe();
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
    } finally {
      this.unsubscribe();
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
    this.#signal?.removeEventListener("abort", this.#abort);
    this.#controller.abort(new SubscriberError("this subscription ended"));
  }

  [Symbol.dispose](): void {
    this.unsubscribe();
  }

  /** Every event as it arrives, for a caller that would rather loop than queue. */
  async *[Symbol.asyncIterator](): AsyncGenerator<Event> {
    try {
      for (;;) {
        if (this.#failure !== undefined) {
          const failure = this.#failure;
          this.#failure = undefined;
          throw failure;
        }
        const held = this.#queue.shift();
        if (held !== undefined) {
          yield held;
          continue;
        }
        if (this.#ended) return;
        await new Promise((resume) => setTimeout(resume, 5));
      }
    } finally {
      this.unsubscribe();
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
 * Seeded and registered in one engine call, then refreshed by admission events.
 * `settled()` synchronizes explicitly; cached count reads scan no rows.
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
  readonly #query: LiveQuery;
  readonly #subscription: Subscription;
  readonly #pattern: Atom;
  #rows: readonly Readonly<Row>[] | undefined;
  #total = 0;

  /** @internal Use {@link LiveView.open}. */
  constructor(space: Space, pattern: Term) {
    this.#pattern = toAtom(pattern);
    this.#query = space.live(pattern);
    this.#refresh();
    this.#subscription = subscribe(space, pattern, { onEvent: () => { this.#refresh(); } });
  }

  /** Seed the view from the space, then keep it current. */
  static async open(space: Space, pattern: Term): Promise<LiveView> {
    return new LiveView(space, pattern);
  }

  // Time: O(R*P) only on a changed snapshot, R rows, P pattern size.
  // Space: O(R*P); the total counts occurrences, the map counts distinct atoms.
  #refresh(): void {
    const rows = this.#query.rows;
    if (rows === this.#rows) return;
    this.#counts.clear();
    for (const row of rows) {
      const atom = substitute(this.#pattern, row);
      this.#counts.set(atom, (this.#counts.get(atom) ?? 0) + 1);
    }
    this.#total = rows.length;
    this.#rows = rows;
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
    this.#refresh();
  }

  /** Each DISTINCT atom, once. `count` is the multiplicity door. */
  [Symbol.iterator](): IterableIterator<Atom> {
    return this.#counts.keys();
  }

  /** Stop keeping the view current. */
  close(): void {
    this.#subscription.unsubscribe();
    this.#query.close();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  get [Symbol.toStringTag](): string {
    return "LiveView";
  }
}

showsAs(LiveView.prototype, (view: LiveView) => `LiveView(${String(view.size)})`);
