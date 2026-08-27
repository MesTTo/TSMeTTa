/**
 * Purpose: a named engine space, with the collection protocol JavaScript
 *   already has a word for and the query doors MeTTa already has a meaning
 *   for.
 * Assumes:
 *   - a binding row is carried by `quote`, whose contract is that its argument
 *     does not reduce. A bare tuple template is EVALUATED: with `(uses twice 3)`
 *     stored and `twice` defined, `(match &kb (uses $f $n) ($f $n))` answers 6
 *     rather than the row [measured 2026-08-27]
 * Guarantees:
 *   - `add`, `delete`, `has`, `size` and `clear` mean what `Set` means by them,
 *     so a space reads as the collection it is
 *   - `match` answers ROWS keyed by the pattern's own variable names, in
 *     first-seen order, and values are ATOMS, so an answer composes straight
 *     back into the next term
 *   - `atoms()` walks stored atoms without evaluating any of them
 * Decides: the collection verbs are SYNCHRONOUS. The transport is in process,
 *   so a synchronous twin genuinely exists, and the async-primary law asks for
 *   an async surface where the transport needs one rather than everywhere. The
 *   awaiting twins are here too, and an admission that reaches an
 *   asynchronous host operation refuses on the synchronous door by name.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  type Term,
  Expression,
  type SpaceHandle,
  Sym,
  type Var,
  expr,
  exprOf,
  space as spaceAtom,
  substitute,
  sym,
  termVars,
  toAtom,
} from "./atom.ts";
import { Answers, type AskOptions, type Row } from "./answers.ts";
import { type Engine, type Job, type JobEvent } from "./engine.ts";
import { PettaError } from "./errors.ts";
import { atomFromWire, wireFromAtom } from "./wire.ts";

const QUOTE = sym("quote");

/** What a space is created with. */
export interface SpaceOptions {
  /**
   * The space this one reads through.
   *
   * A child reads its parent's atoms and writes its own, which is the engine's
   * own overlay and what a world is built on.
   */
  readonly parent?: Space | SpaceHandle | string;
  /**
   * The capabilities a restricted space grants.
   *
   * A string-literal union rather than an enum, which the erasable-syntax law
   * already requires; a refusal names the capability that was missing. A
   * browser deployment physically lacks `file`, so the vocabulary doubles as
   * the deployment surface.
   */
  readonly grants?: readonly Grant[];
}

/** The capabilities a restricted space may be granted. */
export type Grant = "file" | "network" | "process";

/** One admission a watch saw. */
export interface Admission {
  /** Whether the atom arrived or left. */
  readonly edge: "add" | "remove";
  /** The atom itself. */
  readonly atom: Atom;
  /** The engine's own rendering of it. */
  readonly text: string;
}

/** What a coordination verb accepts beside the pattern. */
export interface WaitOptions extends AskOptions {
  /** How long to wait between looks, in milliseconds. */
  readonly pollMs?: number;
}

/** What `watch` accepts beside the pattern. */
export interface WatchOptions extends AskOptions {
  /** Which edges to report. Both, by default. */
  readonly edges?: readonly ("add" | "remove")[];
  /** How long to wait between polls of the admission queue, in milliseconds. */
  readonly pollMs?: number;
}

function valueOf(event: JobEvent | null, what: string): Atom {
  if (event === null || event.kind !== "value") {
    throw new PettaError(`the engine answered nothing for ${what}`);
  }
  return atomFromWire(event.wire);
}

/**
 * A named engine space.
 *
 * The name is the whole host identity: the store stays in the engine, and two
 * handles with one name are one space. A space is also an ATOM, so it goes
 * into a term wherever a space operand belongs.
 */
export class Space {
  #engine: Engine;

  /** The space's own atom, which is what a term holds. */
  readonly handle: SpaceHandle;

  /** @internal Use `m.space(...)`. */
  constructor(engine: Engine, handle: SpaceHandle) {
    this.#engine = engine;
    this.handle = handle;
    engine.knownSpaces.add(handle.name);
  }

  /** The ampersand-prefixed engine name. */
  get name(): string {
    return this.handle.name;
  }

  toString(): string {
    return this.handle.name;
  }

  get [Symbol.toStringTag](): string {
    return `Space(${this.handle.name})`;
  }

  #command(command: readonly unknown[]): Job {
    return this.#engine.start(command);
  }

  #wire(term: Term): unknown {
    return this.#engine.encodeWire(wireFromAtom(toAtom(term)));
  }

  // --- the collection protocol ---------------------------------------------

  /**
   * Admit atoms. Answers the space, which is what `Set.prototype.add` answers.
   *
   * A batch is ONE crossing where the space's own admission rules allow it, and
   * per-atom where a hook claims the space, which is the engine's decision and
   * not this door's.
   */
  add(...atoms: readonly Term[]): this {
    if (atoms.length === 0) return this;
    this.#command(["add", this.name, atoms.map((atom) => this.#wire(atom))]).sync();
    return this;
  }

  /** The awaiting twin, for a space whose admission gate reaches an async operation. */
  async added(...atoms: readonly Term[]): Promise<this> {
    if (atoms.length === 0) return this;
    await this.#command(["add", this.name, atoms.map((atom) => this.#wire(atom))]).all();
    return this;
  }

  /**
   * Remove one atom. Answers whether anything went, which is what
   * `Set.prototype.delete` answers.
   *
   * MeTTa's own `remove-atom` answers the unit value, because its type says
   * absence is not reported there. Nothing in MeTTa's contract governs what a
   * HOST API answers, and a verdict is the useful one.
   */
  delete(atom: Term): boolean {
    const verdict = valueOf(this.#command(["remove", this.name, this.#wire(atom)]).sync(), "delete");
    return isTrue(verdict);
  }

  /** Whether an atom unifying with this pattern is stored. */
  has(pattern: Term): boolean {
    const verdict = valueOf(this.#command(["has", this.name, this.#wire(pattern)]).sync(), "has");
    return isTrue(verdict);
  }

  /** How many atoms are stored. */
  get size(): number {
    const count = valueOf(this.#command(["count", this.name]).sync(), "size");
    return Number(hostValue(count));
  }

  /** Remove every atom. */
  clear(): void {
    this.#command(["clear", this.name]).sync();
  }

  /** Every stored atom, one at a time, without evaluating any of them. */
  atoms(options: AskOptions = {}): Answers<Atom> {
    return this.#stream(`atoms(${this.name})`, ["atoms", this.name], options);
  }

  /** Iterating a space walks its stored atoms, which is what a collection does. */
  [Symbol.asyncIterator](): AsyncIterator<Atom> {
    return this.atoms()[Symbol.asyncIterator]();
  }

  // --- queries --------------------------------------------------------------

  /**
   * The answers to a pattern.
   *
   * With no template, each answer is a ROW keyed by the pattern's own variable
   * names, so a name is written once and read back by that name:
   *
   * ```ts
   * for await (const { x } of kb.match(S.parent(V.x, S.bob))) { ... }
   * ```
   *
   * With a template, each answer is the template's instance, and it is
   * EVALUATED, which is MeTTa's own reading of the third argument of `match`.
   */
  match(pattern: Term, options?: AskOptions): Answers<Row>;
  match(pattern: Term, template: Term, options?: AskOptions): Answers<Atom>;
  match(
    pattern: Term,
    templateOrOptions?: Term | AskOptions,
    maybeOptions?: AskOptions,
  ): Answers<Row> | Answers<Atom> {
    const matched = toAtom(pattern);
    const hasTemplate = isTemplate(templateOrOptions);
    const options = (hasTemplate ? maybeOptions : (templateOrOptions as AskOptions)) ?? {};
    if (hasTemplate) {
      const query = expr(sym("match"), this.handle, matched, toAtom(templateOrOptions as Term));
      return this.#eval(`match(${this.name}, ${matched.text})`, query, options);
    }
    const vars = termVars(matched);
    // The row rides in a `quote`, whose contract is that its argument does not
    // reduce. A bare tuple template is evaluated: with `twice` defined,
    // `(match &kb (uses $f $n) ($f $n))` answers 6 rather than the row
    // [measured 2026-08-27].
    const query = expr(sym("match"), this.handle, matched, expr(QUOTE, exprOf(vars)));
    const engine = this.#engine;
    const wire = engine.encodeWire(wireFromAtom(query));
    const name = this.name;
    // Built directly rather than through `.map`, because a derived ask carries
    // no PLAN and a traced body needs the plan to lower this goal into an
    // equation rather than run it.
    return new Answers<Row>(
      `match(${name}, ${matched.text})`,
      () => {
        const answers = answerIterator(engine.start(["eval", wire, name]));
        return {
          async next(): Promise<IteratorResult<Row>> {
            const step = await answers.next();
            if (step.done === true) return { done: true, value: undefined as never };
            return { done: false, value: rowOf(step.value, vars) };
          },
          return: (): Promise<IteratorResult<Row>> =>
            (answers.return?.(undefined) as Promise<IteratorResult<Row>>) ??
            Promise.resolve({ done: true, value: undefined as never }),
        };
      },
      options.signal,
      { kind: "match", space: name, pattern: matched, vars },
    );
  }

  /**
   * Reduce a term IN this space.
   *
   * The engine's own `evalc`: the space's equations are the ones in force, and
   * its model is the one that applies, so a RESTRICTED space refuses a goal
   * needing a capability it was not granted.
   */
  eval(term: Term, options: AskOptions = {}): Answers<Atom> {
    const built = toAtom(term);
    return this.#eval(`eval(${this.name}, ${built.text})`, built, options);
  }

  /**
   * Why a pattern will be answered the way it will be.
   *
   * The engine's own account: which conjuncts a provider claimed, which the
   * engine joins itself, and why one was refused. A stored space answers that
   * it joins by unification and consults nobody.
   */
  explain(...patterns: readonly Term[]): string {
    const wires = patterns.map((pattern) => this.#wire(pattern));
    const report = valueOf(this.#command(["explain", this.name, wires]).sync(), "explain");
    return String(hostValue(report));
  }

  /**
   * Admissions matching a pattern, as they happen.
   *
   * The engine's own atom events, queued and drained. A live query is an
   * `AsyncIterable`, so a framework adapts it through its own signal layer and
   * this surface adds nothing.
   *
   * Honesty: there is no engine-side blocking wait, because a WebAssembly SWI
   * has no `library(thread)`. This polls the queue, and the poll interval is
   * the option below; an `AbortSignal` ends it.
   */
  watch(pattern: Term, options: WatchOptions = {}): Answers<Admission> {
    const engine = this.#engine;
    const name = this.name;
    const wire = this.#wire(pattern);
    const edges = options.edges ?? ["add", "remove"];
    const pollMs = options.pollMs ?? 5;
    const description = `watch(${name}, ${toAtom(pattern).text})`;
    return new Answers<Admission>(
      description,
      (signal) => {
        const id = engine.nextWatchId();
        engine.start(["watch", id, name, wire, [...edges]]).sync();
        let closed = false;
        const close = (): void => {
          if (closed) return;
          closed = true;
          engine.start(["unwatch", id]).sync();
        };
        return {
          async next(): Promise<IteratorResult<Admission>> {
            for (;;) {
              if (closed) return { done: true, value: undefined as never };
              if (signal?.aborted === true) {
                close();
                throw signal.reason as Error;
              }
              const event = await engine.start(["drain", id]).next();
              if (event !== null && event.kind === "admission") {
                return {
                  done: false,
                  value: {
                    edge: event.edge,
                    atom: atomFromWire(event.wire),
                    text: event.text,
                  },
                };
              }
              await new Promise((resume) => setTimeout(resume, pollMs));
            }
          },
          return(): Promise<IteratorResult<Admission>> {
            close();
            return Promise.resolve({ done: true, value: undefined as never });
          },
        };
      },
      options.signal,
    );
  }

  // --- the coordination verbs -----------------------------------------------

  /**
   * Wait until an atom matching this pattern is here, and answer its row
   * WITHOUT removing it. Linda's `rd`.
   *
   * There is no engine-side blocking wait, because a WebAssembly SWI has no
   * `library(thread)` and `take-atom` is not loaded in this build [measured
   * 2026-08-27: it does not reduce]. So this polls, and the `AbortSignal` in
   * the options position is what bounds it. Nothing is held while it waits.
   */
  async peek(pattern: Term, options: WaitOptions = {}): Promise<Row> {
    return this.#await(pattern, options, false);
  }

  /**
   * Wait until an atom matching this pattern is here, remove ONE, and answer
   * its row. Linda's `in`.
   *
   * The read and the removal are two engine calls with nothing between them,
   * and this host is single-threaded, so no other JavaScript can take the same
   * atom in between. That is what makes it a take rather than a race, and it is
   * a property of THIS transport rather than of the engine: a second host
   * against one engine would need the engine's own atomic door.
   */
  async take(pattern: Term, options: WaitOptions = {}): Promise<Row> {
    return this.#await(pattern, options, true);
  }

  async #await(pattern: Term, options: WaitOptions, remove: boolean): Promise<Row> {
    const built = toAtom(pattern);
    const pollMs = options.pollMs ?? 5;
    for (;;) {
      if (options.signal?.aborted === true) throw options.signal.reason as Error;
      const row = await this.match(built).find();
      if (row !== undefined) {
        if (!remove) return row;
        // Substituting the pattern with its own row names the exact atom that
        // matched, so the removal takes THAT one and not another of its shape.
        if (this.delete(substitute(built, row))) return row;
        continue;
      }
      await new Promise((resume) => setTimeout(resume, pollMs));
    }
  }

  // --- structure ------------------------------------------------------------

  /** Grant this space a restricted set of capabilities. */
  restrict(grants: readonly Grant[]): this {
    this.#command(["restrict", this.name, [...grants]]).sync();
    return this;
  }

  /** Declare that this space reads through `parent` and writes locally. */
  readsThrough(parent: Space | SpaceHandle | string): this {
    this.#command(["child", this.name, nameOf(parent)]).sync();
    return this;
  }

  /** Mark this space releasable, and release it. */
  release(): void {
    this.#command(["releasable", this.name]).sync();
    this.#command(["release", this.name]).sync();
  }

  // --- internals ------------------------------------------------------------

  #eval(description: string, term: Atom, options: AskOptions): Answers<Atom> {
    const engine = this.#engine;
    const wire = engine.encodeWire(wireFromAtom(term));
    const name = this.name;
    return new Answers<Atom>(
      description,
      () => answerIterator(engine.start(["eval", wire, name])),
      options.signal,
    );
  }

  #stream(description: string, command: readonly unknown[], options: AskOptions): Answers<Atom> {
    const engine = this.#engine;
    return new Answers<Atom>(
      description,
      () => answerIterator(engine.start(command)),
      options.signal,
    );
  }
}

/**
 * Whether a second argument is a TEMPLATE or the options bag.
 *
 * Everything that reads as a term in practice says so by its shape: an atom, an
 * array (which is an expression), a primitive, or a callable name. What is left
 * is a plain object, and a plain object in term position is written `G(obj)`,
 * which is an atom. So the options bag is the plain object and the ambiguity
 * has one honest resolution rather than a guess.
 */
function isTemplate(value: unknown): boolean {
  if (value === undefined) return false;
  if (value instanceof Atom) return true;
  if (Array.isArray(value)) return true;
  const kind = typeof value;
  return kind === "string" || kind === "number" || kind === "bigint" ||
    kind === "boolean" || kind === "function";
}

/** An answer stream over a job, closing the engine when the loop is left. */
export function answerIterator(job: Job): AsyncIterator<Atom> {
  return {
    async next(): Promise<IteratorResult<Atom>> {
      try {
        const event = await job.next();
        if (event === null) return { done: true, value: undefined as never };
        if (event.kind !== "answer") {
          throw new PettaError(`this ask produced a ${event.kind} where an answer was expected`);
        }
        return { done: false, value: atomFromWire(event.wire) };
      } catch (error) {
        job.close();
        throw error;
      }
    },
    return(): Promise<IteratorResult<Atom>> {
      job.close();
      return Promise.resolve({ done: true, value: undefined as never });
    },
    throw(error: unknown): Promise<IteratorResult<Atom>> {
      job.close();
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    },
  };
}

/** Strip the `quote` carrier and zip the tuple against the pattern's variables. */
export function rowOf(answer: Atom, vars: readonly Var[]): Row {
  if (!(answer instanceof Expression) || answer.items.length !== 2) {
    throw new PettaError(`a binding row came back as ${answer.text}, which is not a quoted tuple`);
  }
  const carried = answer.items[1];
  if (!(carried instanceof Expression)) {
    throw new PettaError(`a binding row came back as ${answer.text}, which is not a quoted tuple`);
  }
  const row: Row = {};
  vars.forEach((variable, index) => {
    const bound = carried.items[index];
    if (bound === undefined) {
      throw new PettaError(
        `a binding row came back with ${String(carried.items.length)} columns where ` +
          `the pattern has ${String(vars.length)}`,
      );
    }
    row[variable.name] = bound;
  });
  return row;
}

/** A grounded atom's host value; anything else is itself. */
export function hostValue(atom: Atom): unknown {
  const held = atom as { kind: string; value?: unknown };
  return held.kind === "grounded" ? held.value : atom;
}

function isTrue(atom: Atom): boolean {
  const value = hostValue(atom);
  if (typeof value === "boolean") return value;
  return atom instanceof Sym && atom.name === "True";
}

/** The engine name behind whatever names a space. */
export function nameOf(space: Space | SpaceHandle | string): string {
  if (typeof space === "string") return space;
  return space instanceof Space ? space.name : space.name;
}
