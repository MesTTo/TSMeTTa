/**
 * Purpose: the resource-shaped constructs, spelled with `using`: a limits
 *   scope, a stats scope, and a world.
 * Assumes:
 *   - Explicit Resource Management is Stage 4 (TC39, 2026-05-20) and TypeScript
 *     has carried `using` since 5.2, so a block-scoped construct needs no
 *     `with` statement and no callback
 *   - a scope is established INSIDE the engine that runs a job, because an SWI
 *     engine has its own stack and a flag pushed on the host's side of
 *     `engine_next/2` is not in force within
 *   - `engine_yield/1` cannot unwind through `transaction/1` or `snapshot/1`
 *     [measured 2026-08-27], so a world cannot be an engine suspended inside an
 *     open transaction across host calls
 * Guarantees:
 *   - leaving a `using` block restores what the scope changed, whatever left it:
 *     a return, a throw, or the end of the block
 *   - a world's `commit()` applies its whole delta inside ONE engine
 *     transaction, and `restore()` leaves the parent untouched
 *   - a world's reads consume each journalled removal once and include its
 *     inherited rows [tested: "has sees inherited rows and honours journalled
 *     removals", "keeps one visible copy after removing one duplicate in a
 *     world"; commit=6b117a66f6d1028496594942d4b4bdb4cc2b14fe]
 * Decides: a world is a DRAFT, not a suspended transaction. Adds go into a
 *   child space, which the engine's own parent declaration makes read through
 *   the parent and write locally; removals are journalled here and applied at
 *   commit. That is Immer's produce-a-draft and git's index, it survives an
 *   `await` in the middle, and commit is still atomic.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, substitute, toAtom } from "./atom.ts";
import { Answers, type AskOptions, type Row } from "./answers.ts";
import { type Counters, type Engine, type Scope } from "./engine.ts";
import { ClosedError, MettaError } from "./errors.ts";
import { matchTerms } from "./matching.ts";
import { showsAs } from "./present.ts";
import { Space } from "./space.ts";

/** What a limits scope bounds. */
export interface Limits {
  /** The engine's stack ceiling, in bytes, for every job started in this scope. */
  readonly stack?: number;
  /**
   * The engine's inference budget for every job started in this scope.
   *
   * Deterministic under load where a wall clock is not, which is why it is the
   * bound this build carries. There is no `timeout` beside it: a WebAssembly
   * SWI has no `library(time)`, so a deadline is enforced on the host side
   * with an `AbortSignal` and the surface says so rather than pretending.
   */
  readonly inferences?: number;
}

/**
 * A scope that pops itself.
 *
 * ```ts
 * {
 *   using _ = m.limits({ stack: 1_000_000 });
 *   ...
 * }
 * ```
 */
export class ScopeHandle implements Disposable {
  #release: () => void;
  #released = false;

  /** @internal */
  constructor(release: () => void) {
    this.#release = release;
  }

  /** Leave the scope now, rather than at the end of the block. */
  release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#release();
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

/**
 * What one stretch of work cost.
 *
 * Inferences are the engine's own counter: deterministic, transport
 * independent, and the gate the Python side proved. Crossings are this
 * transport's own N+1 counter, one per host-to-engine round trip, so a
 * lowered body costs none per call and a live operation costs its yields.
 * Replays count bodies re-run to reach a second branch, which is what a
 * single-shot generator costs when the door needs more than one.
 */
export class Stats implements Disposable {
  #counters: Counters;
  #before: Counters;
  #frozen: Counters | null = null;

  /** @internal Use `m.stats()`. */
  constructor(counters: Counters) {
    this.#counters = counters;
    this.#before = { ...counters };
  }

  #delta(field: keyof Counters): number {
    if (this.#frozen !== null) return this.#frozen[field];
    return this.#counters[field] - this.#before[field];
  }

  /** Engine-side inferences spent since the scope opened. */
  get inferences(): number {
    return this.#delta("inferences");
  }

  /** Host-to-engine round trips since the scope opened. */
  get crossings(): number {
    return this.#delta("crossings");
  }

  /** Bodies re-run to reach another branch since the scope opened. */
  get replays(): number {
    return this.#delta("replays");
  }

  toString(): string {
    return `Stats(inferences=${String(this.inferences)}, crossings=${String(
      this.crossings,
    )}, replays=${String(this.replays)})`;
  }

  /** Freeze the deltas, so a reading after the block still reads the block. */
  [Symbol.dispose](): void {
    if (this.#frozen !== null) return;
    this.#frozen = {
      inferences: this.inferences,
      crossings: this.crossings,
      replays: this.replays,
    };
  }
}

showsAs(Stats.prototype, (stats: Stats) => stats.toString());

let worlds = 0;

/**
 * A draft over a space: claim, try, then commit or restore.
 *
 * ```ts
 * const w = m.world(todos);
 * w.add(S.todo(id, text));                 // the draft sees it at once
 * try { await api.save(todo); w.commit(); }
 * catch { w.restore(); }
 * ```
 *
 * Adds land in a child space the engine makes read through the parent, so a
 * query inside the world sees the parent's atoms and the draft's together.
 * Removals are journalled here, because a child cannot un-see its parent's
 * atom, and applied when the world commits.
 *
 * The one thing to know: between `w.remove(a)` and `w.commit()`, a query made
 * OUTSIDE the world still sees `a`. The world's own read doors honour the
 * journal; the parent has not been touched yet, and that is what makes
 * `restore()` free.
 */
export class World implements Disposable {
  #engine: Engine;
  #parent: Space;
  #draft: Space;
  #removals: Atom[] = [];
  #settled: "open" | "committed" | "restored" = "open";

  /** @internal Use `m.world(...)`. */
  constructor(engine: Engine, parent: Space, draft: Space) {
    this.#engine = engine;
    this.#parent = parent;
    this.#draft = draft;
    draft.readsThrough(parent);
  }

  /** The space the draft's own atoms live in, for a query that wants it by name. */
  get space(): Space {
    return this.#draft;
  }

  /** The space this world drafts over. */
  get over(): Space {
    return this.#parent;
  }

  #open(): void {
    if (this.#settled !== "open") {
      throw new ClosedError(`this world was already ${this.#settled}`);
    }
  }

  /** Admit atoms into the draft. */
  add(...atoms: readonly Term[]): this {
    this.#open();
    this.#draft.add(...atoms);
    return this;
  }

  /** Journal a removal. The parent is not touched until `commit()`. */
  remove(...atoms: readonly Term[]): this {
    this.#open();
    for (const atom of atoms) {
      const built = toAtom(atom);
      // A removal of something the DRAFT added is just an un-add: it never
      // reached the parent, so journalling it would remove a second copy from
      // the parent at commit.
      if (this.#draft.delete(built)) continue;
      this.#removals.push(built);
    }
    return this;
  }

  /** The draft's view of a pattern: the parent plus the draft, minus the journal. */
  match(pattern: Term, options: AskOptions = {}): Answers<Row> {
    const matched = toAtom(pattern);
    const draft = this.#draft;
    const removals = [...this.#removals];
    if (removals.length === 0) return draft.match(matched, options);
    const rows = draft.match(matched);
    return new Answers<Row>(
      `world(${draft.name}, ${matched.text})`,
      () => visibleWorldRows(draft, matched, rows, removals),
      options.signal,
    );
  }

  /** Whether the draft holds an atom unifying with this pattern. */
  async has(pattern: Term): Promise<boolean> {
    return this.match(pattern).exists();
  }

  /** Every atom the draft added, without the parent's. */
  drafted(): Answers<Atom> {
    return this.#draft.atoms();
  }

  /** The removals waiting to be applied. */
  get removals(): readonly Atom[] {
    return this.#removals;
  }

  /**
   * Apply the whole delta to the parent, atomically.
   *
   * The removals go first and the draft's atoms follow, inside one engine
   * transaction. By this point the delta is pure data, so nothing in the
   * transaction needs to call back into the host, which is what makes the
   * transaction scope usable at all.
   */
  commit(): void {
    this.#open();
    this.#settled = "committed";
    const removals = this.#removals.map((atom) =>
      this.#engine.encodeAtom(atom),
    );
    this.#engine
      .start(["commit", this.#draft.name, this.#parent.name, removals], [["transaction"]] as Scope[])
      .sync();
    this.#drop();
  }

  /** Throw the draft away. The parent was never touched, so there is nothing to undo. */
  restore(): void {
    if (this.#settled !== "open") return;
    this.#settled = "restored";
    this.#draft.clear();
    this.#drop();
  }

  #drop(): void {
    this.#removals = [];
    this.#draft.release();
  }

  /** Leaving the block restores, unless the world was committed inside it. */
  [Symbol.dispose](): void {
    this.restore();
  }
}

showsAs(
  World.prototype,
  (world: World) => `World(${world.space.name} over ${world.over.name})`,
);

/** Rows in the draft union after spending one budget per parent removal. */
async function* visibleWorldRows(
  draft: Space,
  pattern: Atom,
  rows: Answers<Row>,
  removals: readonly Atom[],
): AsyncGenerator<Row> {
  const local = new Map<Atom, number>();
  for await (const atom of draft.atoms()) {
    local.set(atom, (local.get(atom) ?? 0) + 1);
  }
  const remaining = [...removals];
  for await (const row of rows) {
    const filled = substitute(pattern, row as Record<string, Term>);
    const own = local.get(filled) ?? 0;
    if (own > 0) {
      if (own === 1) local.delete(filled);
      else local.set(filled, own - 1);
      yield row;
      continue;
    }
    const hidden = remaining.findIndex(
      (removal) => matchTerms(removal, filled) !== undefined,
    );
    if (hidden >= 0) remaining.splice(hidden, 1);
    else yield row;
  }
}

/** @internal A world's draft space name, unique within the process. */
export function nextWorldName(): string {
  worlds += 1;
  return `&world-${String(worlds)}`;
}
