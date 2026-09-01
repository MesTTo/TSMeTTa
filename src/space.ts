/**
 * Purpose: a named engine space, with the collection protocol JavaScript
 *   already has a word for and the query doors MeTTa already has a meaning
 *   for.
 * Assumes:
 *   - a binding row is protected by `quote`, whose contract is that its
 *     argument does not reduce and whose answer is that operand itself. A bare
 *     tuple template is EVALUATED: with `(uses twice 3)` stored and `twice`
 *     defined, `(match &kb (uses $f $n) ($f $n))` answers 6 rather than the row
 *     [measured 2026-08-27; quote operand return rechecked 2026-08-30]
 * Guarantees:
 *   - `add`, `delete`, `has`, `size` and `clear` mean what `Set` means by them,
 *     so a space reads as the collection it is
 *   - `match` answers ROWS keyed by the pattern's own variable names, in
 *     first-seen order, and values are ATOMS, so an answer composes straight
 *     back into the next term
 *   - `atoms()` walks stored atoms without evaluating any of them
 *   - a transaction returns every answer in engine order rather than only the
 *     last [tested: "keeps every answer of a nondeterministic transaction";
 *     commit=f79cfa2133ee8691c8c21b8a6a59928ddbad7352]
 *   - a ground expression remains a structured space identity across every
 *     collection, query, reflection, and lifecycle door [tested: "keeps
 *     parametric space identities structured and collision-free"; commit=WORKTREE]
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
  G,
  Grounded,
  type Term,
  Expression,
  SpaceHandle,
  Sym,
  type Var,
  expr,
  exprOf,
  lift,
  space as spaceAtom,
  substitute,
  sym,
  termVars,
  toAtom,
  variable,
} from "./atom.ts";
import { Answers, type AskOptions, type Row } from "./answers.ts";
import { type Derivation, derivationOf } from "./derivation.ts";
import { type Engine, type Job, type JobEvent } from "./engine.ts";
import {
  CapabilityError,
  CastError,
  EngineError,
  MettaError,
  ResultError,
  TransportError,
  WireError,
} from "./errors.ts";
import {
  AgendaPolicy,
  AnswerPolicy,
  Atomicity,
  Determinism,
  EffectClass,
  Fidelity,
  type SpaceCapability,
} from "./vocabularies.ts";
import { showsAs } from "./present.ts";
import { atomFromWire, wireFromAtom } from "./wire.ts";

/** The engine's own space, where a declaration ABOUT a space goes. */
const CATALOG = "&metta";

/** A source-safe operation name for one admission guard. */
let nextAdmissionGuard = 1;

/** Refuse a word outside a closed vocabulary, naming the ones there are. */
function requireWord<T extends string>(
  what: string,
  given: T,
  vocabulary: Readonly<Record<string, T>>,
): void {
  const words = Object.values(vocabulary);
  if (!words.includes(given)) {
    throw new MettaError(`${what} is one of ${words.join(", ")}, not ${String(given)}`);
  }
}

const QUOTE = sym("quote");

/** Targets the engine compiles no check for; a cast mirrors that. */
const UNCHECKED = new Set(["Atom", "%Undefined%", "_"]);

/** What a derivation walk accepts beside the target. */
export interface DerivationOptions extends AskOptions {
  /**
   * How deep to walk before answering `truncated` nodes.
   *
   * Unbounded by default. The engine's own limits scope is what bounds an
   * unbounded walk, which is where a budget belongs.
   */
  readonly depth?: number;
}

/** What a space is created with. */
export interface SpaceOptions {
  /**
   * The space this one reads through.
   *
   * A child reads its parent's atoms and writes its own, which is the engine's
   * own overlay and what a world is built on.
   */
  readonly parent?: Space | SpaceIdentity | string;
  /**
   * The capabilities a restricted space grants.
   *
   * The engine's own `space-capability` vocabulary; a refusal names the
   * capability that was missing. A browser deployment physically lacks `file`,
   * so the vocabulary doubles as the deployment surface.
   */
  readonly grants?: readonly SpaceCapability[];
}

/** An atomic or parametric identity the engine recognizes as a space. */
export type SpaceIdentity = SpaceHandle | Expression;

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
  /**
   * The engine's own id for this watch, when the caller needs to ask about it.
   *
   * A watch mints one for itself by default and nothing outside needs to know
   * it. Pass one from {@link Space.nextWatchId} to be able to ask
   * {@link Space.pendingAdmissions} how much of this watch's queue the engine
   * still holds, which is what a settling barrier is built from.
   */
  readonly watchId?: number;
}

function valueOf(event: JobEvent | null, what: string): Atom {
  if (event === null || event.kind !== "value") {
    throw new EngineError(`the engine answered nothing for ${what}`);
  }
  return event.atom;
}

/**
 * A named engine space.
 *
 * The name is the whole host identity: the store stays in the engine, and two
 * handles with one name are one space. A space is also an ATOM, so it goes
 * into a term wherever a space operand belongs.
 */
export class Space {
  #claimed = false;
  #engine: Engine;

  /** The space's own atom, which is what a term holds. */
  readonly handle: SpaceIdentity;

  /** The transport operand for this identity. @internal */
  readonly reference: unknown;

  /** @internal Use `m.space(...)`. */
  constructor(engine: Engine, handle: SpaceIdentity) {
    this.#engine = engine;
    this.handle = handle;
    this.reference = handle instanceof SpaceHandle ? handle.name : engine.encodeAtom(handle);
    if (handle instanceof SpaceHandle) engine.knownSpaces.add(handle.name);
  }

  /**
   * The reflection space of the engine this space belongs to.
   *
   * A space's identity is its NAME and its engine, so this is the same `&metta`
   * `m.catalog` names; it is here so a door that needs both a space and the
   * catalog — declaring an algebra, reading a context's capabilities — takes
   * one argument rather than two.
   */
  get catalog(): Space {
    return new Space(this.#engine, spaceAtom("&metta"));
  }

  /** The ampersand-prefixed engine name. */
  get name(): string {
    return this.handle.text;
  }

  toString(): string {
    return this.handle.text;
  }

  get [Symbol.toStringTag](): string {
    return `Space(${this.handle.text})`;
  }

  #command(command: readonly unknown[]): Job {
    return this.#engine.start(command);
  }

  /** A watch id no other watch in this engine is using. */
  nextWatchId(): number {
    return this.#engine.nextWatchId();
  }

  /**
   * How many admissions the engine still holds for one watch.
   *
   * A watch is POLLED, so an event exists in the engine before any poll
   * fetches it, and a host that wants to know whether a write has been seen
   * cannot answer from its own side alone. This is the engine's half of that
   * question; {@link Subscription.settled} is what puts the two halves
   * together.
   */
  pendingAdmissions(watchId: number): number {
    const event = this.#command(["watchpending", watchId]).sync();
    if (event === null || event.kind !== "value") return 0;
    return Number(hostValue(event.atom));
  }

  #wire(term: Term): unknown {
    return this.#engine.encodeAtom(toAtom(term));
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
    this.#command(["add", this.reference, atoms.map((atom) => this.#wire(atom))]).sync();
    return this;
  }

  /** The awaiting twin, for a space whose admission gate reaches an async operation. */
  async added(...atoms: readonly Term[]): Promise<this> {
    if (atoms.length === 0) return this;
    await this.#command(["add", this.reference, atoms.map((atom) => this.#wire(atom))]).all();
    return this;
  }

  /**
   * Remove one atom. Answers whether anything went, which is what
   * `Set.prototype.delete` answers.
   *
   * MeTTa's language-level `remove-atom` drains every unifying occurrence and
   * answers `true` whether one existed or not. This host collection door uses
   * `metta_host_remove_reported/3`, the engine's one-occurrence seam with an
   * honest presence verdict, so the two grains stay explicit.
   */
  delete(atom: Term): boolean {
    const verdict = valueOf(
      this.#command(["remove", this.reference, this.#wire(atom)]).sync(),
      "delete",
    );
    return isTrue(verdict);
  }

  /**
   * A sha256 of everything this space holds, content and nothing else.
   *
   * Each atom is canonicalized by the engine -- copied fresh with numbered
   * variables, so alpha-equivalent equations print identically in every
   * process -- the lines are multiset-sorted, so insertion order cannot
   * matter, and the whole is hashed as one UTF-8 document. Two spaces agree
   * on this exactly when they hold the same atoms up to alpha.
   *
   * A space holding a live host object is REFUSED rather than hashed: a
   * reference prints by address, so its hash would mean nothing in another
   * process, which is the one thing a digest is for.
   */
  digest(): string {
    return String(hostValue(valueOf(this.#command(["digest", this.reference]).sync(), "digest")));
  }

  /**
   * Declare how faithfully this space answers queries of one shape.
   *
   * ```ts
   * kb.handles(S.user(V.id, V.name), "Exact");
   * kb.handles(S.scan(V.anything), "Refuse");
   * ```
   *
   * Queries route by the most specific declared shape that matches. `Exact`
   * licenses pushing the caller's bound to the provider; `Partial` and `Sound`
   * stay candidates the engine re-unifies; `Refuse` makes the query a loud
   * error rather than a silent partial answer. Write `(in $x)` at a position
   * to match only queries arriving with it bound, so a scan-only source is
   * three words.
   */
  handles(pattern: Term, fidelity: Fidelity, options: { readonly det?: Determinism } = {}): Atom {
    requireWord("fidelity", fidelity, Fidelity);
    if (options.det !== undefined) requireWord("det", options.det, Determinism);
    const parts = [sym("handles"), this.handle, toAtom(pattern), sym(fidelity)];
    if (options.det !== undefined) parts.push(sym(options.det));
    // A `handles` row is keyed by SHAPE as well as by space, so declaring one
    // for a second shape adds rather than replaces: queries route by the most
    // specific declared shape that matches, and there has to be more than one
    // for that to mean anything. The subject-keyed rows below replace.
    const atom = expr(...parts);
    this.#command(["add", CATALOG, [this.#wire(atom)]]).sync();
    return atom;
  }

  /**
   * Declare the strongest effect a world reified from this space can handle.
   *
   * World evaluation always admits `pureStructural`. A stronger joined plan
   * runs only when this declaration is at least as strong, so a world that
   * writes has to say so before it may.
   */
  covers(effect: EffectClass): Atom {
    requireWord("effect", effect, EffectClass);
    return this.#declare(expr(sym("covers"), this.handle, sym(effect)), 2);
  }

  /**
   * Declare what this space's writes promise inside a transaction.
   *
   * `transactional` is committed or rolled back WITH the engine's transaction
   * and requires a provider implementing `begin`, `commit` and `rollback`;
   * `best-effort` is the author's declared acceptance of a write that survives
   * a rollback; `atomic-single` refuses transactional writes. An undeclared
   * space refuses them loudly too, because a foreign write silently surviving
   * a rolled-back transaction is the wrong answer this declaration replaces.
   */
  writes(atomicity: Atomicity): Atom {
    requireWord("atomicity", atomicity, Atomicity);
    return this.#declare(expr(sym("writes"), this.handle, sym(atomicity)), 2);
  }

  /**
   * Declare the order this space emits its own answers in.
   *
   * `best-first` is the promise `(top k ...)` needs before its bound may reach
   * the provider: the first k of a best-first emission ARE the k best.
   * Distinct from the `(merge <pattern> <policy>)` strategy, which is how the
   * ENGINE merges answers across several contexts.
   */
  emits(policy: AnswerPolicy): Atom {
    requireWord("policy", policy, AnswerPolicy);
    return this.#declare(expr(sym("emits"), this.handle, sym(policy)), 2);
  }

  /**
   * One subject-keyed catalog row, replacing whatever was there.
   *
   * A declaration about a space is a FACT rather than a multiset member: two
   * rows saying different things about one space is not a stronger claim, it
   * is an unanswerable one.
   *
   * `keys` is how many leading items identify the row -- the head and the
   * subject -- and `tails` are the widths the rest can have, because a MeTTa
   * pattern has a fixed arity and cannot say "and anything after". `agenda`
   * has two shapes, with and without the scoring function, so both are swept.
   * Getting this wrong is not a small mistake: a pattern one item too short
   * matches every OTHER space's row as well, and declaring here would silently
   * undeclare there.
   */
  #declare(atom: Atom, keys: number, tails: readonly number[] = [1]): Atom {
    const head = (atom as Expression).items.slice(0, keys);
    for (const width of tails) {
      const previous = expr(
        ...head,
        ...Array.from({ length: width }, (_, at) => variable(`previous${String(at)}`)),
      );
      // Every previous row of this shape, not just one: the host removal seam
      // removes one occurrence and reports false on absence, so a repeated
      // declaration cannot leave an earlier answer to be found later.
      while (
        isTrue(valueOf(this.#command(["remove", CATALOG, this.#wire(previous)]).sync(), "declare"))
      ) {
        // The removal verdict is the loop's termination test.
      }
    }
    this.#command(["add", CATALOG, [this.#wire(atom)]]).sync();
    return atom;
  }

  /**
   * Bound this space: an add beyond `limit` atoms is refused loudly.
   *
   * ```ts
   * pool.capacity(2);
   * pool.add(S.a, S.b);
   * pool.add(S.c);        // refused: [pool-at-capacity, 2]
   * ```
   *
   * The bound is the engine's own admission gate rather than a check here, so
   * it holds for every write path into this space, including one a reaction or
   * another host made. Redeclaring replaces the previous bound.
   */
  capacity(limit: number): Atom {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new MettaError(`capacity is a positive whole number, not ${String(limit)}`);
    }
    const declared = this.#declare(expr(sym("capacity"), this.handle, G(limit)), 2);
    // The row is DATA; claiming the gate is what makes it act, and this is
    // sugar for the claim rather than a consequence of the row. That
    // separation is the engine's and it is load-bearing: the pre-add hook
    // takes ONE claimant, and a program that writes its own admission judge --
    // examples/ch15-.../04-admission_pools.metta does exactly that -- must be
    // able to claim the slot itself. A capacity row that claimed the shipped
    // judge on its own would lock that program out.
    //
    // Both halves are published builtins, so this is the same claim the other
    // seats make, written in MeTTa rather than reaching into the engine.
    if (!this.#claimed) {
      const guard = `space-admission-guard-${String(nextAdmissionGuard)}`;
      nextAdmissionGuard += 1;
      this.#command([
        "run",
        `(= (${guard} $x) (space-admission-verdict ${this.name} $x))\n` +
          `!(declare-pre-add! ${this.name} ${guard})`,
      ]).sync();
      this.#claimed = true;
    }
    return declared;
  }

  /**
   * Declare a REACTION: when an atom matching a pattern lands here, run an
   * operation under the match's own bindings.
   *
   * ```ts
   * alarms.reacts(S.alert(V.what), S.insert(S["&log"], S.all(V.what)));
   * alarms.add(S.alert(S.fire));            // (all fire) lands in &log
   * ```
   *
   * The managed heads are `(insert <ctx> <atom>)`, `(retract <ctx> <atom>)` and
   * `(revise <ctx> <old> <new>)`, and they route through the same write paths a
   * direct write does, so a provider's capabilities and declared atomicity
   * govern a bridged write exactly as a direct one. A cascade is bounded at
   * depth 32 and throws naming the chain, because an unbounded insert loop is
   * a bug rather than a fixpoint.
   *
   * `subscribe` is the NEIGHBOUR of this, not a special case: a reaction's
   * operation runs ENGINE-side, so it reaches registered spaces, while a
   * subscription delivers host-side to anything with `add` and `remove`. Same
   * idea, two delivery tiers.
   *
   * Reactions accumulate, one row per declaration; `agenda` says which fires
   * first when several match one write.
   */
  reacts(pattern: Term, operation: Term, options: { readonly priority?: number } = {}): Atom {
    const parts: Atom[] = [sym("on"), this.handle, toAtom(pattern), toAtom(operation)];
    if (options.priority !== undefined) {
      if (!Number.isInteger(options.priority)) {
        throw new MettaError(`priority is a whole number, not ${String(options.priority)}`);
      }
      parts.push(G(options.priority));
    }
    const atom = expr(...parts);
    this.#command(["add", CATALOG, [this.#wire(atom)]]).sync();
    return atom;
  }

  /**
   * Declare which reaction fires first when several match one write.
   *
   * ```ts
   * alarms.reacts(S.alert(V.w), S.insert(S["&log"], S.all(V.w)));
   * alarms.reacts(S.alert(S.fire), S.insert(S["&log"], S.urgent()), { priority: 9 });
   * alarms.agenda("priority");
   * ```
   *
   * `declaration` is the default and the order they were declared; `recency`
   * is the most recently declared first; `specificity` is the most tests in
   * the pattern first; `priority` reads each reaction's own number, highest
   * first; and `user` names a MeTTa function that SCORES a reaction, highest
   * first. Every policy breaks ties on declaration order.
   *
   * These five are a production system's conflict-resolution strategies under
   * their usual names: OPS5 and CLIPS resolve a conflict set the same way, and
   * `specificity` means there what it means here.
   */
  agenda(policy: AgendaPolicy, options: { readonly by?: string } = {}): Atom {
    requireWord("policy", policy, AgendaPolicy);
    if ((policy === "user") !== (options.by !== undefined)) {
      throw new MettaError(
        "the user policy names the MeTTa function that scores a reaction, and no other " +
          "policy takes one",
      );
    }
    const atom =
      options.by === undefined
        ? expr(sym("agenda"), this.handle, sym(policy))
        : expr(sym("agenda"), this.handle, sym(policy), sym(options.by));
    // Two shapes, with and without the scoring function, so both are swept.
    return this.#declare(atom, 2, [1, 2]);
  }

  /**
   * Run one term inside a closed engine transaction.
   *
   * ```ts
   * kb.transaction(S.progn(write, verify));
   * ```
   *
   * Every engine write it makes -- stored atoms, equations and their compiled
   * clauses -- commits or rolls back together. It answers the term's engine
   * answers, and rolls back when that answer set is EMPTY, which is the
   * engine's own law for `(transaction ...)`.
   *
   * A host CALLABLE cannot be the body here, and the reason is architectural
   * rather than missing work. This seat reaches JavaScript by suspending the
   * engine, and the engine says exactly why that cannot happen inside one:
   * "a host operation was reached where the engine cannot suspend: it is
   * running outside a job, or inside a transaction or speculate scope, and
   * engine_yield/1 cannot unwind through either". The Python seat can pass a
   * callable because its crossing is a direct call rather than a suspension.
   * Build the work as a TERM and this door runs it atomically; that is the
   * substitute, and it is the whole of one.
   */
  transaction(target: Term): Atom[] {
    // A NAME is callable too -- `S.progn` is a function carrying its own atom
    // -- so the test is whether lifting it gives back the function itself,
    // which is what `project` asks in the same situation.
    const lifted = typeof target === "function" ? lift(target) : undefined;
    if (lifted instanceof Grounded && lifted.value === target) {
      throw new CapabilityError(
        "a transaction body here is a TERM rather than a callable: this seat reaches " +
          "JavaScript by suspending the engine, and engine_yield/1 cannot unwind through " +
          "a transaction. Build the work as a term and this door runs it atomically",
      );
    }
    const held = this.#command([
      "eval",
      this.#wire(expr(sym("transaction"), toAtom(target))),
      this.reference,
    ]);
    return held
      .syncAll()
      .filter((event): event is JobEvent & { readonly kind: "answer" } => event.kind === "answer")
      .map((event) => event.atom);
  }

  /** Whether an atom unifying with this pattern is stored. */
  has(pattern: Term): boolean {
    const verdict = valueOf(
      this.#command(["has", this.reference, this.#wire(pattern)]).sync(),
      "has",
    );
    return isTrue(verdict);
  }

  /** How many atoms are stored. */
  get size(): number {
    const count = valueOf(this.#command(["count", this.reference]).sync(), "size");
    return Number(hostValue(count));
  }

  /** Remove every atom. */
  clear(): void {
    this.#command(["clear", this.reference]).sync();
  }

  /** Every stored atom, one at a time, without evaluating any of them. */
  atoms(options: AskOptions = {}): Answers<Atom> {
    return this.#stream(`atoms(${this.name})`, ["atoms", this.reference], options);
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
    const wire = engine.encodeAtom(query);
    const name = this.name;
    const reference = this.reference;
    // Built directly rather than through `.map`, because a derived ask carries
    // no PLAN and a traced body needs the plan to lower this goal into an
    // equation rather than run it.
    return new Answers<Row>(
      `match(${name}, ${matched.text})`,
      () => {
        const answers = answerIterator(engine.start(["eval", wire, reference]));
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
      { kind: "match", space: this.handle, pattern: matched, vars },
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
    const report = valueOf(
      this.#command(["explain", this.reference, wires]).sync(),
      "explain",
    );
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
    const reference = this.reference;
    const wire = this.#wire(pattern);
    const edges = options.edges ?? ["add", "remove"];
    const pollMs = options.pollMs ?? 5;
    const description = `watch(${name}, ${toAtom(pattern).text})`;
    return new Answers<Admission>(
      description,
      (signal) => {
        const id = options.watchId ?? engine.nextWatchId();
        engine.start(["watch", id, reference, wire, [...edges]]).sync();
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
                    atom: event.atom,
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

  /**
   * This space's structured `get-doc` answer for one subject.
   *
   * The `(@doc ...)` atom the engine holds, whether the subject was documented
   * in MeTTa source or built from a host body's own doc comment. A subject
   * with no documentation answers nothing, so `.one()` refuses by name exactly
   * as `get-type` does for a subject it cannot type.
   */
  doc(subject: Term, options: AskOptions = {}): Answers<Atom> {
    return this.eval(expr(sym("get-doc"), this.handle, toAtom(subject)), options);
  }

  /**
   * Solve a relation BACKWARDS, and answer rows keyed by its variables.
   *
   * ```ts
   * await kb.solve(4, sub(V.x, 1)).one();   // { x: G(5) }
   * ```
   *
   * The known value goes on the pattern side and the relation solves the
   * other way, which is what the engine's `let` does when its subject is an
   * arithmetic relation. The answer template is derived from the pattern's
   * variables followed by any the subject introduces, so the third hand-written
   * `let` argument disappears.
   */
  solve(pattern: Term, subject: Term, options: AskOptions = {}): Answers<Row> {
    const left = toAtom(pattern);
    const right = toAtom(subject);
    const columns = [...termVars(left), ...termVars(right).filter((v) => !termVars(left).includes(v))];
    if (columns.length === 0) {
      throw new MettaError("solve needs at least one variable in its pattern or its subject");
    }
    const query = expr(sym("let"), left, right, expr(QUOTE, exprOf(columns)));
    const answers = this.#eval(`solve(${left.text}, ${right.text})`, query, options);
    return answers.map((answer) => rowOf(answer, columns)) as unknown as Answers<Row>;
  }

  /**
   * Whether this space's type discipline admits a value as a type, narrowed.
   *
   * ```ts
   * kb.run?.("(: Ann Person)");
   * kb.cast(S.Ann, S.Person);     // the atom
   * kb.cast(3, S.Number);         // 3
   * kb.cast(S.Ann, S.Dog);        // throws CastError naming Ann's real types
   * ```
   *
   * `get-metatype` answers for a value the type system has no declaration for,
   * which is what makes a cast to `Number` succeed on `3` without anybody
   * having declared it.
   */
  cast(value: Term, type: Term): unknown {
    const atom = toAtom(value);
    const target = toAtom(type);
    if (UNCHECKED.has(target.text)) return hostValue(atom);
    const verdict = valueOf(
      this.#command(["cast", this.reference, this.#wire(atom), this.#wire(target)]).sync(),
      "cast",
    );
    if (isTrue(verdict)) return hostValue(atom);
    const held = verdict instanceof Expression ? verdict.items.map((item) => item.text) : [];
    throw new CastError(
      `${atom.text} does not admit type ${target.text} in ${this.name}: ` +
        `its types are ${held.length === 0 ? "none" : held.join(", ")}`,
    );
  }

  /**
   * Reduce a term to its ONE answer, without awaiting.
   *
   * The door for a reduction whose answer the caller's next line needs and
   * whose body cannot reach an asynchronous host operation: an arithmetic
   * step, a state read, a settled question. A reduction that DOES reach one
   * refuses here by name, because the remedy is the awaiting form and saying
   * so is more use than a hang.
   */
  runOne(term: Term): Atom {
    const built = toAtom(term);
    const event = this.#command(["eval", this.#wire(built), this.reference]).sync();
    if (event === null || event.kind !== "answer") {
      throw new ResultError(
        `${built.text} answered nothing, where one answer was required`,
      );
    }
    return event.atom;
  }

  /**
   * Every proof of one answer, as a tree.
   *
   * Meta-interpreted, so slower than evaluation: a diagnostic rather than an
   * evaluation path. The default walks each proof without a depth cutoff; a
   * positive depth answers a partial tree with `truncated` nodes when its
   * budget ends, so an empty answer set means NO proof and never a budget.
   */
  derivation(target: Term, options: DerivationOptions = {}): Answers<Derivation> {
    const engine = this.#engine;
    const built = toAtom(target);
    const wire = this.#wire(built);
    const name = this.name;
    const reference = this.reference;
    const depth = options.depth ?? -1;
    return new Answers<Atom>(
      `derivation(${built.text})`,
      () => answerIterator(engine.start(["derivation", reference, wire, depth])),
      options.signal,
    ).map(derivationOf);
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
  restrict(grants: readonly SpaceCapability[]): this {
    this.#command(["restrict", this.reference, [...grants]]).sync();
    return this;
  }

  /** Declare that this space reads through `parent` and writes locally. */
  readsThrough(parent: Space | SpaceIdentity | string): this {
    const reference =
      parent instanceof Space
        ? parent.reference
        : parent instanceof Expression
          ? this.#engine.encodeAtom(parent)
          : typeof parent === "string"
            ? parent
            : parent.name;
    this.#command(["child", this.reference, reference]).sync();
    return this;
  }

  /** Mark this space releasable, and release it. */
  release(): void {
    this.#command(["releasable", this.reference]).sync();
    this.#command(["release", this.reference]).sync();
  }

  // --- internals ------------------------------------------------------------

  #eval(description: string, term: Atom, options: AskOptions): Answers<Atom> {
    const engine = this.#engine;
    const wire = engine.encodeAtom(term);
    const name = this.name;
    const reference = this.reference;
    return new Answers<Atom>(
      description,
      () => answerIterator(engine.start(["eval", wire, reference])),
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

// A space prints as the name it is, not as a dump of the engine behind it.
showsAs(Space.prototype, (space: Space) => `Space(${space.name})`);

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
          throw new TransportError(
          `this ask produced a ${event.kind} where an answer was expected`,
        );
        }
        return { done: false, value: event.atom };
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

/** Zip the tuple returned through `quote` against the pattern's variables. */
export function rowOf(answer: Atom, vars: readonly Var[]): Row {
  if (!(answer instanceof Expression)) {
    throw new WireError(`a binding row came back as ${answer.text}, which is not a tuple`);
  }
  if (answer.items.length !== vars.length) {
    throw new WireError(
      `a binding row came back with ${String(answer.items.length)} columns where ` +
        `the pattern has ${String(vars.length)}`,
    );
  }
  const row: Row = {};
  vars.forEach((variable, index) => {
    row[variable.name] = answer.items[index]!;
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
  // Either spelling reads to the one constant, so both are accepted here.
  return atom instanceof Sym && (atom.name === "true" || atom.name === "True");
}

/** The engine name behind whatever names a space. */
export function nameOf(space: Space | SpaceHandle | string): string {
  if (typeof space === "string") return space;
  return space instanceof Space ? space.name : space.name;
}
