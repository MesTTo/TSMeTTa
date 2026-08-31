/**
 * Purpose: record what a sequence of effectful steps committed, and undo it in
 *   reverse by the compensations the program declared.
 * Assumes:
 *   - a receipt is DATA: `(did <op> <args> <result>)` is an ordinary atom in an
 *     ordinary space, so a program queries its own journal with `match` and
 *     nothing here needs a second channel
 *   - `(compensates <operation> <compensator>)` in the catalog is the engine's
 *     own declaration, validated by it, so the two seats agree on what a
 *     compensation IS rather than each deciding
 * Guarantees:
 *   - a step that throws commits no receipt, so the journal never records an
 *     obligation for work that did not happen
 *     [tested: "commits a receipt per effectful step and none for a failed one"]
 *   - rollback PREFLIGHTS every receipt against a declared compensation before
 *     undoing anything, because discovering a missing compensation half way
 *     through leaves the world in neither state
 *     [tested: "refuses to start undoing when a compensation is missing"]
 *   - a compensation that throws keeps its receipt and every receipt before it,
 *     so a retry is idempotent and resumes rather than restarts
 *     [tested: "keeps the failed suffix so a retry resumes"]
 *   - compensations run OUTSIDE the capture, so undoing does not journal itself
 *     [tested: "does not journal its own compensations"]
 * Decides: only operations whose DECLARED effect is `writesState` or stronger
 *   earn a receipt. A read has nothing to undo, and journaling one would turn
 *   rollback into an obligation to compensate a lookup.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, expr, exprOf, sym, toAtom, variable } from "./atom.ts";
import { type CapturedEffect, whileCapturing } from "./engine.ts";
import { MettaError } from "./errors.ts";
import type { MeTTa } from "./metta.ts";
import { showsAs } from "./present.ts";
import type { Space } from "./space.ts";

/** Declare which operation undoes another. */
export function compensates(surface: MeTTa, operation: string, compensator: string): Atom {
  const atom = expr(sym("compensates"), sym(operation), sym(compensator));
  surface.catalog.add(atom);
  return atom;
}

/** Every declared compensation, by the operation it undoes. */
export async function compensations(surface: MeTTa): Promise<ReadonlyMap<string, string>> {
  // The ROW form, not a tuple template: a bare `($op $by)` template is
  // EVALUATED, so `(charge refund)` would come back as whatever applying one
  // to the other answers. The row door quotes for exactly this reason.
  const rows = await surface.catalog
    .match(expr(sym("compensates"), variable("op"), variable("by")))
    .toArray();
  const held = new Map<string, string>();
  for (const row of rows) {
    const operation = row["op"];
    const by = row["by"];
    if (operation !== undefined && by !== undefined) held.set(String(operation), String(by));
  }
  return held;
}

/**
 * A scope of committed receipts and their reverse recovery.
 *
 * ```ts
 * m.op(function charge(amount: number) { ... }, { effect: "writesState" });
 * m.op(function refund(amount: number) { ... }, { effect: "writesState" });
 * compensates(m, "charge", "refund");
 *
 * using book = saga(m, m.space("&receipts"));
 * book.run(S.charge(10));
 * book.rollback();                       // refund(10)
 * ```
 *
 * Compensation is semantic REVERSAL, not restoration of a snapshot: each
 * compensator is called with the arguments its step was called with, and it
 * must be idempotent, because a failed recovery is retried from where it
 * stopped rather than from the beginning.
 */
export class Saga implements Disposable {
  readonly #surface: MeTTa;
  readonly #space: Space;
  #committed: Atom[] = [];
  #closed = false;

  /** @internal Use {@link saga}. */
  constructor(surface: MeTTa, space: Space) {
    this.#surface = surface;
    this.#space = space;
  }

  /** The receipts committed so far, oldest first. */
  get receipts(): readonly Atom[] {
    return this.#committed;
  }

  /** The space the receipts live in. */
  get space(): Space {
    return this.#space;
  }

  /**
   * Run one forward step and commit a receipt for each effect it caused.
   *
   * A step that throws commits nothing: its receipts are discarded before the
   * error is re-raised, so the journal never carries an obligation for work
   * that did not happen.
   */
  async run(target: Term): Promise<Atom[]> {
    this.#open("run");
    const caught: CapturedEffect[] = [];
    // A step that throws writes NOTHING: the receipts of a failed step
    // describe work that may or may not have happened, which is worse than no
    // journal at all. `caught` is simply discarded with the frame.
    const answers = await whileCapturing(caught, () =>
      this.#surface.eval(toAtom(target)).toArray(),
    );
    for (const effect of caught) {
      const receipt = expr(
        sym("did"),
        sym(effect.name),
        exprOf(effect.args.map((tokens) => this.#surface.engine.decodeAtom(tokens))),
        toAtom(effect.result as Term),
      );
      this.#space.add(receipt);
      this.#committed.push(receipt);
    }
    return answers;
  }

  /**
   * Compensate every committed receipt, newest first.
   *
   * PREFLIGHT first: every receipt is checked against a declared compensation
   * before anything is undone, because finding a missing one half way through
   * leaves the world in neither the state it started in nor the one it was
   * going to.
   */
  async rollback(): Promise<void> {
    this.#open("rollback");
    const declared = await compensations(this.#surface);
    const missing = [
      ...new Set(
        this.#committed
          .map((receipt) => operationOf(receipt))
          .filter((name) => !declared.has(name)),
      ),
    ];
    if (missing.length > 0) {
      throw new MettaError(
        `nothing undoes ${missing.join(", ")}, so this saga cannot roll back: declare it with ` +
          `compensates(m, "${missing[0] ?? ""}", "<undo>") before running a step that needs it`,
      );
    }
    // Newest first, and the receipt stays until its compensation ANSWERS, so a
    // throw keeps it and everything before it for an idempotent retry.
    while (this.#committed.length > 0) {
      const receipt = this.#committed[this.#committed.length - 1] as Atom;
      const undo = declared.get(operationOf(receipt)) as string;
      // Outside the capture: undoing is not itself an obligation to undo.
      await whileCapturing(null, () =>
        this.#surface.eval(expr(sym(undo), ...argumentsOf(receipt))).toArray(),
      );
      this.#committed.pop();
      this.#space.delete(receipt);
    }
  }

  /** Stop the scope. Idempotent; a rollback still owed is the caller's. */
  close(): void {
    this.#closed = true;
  }

  [Symbol.dispose](): void {
    this.close();
  }

  #open(verb: string): void {
    if (this.#closed) throw new MettaError(`this saga is closed and cannot ${verb}`);
  }

  toString(): string {
    return `Saga(${this.#space.name}, ${String(this.#committed.length)} receipts)`;
  }
}

showsAs(Saga.prototype, (held: Saga) => held.toString());

/** Open a saga whose receipts land in one space. */
export function saga(surface: MeTTa, receipts: Space): Saga {
  return new Saga(surface, receipts);
}

/** The operation a receipt records. */
function operationOf(receipt: Atom): string {
  return String((receipt as { items?: readonly Atom[] }).items?.[1] ?? "");
}

/** The arguments a receipt's step was called with. */
function argumentsOf(receipt: Atom): readonly Atom[] {
  const held = (receipt as { items?: readonly Atom[] }).items?.[2];
  return (held as { items?: readonly Atom[] } | undefined)?.items ?? [];
}
