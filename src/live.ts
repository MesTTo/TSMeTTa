/**
 * Purpose: expose committed query multisets and timestamped occurrence deltas.
 * Owns resources: a native view until close; each iterator owns its delta queue.
 * Guarantees: snapshots and progress refer to complete committed segments;
 *   failures reach readers [tested: "reports a failed recomputation while other views see the committed write"; commit=94e5fc7eb685b895dde2878e7054332a0cb61c7d].
 * Decides: values remain atoms; columns are query variable names or `value`.
 */

import { Atom, Expression, exprOf, type Term, toAtom, variable } from "./atom.ts";
import { Answers, type AskOptions, type Row } from "./answers.ts";
import type { Engine, Scope } from "./engine.ts";
import { ClosedError, SubscriberError, TransportError } from "./errors.ts";
import { alphaCanonical, nameAnonymous } from "./matching.ts";

/** Default bound for a consumer that has not selected its own queue policy. */
export const SUBSCRIPTION_QUEUE_MAX = 10_000;

/** One occurrence change, or the boundary after all changes at a generation. */
export type LiveDelta =
  | { readonly kind: "add" | "remove"; readonly diff: 1 | -1; readonly row: Readonly<Row>; readonly generation: number }
  | { readonly kind: "progress"; readonly diff: 0; readonly generation: number };

/** A consumer's independent queue and cancellation policy. */
export interface ChangesOptions extends AskOptions {
  readonly snapshot?: boolean;
  readonly queueMax?: number;
}

interface Consumer {
  queue: LiveDelta[];
  maximum: number;
  failure?: Error;
}

function tuple(atom: Atom | undefined): readonly Atom[] {
  if (!(atom instanceof Expression)) throw new TransportError("a live query returned a non-tuple packet");
  return atom.items;
}

/**
 * A materialized multiset, opened by `space.live` or `space.liveEval`.
 * Reads synchronize with the engine's latest committed generation. Unchanged
 * reads transfer no rows. Changes are buffered only while an iterator is open.
 */
export class LiveQuery implements Disposable, Iterable<Readonly<Row>> {
  readonly #engine: Engine;
  readonly #id: number;
  readonly columns: readonly string[];
  readonly #consumers = new Set<Consumer>();
  #rows: readonly Readonly<Row>[] = [];
  #counts = new Map<Atom, number>();
  #generation = -1;
  #closed = false;
  #failure: unknown;

  /** @internal A Space validates its lifetime before opening this resource. */
  constructor(engine: Engine, reference: unknown, mode: "match" | "eval", term: Atom, columns: readonly string[]) {
    this.#engine = engine;
    this.#id = engine.nextWatchId();
    this.columns = Object.freeze([...columns]);
    try {
      this.#accept(this.#call([
        "liveopen", this.#id, reference, mode, engine.encodeAtom(term),
        engine.encodeAtom(exprOf(columns.map(variable))),
      ], engine.scopes.filter((scope) => scope[0] !== "transaction" && scope[0] !== "speculate")));
    } catch (error) { this.#release(); throw error; }
  }

  #call(command: readonly unknown[], scopes: readonly Scope[] = []): Atom {
    const event = this.#engine.control(command, scopes).sync();
    if (event?.kind !== "value") throw new TransportError("a live query command returned no value");
    return event.atom;
  }

  #row(values: readonly Atom[]): Readonly<Row> {
    if (values.length !== this.columns.length) throw new TransportError("a live query row has the wrong column count");
    return Object.freeze(Object.fromEntries(this.columns.map((name, i) => [name, values[i]!])));
  }

  // Time/space: O(R*C + D*C + K*D), R rows, C columns, D changes, K consumers.
  // Native sorted multiset differences preserve occurrence counts at commits.
  #accept(packet: Atom): void {
    const [generation, snapshots, deltas] = tuple(packet);
    this.#generation = Number(generation!.text);
    const changed = tuple(snapshots)[0];
    if (changed !== undefined) {
      const rows: Readonly<Row>[] = [];
      const counts = new Map<Atom, number>();
      for (const row of tuple(changed)) {
        rows.push(this.#row(tuple(row)));
        const key = alphaCanonical(row);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      this.#rows = Object.freeze(rows);
      this.#counts = counts;
    }
    for (const encoded of tuple(deltas)) {
      const [kind, generation, row] = tuple(encoded);
      const name = kind!.text;
      if (name === "overflow") {
        for (const consumer of this.#consumers) {
          consumer.failure = new SubscriberError("live changes exceeded queueMax before the consumer pulled again");
          consumer.queue.length = 0;
        }
        continue;
      }
      const at = Number(generation!.text);
      let delta: LiveDelta;
      if (name === "progress") delta = { kind: name, diff: 0, generation: at };
      else if (name === "add" || name === "remove") {
        delta = { kind: name, diff: name === "add" ? 1 : -1, row: this.#row(tuple(row)), generation: at };
      } else throw new TransportError(`unknown live delta ${name}`);
      for (const consumer of this.#consumers) {
        if (consumer.failure !== undefined) continue;
        if (consumer.queue.length >= consumer.maximum) {
          consumer.failure = new SubscriberError(`live changes exceeded queueMax ${consumer.maximum}; consume the stream or raise its bound`);
          consumer.queue.length = 0;
        } else consumer.queue.push(Object.freeze(delta));
      }
    }
  }

  #refresh(): void {
    if (this.#failure !== undefined) throw this.#failure;
    if (this.#closed) return;
    try { this.#accept(this.#call(["livepoll", this.#id, this.#generation])); }
    catch (error) {
      this.#failure = error;
      this.#release();
      throw error;
    }
  }

  /** The latest committed occurrence rows. The final snapshot survives close. */
  get rows(): readonly Readonly<Row>[] { this.#refresh(); return this.#rows; }
  get size(): number { this.#refresh(); return this.#rows.length; }
  get generation(): number { this.#refresh(); return this.#generation; }
  get active(): boolean { return !this.#closed; }

  count(row: Readonly<Record<string, Term>>): number {
    this.#refresh();
    const values = this.columns.map((name) => {
      if (!Object.hasOwn(row, name)) throw new SubscriberError(`live row is missing column ${name}`);
      return toAtom(row[name]!);
    });
    return this.#counts.get(alphaCanonical(nameAnonymous(exprOf(values)))) ?? 0;
  }

  /** Observe all writes completed before this call. */
  async settled(): Promise<void> { this.#refresh(); }
  [Symbol.iterator](): IterableIterator<Readonly<Row>> { return this.rows[Symbol.iterator](); }

  /** Each iterator has an independent queue; breaking its loop releases it. */
  changes(options: ChangesOptions = {}): Answers<LiveDelta> {
    const maximum = options.queueMax ?? SUBSCRIPTION_QUEUE_MAX;
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new SubscriberError("queueMax must be a positive safe integer");
    return new Answers<LiveDelta>("live changes", (signal) => {
      if (this.#closed) throw new ClosedError("this live query is closed");
      this.#refresh();
      const consumer: Consumer = { queue: [], maximum };
      const seed: LiveDelta[] = options.snapshot === false ? [] : [
        ...this.#rows.map((row): LiveDelta => ({ kind: "add", diff: 1, row, generation: this.#generation })),
        { kind: "progress", diff: 0, generation: this.#generation },
      ];
      let seeded = 0;
      this.#consumers.add(consumer);
      this.#follow();
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        this.#consumers.delete(consumer);
        consumer.queue.length = 0;
        if (!this.#closed) this.#follow();
      };
      return {
        next: async (): Promise<IteratorResult<LiveDelta>> => {
          try {
            for (;;) {
              if (signal?.aborted === true) throw signal.reason;
              if (closed || this.#closed) return { done: true, value: undefined };
              this.#refresh();
              if (consumer.failure !== undefined) throw consumer.failure;
              const delta = seed[seeded] ?? consumer.queue.shift();
              if (seeded < seed.length) seeded += 1;
              if (delta !== undefined) return { done: false, value: delta };
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
          } catch (error) { close(); throw error; }
        },
        return: async (): Promise<IteratorResult<LiveDelta>> => { close(); return { done: true, value: undefined }; },
      };
    }, options.signal);
  }

  close(): void {
    if (this.#closed) return;
    if (this.#engine.closed) { this.#release(); return; }
    try { this.#refresh(); } finally { this.#release(); }
  }

  #follow(): void {
    let maximum = 0;
    for (const consumer of this.#consumers) maximum = Math.max(maximum, consumer.maximum);
    this.#call(["livefollow", this.#id, maximum]);
  }

  #release(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#engine.closed) this.#call(["liveclose", this.#id]);
    this.#consumers.clear();
  }

  [Symbol.dispose](): void { this.close(); }
}
