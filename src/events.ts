/**
 * Purpose: a FOLD over a space's writes. A standing query that carries state,
 *   steps it once per matching write, and is itself readable.
 * Assumes:
 *   - `Space.watch` is the engine's own admission stream, and this is the
 *     stateful reading of it: `subscribe` delivers, a fold ACCUMULATES
 * Guarantees:
 *   - a fold's step runs once per matching write, in arrival order, and its
 *     state is what the last step answered [tested: "steps once per matching
 *     write, in order"]
 *   - a step that throws does not lose the fold: the error reaches `onError`
 *     and the state is what it was before the step
 *     [tested: "keeps its state when a step throws"]
 *   - without an `onError`, `settled()` re-raises the step's `SubscriberError`
 *     with its cause intact [tested: "re-raises an unhandled step failure from
 *     settled()"; commit=d3b3d62e19cd5dc941a6af8df24bc48992327236]
 *   - `publish` is the write door that a fold and an ordinary query see
 *     identically, because it IS an ordinary write
 * Decides: a fold holds its state HERE rather than in the space. A fold whose
 *   state lived in the space would be a program the engine runs, which is what
 *   an equation already is; this is for state a host owns — a counter, a
 *   window, a connection — and the point is that it is the host's.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import type { Atom, Term } from "./atom.ts";
import { toAtom } from "./atom.ts";
import { SubscriberError } from "./errors.ts";
import { showsAs } from "./present.ts";
import type { Space } from "./space.ts";
import { type Event, Subscription, subscribe } from "./subscribe.ts";
import type { SubscriptionEdge } from "./vocabularies.ts";

export type { Event };

/** The state a fold that keeps none carries: nothing, said once. */
export const STATELESS: unique symbol = Symbol("metta.stateless");

/** What `fold` accepts beside the pattern and the step. */
export interface FoldOptions<T> {
  /** The state it starts from. */
  readonly initial: T;
  /** Which edges step it. Both, by default. */
  readonly on?: SubscriptionEdge;
  /** What to do with an error a step raised. */
  readonly onError?: (error: unknown, event: Event) => void;
  /** How long to wait between polls of the admission queue, in milliseconds. */
  readonly pollMs?: number;
}

/**
 * One standing query that carries state.
 *
 * ```ts
 * using alarms = fold(kb, S.alarm(V.what), (count) => count + 1, { initial: 0 });
 * kb.add(S.alarm(S.fire));
 * await alarms.settled();
 * alarms.state;                 // 1
 * ```
 *
 * The step answers the NEW state, which is what makes it a fold rather than a
 * callback with a variable beside it: there is one place the state is, and it
 * is whatever the last step answered.
 */
export class Fold<T> implements Disposable {
  readonly #subscription: Subscription;
  readonly #step: (state: T, event: Event) => T;
  readonly #onError: ((error: unknown, event: Event) => void) | undefined;
  #state: T;
  #steps = 0;

  /** @internal Use {@link fold}. */
  constructor(
    space: Space,
    pattern: Term,
    step: (state: T, event: Event) => T,
    options: FoldOptions<T>,
  ) {
    this.#state = options.initial;
    this.#step = step;
    this.#onError = options.onError;
    this.#subscription = subscribe(space, pattern, {
      ...(options.on === undefined ? {} : { on: options.on }),
      ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
      onEvent: (event) => {
        this.#advance(event);
      },
    });
  }

  #advance(event: Event): void {
    try {
      // The new state is assigned only once the step has answered, so a step
      // that throws leaves the fold exactly as it was.
      this.#state = this.#step(this.#state, event);
      this.#steps += 1;
    } catch (error) {
      if (this.#onError !== undefined) this.#onError(error, event);
      else throw new SubscriberError(`a fold's step raised: ${String(error)}`, { cause: error });
    }
  }

  /** What the last step answered. */
  get state(): T {
    return this.#state;
  }

  /** How many writes have stepped it. */
  get steps(): number {
    return this.#steps;
  }

  /** The pattern it stands on. */
  get pattern(): Atom {
    return this.#subscription.pattern;
  }

  /** Whether it is still running. */
  get active(): boolean {
    return this.#subscription.active;
  }

  /** Wait until every write made so far has stepped it. */
  async settled(): Promise<void> {
    await this.#subscription.settled();
    this.#subscription.drain();
  }

  /** Stop folding. Idempotent. */
  close(): void {
    this.#subscription.unsubscribe();
  }

  [Symbol.dispose](): void {
    this.close();
  }

  toString(): string {
    return `Fold(${this.pattern.text}, ${String(this.#steps)} steps)`;
  }
}

showsAs(Fold.prototype, (held: Fold<unknown>) => held.toString());

/** Start a fold over a space's writes. */
export function fold<T>(
  space: Space,
  pattern: Term,
  step: (state: T, event: Event) => T,
  options: FoldOptions<T>,
): Fold<T> {
  return new Fold<T>(space, pattern, step, options);
}

/**
 * Write an atom, which is what every standing query is watching for.
 *
 * `publish` is `space.add` said in the vocabulary of the thing watching: there
 * is no separate event channel, because a write IS the event and a fold and an
 * ordinary query see exactly the same one.
 */
export function publish(space: Space, ...atoms: readonly Term[]): void {
  space.add(...atoms);
}

/** The pull-shaped reading of a space's writes, as its own name. */
export type EventStream = AsyncGenerator<Event>;

/**
 * Every matching write, as an async iterable, without a handler.
 *
 * The pull-shaped reading of the same stream: `fold` pushes into a step,
 * `subscribe` pushes into a handler or a queue, and this hands the loop back
 * to the caller. Leaving the loop ends the subscription behind it.
 */
export async function* stream(
  space: Space,
  pattern: Term,
  options: { readonly on?: SubscriptionEdge; readonly pollMs?: number } = {},
): EventStream {
  const watch = subscribe(space, pattern, {
    ...(options.on === undefined ? {} : { on: options.on }),
    ...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
  });
  try {
    yield* watch;
  } finally {
    watch.unsubscribe();
  }
}

/** The atom a fold's pattern is, for a caller holding a term. */
export function patternOf(pattern: Term): Atom {
  return toAtom(pattern);
}
