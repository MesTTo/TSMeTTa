/**
 * Purpose: the surface a program holds. One object with the doors on it:
 *   spaces, asks, the three definition doors, the scopes, the reflection
 *   verbs, and the extension tier.
 * Assumes:
 *   - the engine is the meaning and TypeScript is the notation, so every door
 *     here either builds a term or asks the engine one
 * Guarantees:
 *   - `await metta()` is the whole boot: a module may say it at top level
 *   - an ask is lazy, a definition costs no crossing per call, and a scope
 *     restores itself
 *   - nothing this surface does writes to the host's console
 * Owns: one engine, its spaces, its registered operations, and its scopes.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  type Atom,
  type Term,
  Expression,
  SpaceHandle,
  Sym,
  expr,
  space as spaceAtom,
  sym,
  termVars,
  toAtom,
} from "./atom.ts";
import { existsSync, statSync } from "node:fs";

import { Answers, type AskOptions, type Row } from "./answers.ts";
import { type Derivation } from "./derivation.ts";
import {
  type Capability,
  type Counters,
  type EffectClass,
  type Engine,
  type JobEvent,
  type OpKind,
  type Scope,
  boot as bootEngine,
} from "./engine.ts";
import {
  MettaError,
  NameError,
  ResultError,
  SourceNotFoundError,
} from "./errors.ts";
import { race as raceAsks } from "./parallel.ts";
import { showsAs } from "./present.ts";
import { type Library, useLibrary } from "./library.ts";
import { mettaName } from "./naming.ts";
import { Schema, type SchemaDeclarations } from "./schema.ts";
import { ScopeHandle, Stats, World, nextWorldName } from "./scopes.ts";
import type { Limits } from "./scopes.ts";
import {
  type Admission,
  type DerivationOptions,
  Space,
  type SpaceOptions,
  type WatchOptions,
  answerIterator,
  hostValue,
  rowOf,
} from "./space.ts";
import { type SpaceProvider, registerProvider, unregisterProvider } from "./provider.ts";
import { view } from "./spaces.ts";
import { type Defined, type DefineOptions, type OpOptions, define as defineDoor, isTracing, op as opDoor } from "./define/define.ts";
import { State, type StateOptions, type Widen } from "./state.ts";
import { type TheoryClass, methodsOf } from "./theory.ts";
import { atomFromWire, fromTransport, toTransport, wireFromAtom } from "./wire.ts";

export type { Limits };

/** One group of answers: everything one `!` directive answered. */
export interface AnswerGroup {
  /** The answers, in the order the engine produced them. */
  readonly answers: readonly Atom[];
  /** The engine's own rendering of each one. */
  readonly texts: readonly string[];
}

/** What `boot` accepts. */
export interface BootOptions {
  /** The MeTTa Kernel checkout to mount. The one this package lives in, by default. */
  readonly root?: string;
  /** Whether the engine's own trace also reaches the console. */
  readonly verbose?: boolean;
}

/** What the engine did with one directive. */
export type DirectiveStatus = "value" | "not-reducible" | "empty";

/** One directive's answer, with what the engine did to produce it. */
export interface StatusRow {
  readonly status: DirectiveStatus;
  readonly answer: Atom;
  readonly text: string;
}

/** One directive's answers, each with its status. */
export type StatusGroup = readonly StatusRow[];

/** One top-level form of some source, as the engine's own reader saw it. */
export interface Form {
  /** The kind the reader gave it: `function`, `runnable`, and the rest. */
  readonly kind: string;
  /** Its source text, exactly as written. */
  readonly text: string;
  /** The atom it reads as. */
  readonly atom: Atom;
}

/** What `trace` accepts beside the source. */
export interface TraceOptions {
  /** The space to run in. The engine's own, by default. */
  readonly space?: Space;
  /** How many events to record before stopping. Ten thousand, by default. */
  readonly maxEvents?: number;
}

/** One event of a reduction trace. */
export type TraceEvent =
  | { readonly depth: number; readonly kind: "call"; readonly term: Atom }
  | {
      readonly depth: number;
      readonly kind: "exit";
      readonly term: Atom;
      readonly answer: Atom;
    };

/** What `reconcile` was asked to make true. */
export interface ReconcileReport {
  readonly added: readonly Atom[];
  readonly removed: readonly Atom[];
}

/**
 * A booted engine and the surface over it.
 *
 * ```ts
 * const m = await metta();
 * m.add(S.parent(S.tom, S.bob));
 * for await (const { x } of m.match(S.parent(V.x, S.bob))) console.log(String(x));
 * ```
 */
export class MeTTa implements Disposable {
  #engine: Engine;
  #spaces = new Map<string, Space>();
  #known = new Set<string>();
  #scopes: Scope[] = [];

  /** The engine's own default space. */
  readonly self: Space;

  /**
   * The reflection space.
   *
   * Everything the engine knows about itself is an ordinary atom in here, so a
   * MeTTa program and a TypeScript program read the library's own surface the
   * same way.
   */
  readonly catalog: Space;

  /** @internal Use {@link metta} or {@link MeTTa.boot}. */
  constructor(engine: Engine) {
    this.#engine = engine;
    this.self = this.space("&self");
    this.catalog = this.space("&metta");
    engine.scopes = this.#scopes;
  }

  /** Boot an engine in this process. */
  static async boot(options: BootOptions = {}): Promise<MeTTa> {
    return new MeTTa(await bootEngine(options));
  }

  /**
   * What this build does without, each with what it costs.
   *
   * Read from the engine's own platform census rather than recovered by regex
   * over its boot transcript, so the costs are the engine's words and the two
   * cannot drift. A full SWI answers nothing here; a WebAssembly build names
   * concurrency, deadlines and subprocess.
   */
  get refusals(): readonly Capability[] {
    return this.#engine.refusals;
  }

  // --- spaces ---------------------------------------------------------------

  /**
   * A space by name, minting the handle the first time.
   *
   * A space is named by an ATOM at the creation door, so a parametric space is
   * a handle like any other: `m.space(S.cache(primary, 100))` names one space
   * per parameter set, and a program reads its own parameters back by matching
   * the name.
   */
  space(name: Term, options: SpaceOptions = {}): Space {
    const engineName = spaceNameOf(name);
    let held = this.#spaces.get(engineName);
    if (held === undefined) {
      held = new Space(this.#engine, spaceAtom(engineName));
      this.#spaces.set(engineName, held);
    }
    if (options.parent !== undefined) held.readsThrough(options.parent);
    if (options.grants !== undefined) held.restrict(options.grants);
    return held;
  }

  /** Every space this engine has registered. */
  spaces(): SpaceHandle[] {
    const event = this.#engine.start(["spacenames"]).sync();
    if (event === null || event.kind !== "value") return [];
    const listed = event.atom;
    if (!(listed instanceof Expression)) return [];
    return listed.items.filter((item): item is SpaceHandle => item instanceof SpaceHandle);
  }

  /** Admit atoms into the engine's own space. */
  add(...atoms: readonly Term[]): this {
    this.self.add(...atoms);
    return this;
  }

  /** Remove one atom from the engine's own space. */
  remove(atom: Term): boolean {
    return this.self.delete(atom);
  }

  /** Whether the engine's own space holds an atom unifying with this pattern. */
  has(pattern: Term): boolean {
    return this.self.has(pattern);
  }

  // --- asks -----------------------------------------------------------------

  /** The answers to a pattern in the engine's own space. */
  match(pattern: Term, options?: AskOptions): Answers<Row>;
  match(pattern: Term, template: Term, options?: AskOptions): Answers<Atom>;
  match(
    pattern: Term,
    templateOrOptions?: Term | AskOptions,
    options?: AskOptions,
  ): Answers<Row> | Answers<Atom> {
    return (this.self.match as (...args: unknown[]) => Answers<Row> | Answers<Atom>)(
      pattern,
      templateOrOptions,
      options,
    );
  }

  /**
   * Reduce a term, one answer at a time.
   *
   * The term-in-hand door. Nothing runs until the answers are consumed, and
   * abandoning them closes the engine behind them.
   */
  eval(term: Term, options: AskOptions = {}): Answers<Atom> {
    return this.ask(toAtom(term), this.self, options);
  }

  /** @internal The ask every callable and every door goes through. */
  ask(term: Atom, space: Space, options: AskOptions = {}): Answers<Atom> {
    const engine = this.#engine;
    const wire = engine.encodeAtom(term);
    const name = space.name;
    return new Answers<Atom>(
      term.text,
      () => answerIterator(engine.start(["eval", wire, name])),
      options.signal,
      { kind: "eval", space: name, term },
    );
  }

  /**
   * Run MeTTa source. One group of answers per `!` directive, in source order.
   *
   * The program door, for text that carries definitions and directives
   * together. `eval` is the door for a term already in hand.
   */
  run(source: string): AnswerGroup[] {
    return groupsOf(this.#engine.start(["run", source]).sync());
  }

  /**
   * Run source and report, per directive, whether the engine reduced it.
   *
   * Which directives reduced and which answered themselves: `value` for a
   * directive that reduced, `not-reducible` for one that answered itself, and
   * `empty` for a pruned branch.
   */
  runStatus(source: string, space: Space = this.self): StatusGroup[] {
    const event = this.#engine.start(["runstatus", source, space.name]).sync();
    if (event === null || event.kind !== "value") return [];
    const groups = event.atom;
    if (!(groups instanceof Expression)) return [];
    return groups.items.map((group) =>
      (group as Expression).items.map((row) => {
        const parts = (row as Expression).items;
        return {
          status: String(parts[0]) as DirectiveStatus,
          answer: parts[1] as Atom,
          text: String(hostValue(parts[2] as Atom)),
        };
      }),
    );
  }

  /**
   * Whether the engine has anything to apply to a term's head.
   *
   * The engine's own test, `metta_reducible_head/2`, which is the one
   * `runStatus` asks of a directive. It reduces nothing.
   */
  reducible(term: Term, space: Space = this.self): boolean {
    const event = this.#engine
      .start(["reducible", space.name, this.#engine.encodeAtom(toAtom(term))])
      .sync();
    return event !== null && event.kind === "value" && hostValue(event.atom) === true;
  }

  /**
   * Reduce a term and pair each answer with how it arose.
   *
   * ```ts
   * m.evalStatus(S.double(4));    // [{ status: "value", answer: 8 }]
   * m.evalStatus(S.Point(1, 2));  // [{ status: "not-reducible", answer: (Point 1 2) }]
   * ```
   *
   * `value` means an equation, builtin or special form applied.
   * `not-reducible` means none did, so the answer is the term itself, which is
   * what MeTTa does with any head it cannot call. `empty` means the goal
   * answered nothing at all and its atom is the symbol `none`. Reading the
   * last two as the same thing is the mistake this exists to prevent, and it
   * is the term-shaped question the way `runStatus` is the source-shaped
   * one; a caller who wants to decide about an unreduced term asks here.
   */
  evalStatus(term: Term, space: Space = this.self): StatusGroup {
    const atom = toAtom(term);
    const status: DirectiveStatus = this.reducible(atom, space) ? "value" : "not-reducible";
    const job = this.#engine.start(["eval", this.#engine.encodeAtom(atom), space.name]);
    const rows: StatusRow[] = [];
    for (;;) {
      const event = job.sync();
      if (event === null) break;
      if (event.kind === "answer") rows.push({ status, answer: event.atom, text: event.text });
    }
    if (rows.length === 0) return [{ status: "empty", answer: sym("none"), text: "none" }];
    return rows;
  }

  /**
   * The string rung, checked by the type system and priced at the engine.
   *
   * ```ts
   * m.load`(= (fib $n) (if (< $n 2) $n (+ (fib (- $n 1)) (fib (- $n 2)))))`;
   * ```
   *
   * A hole is a TERM, so a built atom drops into the text without being
   * spelled out: `` m.load`(= (limit) ${G(100)})` ``.
   */
  load(source: TemplateStringsArray | string, ...holes: readonly Term[]): AnswerGroup[] {
    return this.run(interpolate(source, holes));
  }

  /**
   * Load a `.metta` file.
   *
   * Its directory is mounted at the same absolute path first, so a relative
   * `import!` beside it resolves exactly as it does on disk, and it goes
   * through the engine's own loader, so a second load of the same file replaces
   * that file's definitions rather than doubling them.
   */
  /**
   * Install a THEORY: a class whose methods are its equations.
   *
   * A class with no marks installs every own prototype method; one with
   * `@equation`, `@grounded` or `@tabled` marks installs exactly those, which
   * is the opt-in for a class that also carries helpers. The unit door stays
   * `define`; this is the grouping form and is required nowhere.
   *
   * Note that a decorator needs a BUILD: TypeScript compiles Stage-3 method
   * decorators, and V8 has not shipped them, so a decorated class does not run
   * under Node's own type stripping. The unmarked form runs everywhere.
   */
  theory(target: TheoryClass, options: DefineOptions = {}): Defined[] {
    return methodsOf(target).map((method) => {
      const named = method.name === undefined ? {} : { name: method.name };
      const settings = { ...options, ...named };
      if (method.door === "op") return this.op(method.body, settings);
      if (method.door === "cache") return this.cache(method.body, settings);
      return this.define(method.body, settings);
    });
  }

  /**
   * The first answer wins, and the losers are cancelled.
   *
   * Structured concurrency with the platform's own cancellation: each ask runs
   * under a signal of its own, and the first one to answer aborts its
   * siblings. `Promise.any` is the platform's word for it and this is that
   * word with the cancellation wired.
   */
  async race<T>(asks: readonly Answers<T>[]): Promise<T> {
    return raceAsks(asks);
  }

  /**
   * Register a directory of MeTTa sources under an alias `import!` can name.
   *
   * ```ts
   * m.libraryPath("./vendor/nars", "nars");
   * m.run("!(import! &self nars)");
   * ```
   *
   * The directory is MOUNTED before it is registered, because the engine runs
   * in a WebAssembly filesystem of its own and cannot see this process's:
   * registering a host path the engine cannot reach would refuse at the first
   * import that needed it, which is exactly where a path problem is hardest to
   * read. Only `.metta` and `.pl` files cross, and the alias is idempotent.
   */
  libraryPath(directory: string, alias: string): void {
    const full = resolvePath(directory);
    if (!existsSync(full) || !statSync(full).isDirectory()) {
      throw new SourceNotFoundError(`a library path is a directory that exists, and ${full} is not`);
    }
    this.#engine.mount(full, full, (name) => name.endsWith(".metta") || name.endsWith(".pl"));
    this.run(`!(register_metta_library_path ${alias} "${full}")`);
  }

  loadFile(path: string): AnswerGroup[] {
    const full = resolvePath(path);
    const directory = full.slice(0, full.lastIndexOf("/")) || "/";
    this.#engine.mount(
      directory,
      directory,
      (name) => name.endsWith(".metta") || name.endsWith(".pl"),
    );
    return groupsOf(this.#engine.start(["load", full]).sync());
  }

  /**
   * A source query, typed from its own text.
   *
   * ```ts
   * for await (const { drink } of m.q("(likes Ada $drink)")) { ... }
   * ```
   *
   * The pattern's `$`-variables are read at the TYPE level, so destructuring a
   * name the pattern does not bind is a compile error rather than an undefined.
   */
  q(source: string, options: AskOptions = {}): Answers<Row> {
    const pattern = this.parse(source);
    return this.self.match(pattern, options);
  }

  // --- the doors ------------------------------------------------------------

  /** Install a definition and answer the callable it names. */
  define(target: (...args: never[]) => unknown, options: DefineOptions = {}): Defined {
    return defineDoor(this.#installer(), target, options);
  }

  /** Keep a body as host code the engine calls. */
  op(target: (...args: never[]) => unknown, options: OpOptions = {}): Defined {
    return opDoor(this.#installer(), target, options);
  }

  /**
   * Define, and declare the engine's table for it in one act.
   *
   * The word `cache` here always means the ENGINE's tabling. A host-side
   * memoize would cache handles rather than answer sets and would break
   * multiplicity.
   */
  cache(target: (...args: never[]) => unknown, options: DefineOptions = {}): Defined {
    return this.define(target, { ...options, cache: true });
  }

  #installer(): Parameters<typeof defineDoor>[0] {
    const surface = this;
    return {
      self: this.self,
      knows: (name: string): boolean => surface.#known.has(name),
      register: (
        name: string,
        arity: number,
        kind: OpKind,
        effect: EffectClass,
        run: (args: readonly unknown[]) => unknown,
      ): void => {
        surface.#engine.register({ name, arity, kind, effect, run });
      },
      unregister: (name: string, arity: number): void => {
        surface.#engine.unregister(name, arity);
      },
      ask: (term: Atom, space: Space, options?: AskOptions): Answers<Atom> =>
        surface.ask(term, space, options),
      remember: (name: string): void => {
        surface.#known.add(name);
      },
      declared: (): Iterable<string> => surface.#known,
    };
  }

  /** Whether a body is being traced right now, so a call mentions instead of asking. */
  get tracing(): boolean {
    return isTracing();
  }

  /**
   * Reduce a term to its ONE answer, without awaiting.
   *
   * The door for a reduction whose answer the caller's next line needs and
   * whose body cannot reach an asynchronous host operation: creating a state
   * cell, reading one, asking the engine a settled question. A reduction that
   * DOES reach one refuses here by name.
   */
  runOne(term: Term, space: Space = this.self): Atom {
    return space.runOne(term);
  }

  /**
   * A state cell: one mutable slot the engine holds.
   *
   * ```ts
   * const cell = m.state(S.rest);
   * cell.set(S.active).value;
   * ```
   */
  state<T extends Term>(initial: T, options: StateOptions = {}): State<Widen<T>> {
    return new State<Widen<T>>(this, initial as Widen<T>, options);
  }

  // --- scopes ---------------------------------------------------------------

  /**
   * Bound what every job started inside this block may spend.
   *
   * ```ts
   * using _ = m.limits({ stack: 1_000_000 });
   * ```
   */
  limits(limits: Limits): ScopeHandle {
    const pushed: Scope[] = [];
    if (limits.stack !== undefined) pushed.push(["stack", limits.stack]);
    if (limits.inferences !== undefined) pushed.push(["inferences", limits.inferences]);
    this.#scopes.push(...pushed);
    return new ScopeHandle(() => {
      for (const scope of pushed) {
        const at = this.#scopes.lastIndexOf(scope);
        if (at >= 0) this.#scopes.splice(at, 1);
      }
    });
  }

  /** What the work in this block costs, frozen when the block ends. */
  stats(): Stats {
    return new Stats(this.#engine.counters);
  }

  /** The raw counters, for a caller that wants them without a scope. */
  get counters(): Counters {
    return this.#engine.counters;
  }

  /**
   * A draft over a space: claim, try, then commit or restore.
   *
   * Adds go into a child space the engine makes read through the parent, so a
   * query inside the world sees both; removals are journalled and applied at
   * commit. `restore()` is free, because the parent was never touched.
   */
  world(over: Space = this.self): World {
    const draft = this.space(nextWorldName());
    return new World(this.#engine, over, draft);
  }

  /**
   * Reduce a term with its writes DISCARDED.
   *
   * The engine's own speculative scope. It is for a plan the engine runs by
   * itself: a host operation cannot fire inside it, because `engine_yield/1`
   * cannot unwind through the nested query frame `snapshot/1` opens
   * [measured 2026-08-27]. `world()` is the door for a draft host code takes
   * part in.
   */
  speculate(term: Term, options: AskOptions = {}): Answers<Atom> {
    const engine = this.#engine;
    const built = toAtom(term);
    const wire = engine.encodeAtom(built);
    const name = this.self.name;
    return new Answers<Atom>(
      `speculate(${built.text})`,
      () => answerIterator(engine.start(["eval", wire, name], [["speculate"]])),
      options.signal,
    );
  }

  /**
   * Back a named space with TypeScript.
   *
   * The backing decides the implementation. A {@link SpaceProvider} is used as
   * it is; a `Map`, `Set`, array or plain object is wrapped in a live
   * {@link view} of itself, so the shortest useful spelling is one line:
   *
   * ```ts
   * const scores = new Map([["ada", 3]]);
   * const live = m.attach("&scores", scores);
   * scores.set("bob", 5);                    // no publication step
   * await live.match(S.kv(V.who, V.n));      // both rows
   * ```
   */
  attach(name: Term, backing: SpaceProvider | object): Space {
    const engineName = spaceNameOf(name);
    registerProvider(this.#engine, engineName, asProvider(backing));
    return this.space(engineName);
  }

  /** Stop backing a space with TypeScript; the name is free again afterwards. */
  detach(name: Term): void {
    unregisterProvider(this.#engine, spaceNameOf(name));
  }

  /** The engine's structured documentation for one subject. */
  doc(subject: Term, options: AskOptions = {}): Answers<Atom> {
    return this.self.doc(subject, options);
  }

  /** Solve a relation backwards in the engine's own space. */
  solve(pattern: Term, subject: Term, options: AskOptions = {}): Answers<Row> {
    return this.self.solve(pattern, subject, options);
  }

  /** Whether the type discipline admits a value as a type, narrowed. */
  cast(value: Term, type: Term): unknown {
    return this.self.cast(value, type);
  }

  /** Every proof of one answer, as a tree. */
  derivation(target: Term, options: DerivationOptions = {}): Answers<Derivation> {
    return this.self.derivation(target, options);
  }

  /**
   * Why one answer holds: its FIRST proof, or nothing when there is none.
   *
   * ```ts
   * const proof = await m.why(S.quad(3));
   * console.log(String(proof));
   * ```
   *
   * `derivation` is the door for every proof; this is the door for the one a
   * reader almost always wants, and it stops walking as soon as it has it.
   */
  async why(target: Term, options: DerivationOptions = {}): Promise<Derivation | undefined> {
    return this.self.derivation(target, options).find();
  }

  /**
   * Every top-level form of some source, read but NOT evaluated.
   *
   * The door for a tool: a formatter, a linter, an editor. Each form carries
   * the kind the engine's own reader gave it, its source text, and the atom it
   * read as, so nothing needs a second parse.
   */
  forms(source: string): Form[] {
    const event = this.#engine.start(["forms", source]).sync();
    if (event === null || event.kind !== "value") return [];
    const rows = event.atom;
    if (!(rows instanceof Expression)) return [];
    return rows.items.map((row) => {
      const parts = (row as Expression).items;
      return {
        kind: String(parts[0]),
        text: String(hostValue(parts[1] as Atom)),
        atom: parts[2] as Atom,
      };
    });
  }

  /**
   * The engine's own reduction trace for some source.
   *
   * One event per call and per exit, with the depth the engine was at. The
   * bound is on EVENTS rather than on time, so a runaway reduction still
   * answers what it did before the bound.
   */
  trace(source: string, options: TraceOptions = {}): TraceEvent[] {
    const space = options.space ?? this.self;
    const max = options.maxEvents ?? 10_000;
    const event = this.#engine.start(["trace", source, space.name, max]).sync();
    if (event === null || event.kind !== "value") return [];
    const rows = event.atom;
    if (!(rows instanceof Expression)) return [];
    return rows.items.map((row) => {
      const parts = (row as Expression).items;
      const kind = String(parts[1]) === "exit" ? "exit" : "call";
      const term = parts[2] as Atom;
      return kind === "exit"
        ? { depth: Number(hostValue(parts[0] as Atom)), kind, term, answer: parts[3] as Atom }
        : { depth: Number(hostValue(parts[0] as Atom)), kind, term };
    });
  }

  /**
   * The Prolog clauses one MeTTa name compiled to.
   *
   * The bottom rung of the power ladder: TypeScript, then MeTTa text, then the
   * engine's own instructions. The listing IS the demand, so a function the
   * engine has deferred is compiled by asking for it.
   */
  disassemble(name: string | Sym | Defined, space: Space = this.self): string {
    const head = headOf(name);
    const event = this.#engine.start(["disassemble", space.name, head]).sync();
    if (event === null || event.kind !== "value") {
      throw new NameError(`${head} has no compiled clauses in ${space.name}`);
    }
    return String(hostValue(event.atom));
  }

  // --- reflection -----------------------------------------------------------

  /**
   * The space the ENGINE is evaluating in right now.
   *
   * Asked from inside a host operation it answers the space of the program
   * that called it, because the operation runs inside that program's own
   * module — so an operation can behave per-space without the space being one
   * of its arguments. Asked from outside any evaluation it answers this
   * surface's own default.
   */
  currentSpace(): Space {
    // Inside a host operation the answer came WITH the call; outside one it is
    // asked of the engine, which answers the module it is evaluating in.
    const calling = this.#engine.callingSpace;
    if (calling !== undefined) return this.space(calling);
    const event = this.#engine.start(["currentspace"]).sync();
    if (event === null || event.kind !== "value") return this.self;
    return this.space(event.atom);
  }

  /** One atom of MeTTa source, through the engine's own reader. */
  parse(source: string): Atom {
    return this.#engine.read(source);
  }

  /** The engine's own rendering of an atom, which is the authority on how it spells. */
  text(term: Term): string {
    return this.#engine.text(toAtom(term));
  }

  /** An atom's round trip through the engine: decode it, then encode it back. */
  roundTrip(term: Term): Atom {
    return this.#engine.roundTrip(toAtom(term));
  }

  /** The effect class the engine holds for an operation. */
  effectOf(name: string | Sym | Defined): EffectClass | "unknown" {
    const head =
      typeof name === "string"
        ? mettaName(name)
        : name instanceof Sym
          ? name.name
          : name.head;
    const event = this.#engine.start(["effect", head]).sync();
    if (event === null || event.kind !== "value") return "unknown";
    return String(hostValue(event.atom)) as EffectClass | "unknown";
  }

  /** The engine's own account of how a match will be answered. */
  explain(...patterns: readonly Term[]): string {
    return this.self.explain(...patterns);
  }

  /** Admissions matching a pattern in the engine's own space, as they happen. */
  watch(pattern: Term, options: WatchOptions = {}): Answers<Admission> {
    return this.self.watch(pattern, options);
  }

  // --- declarative sync -----------------------------------------------------

  /**
   * Make a space hold exactly these facts, under a pattern.
   *
   * The declarative-sync idiom, applied to knowledge: declare the fact set, and
   * the difference against what the space holds is added and removed. It is
   * sugar over match, add and remove, and it says so; the point is that a
   * caller states the WHAT and not the delta.
   */
  async reconcile(
    facts: readonly Term[],
    options: { scope?: Term; space?: Space } = {},
  ): Promise<ReconcileReport> {
    const space = options.space ?? this.self;
    const wanted = new Set(facts.map((fact) => toAtom(fact)));
    const scope = options.scope === undefined ? undefined : toAtom(options.scope);
    const held: Atom[] = [];
    for await (const atom of space.atoms()) {
      if (scope === undefined || matchesShape(scope, atom)) held.push(atom);
    }
    const removed = held.filter((atom) => !wanted.has(atom));
    const added = [...wanted].filter((atom) => !held.includes(atom));
    for (const atom of removed) space.delete(atom);
    if (added.length > 0) space.add(...added);
    return { added, removed };
  }

  // --- the extension tier ---------------------------------------------------

  /**
   * Activate a library: its engine-side payload and its TypeScript surface in
   * one act.
   *
   * A library is DATA once it is here: `m.match(S.library(V.name))` enumerates
   * what is loaded, vocabulary included.
   */
  use(library: Library): this {
    useLibrary(this, library);
    return this;
  }

  /** Declare vocabulary, and answer the factories typed from it. */
  schema<D extends SchemaDeclarations>(declarations: D): Schema<D> {
    return new Schema(this, declarations);
  }

  // --- output and lifetime --------------------------------------------------

  /** Everything the engine printed since the last read, and forgets it. */
  drainOutput(): string[] {
    return this.#engine.drainOutput();
  }

  /** Everything the engine wrote to standard error since the last read. */
  drainStderr(): string[] {
    return this.#engine.drainStderr();
  }

  /** @internal The engine underneath, for the conformance kit and the tests. */
  get engine(): Engine {
    return this.#engine;
  }

  /** Release what this surface holds. */
  dispose(): void {
    this.#engine.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

showsAs(MeTTa.prototype, (surface: MeTTa) => `MeTTa(${surface.self.name})`);

/** Boot an engine and answer the surface over it. */
export async function metta(options: BootOptions = {}): Promise<MeTTa> {
  return MeTTa.boot(options);
}

/** The engine name a term names a space by. */
function spaceNameOf(name: Term): string {
  if (typeof name === "string") return name.startsWith("&") ? name : `&${name}`;
  const atom = toAtom(name);
  if (atom instanceof SpaceHandle) return atom.name;
  if (atom instanceof Sym) return atom.name.startsWith("&") ? atom.name : `&${atom.name}`;
  // A parametric space is named by a whole ATOM, so two instances of one shape
  // are two spaces and each reads its own parameters back from its name.
  return `&${atom.text.replace(/\s+/g, "-").replace(/[()]/g, "")}`;
}

/** The engine head behind a name, a symbol or a defined callable. */
function headOf(name: string | Sym | Defined): string {
  if (typeof name === "string") return mettaName(name);
  return name instanceof Sym ? name.name : name.head;
}

/**
 * The provider behind a backing value.
 *
 * A provider is used as it is; anything else is a live VIEW of itself, which
 * is what makes `m.attach("&scores", new Map())` the shortest useful spelling.
 */
function asProvider(backing: SpaceProvider | object): SpaceProvider {
  // The host collections are checked FIRST, because `Set` and `Map` carry
  // `add`, `delete` and `clear` of their own: duck-typing on those alone read
  // a `Set` as a provider that could write and not enumerate, and the engine
  // then refused every query against it.
  if (backing instanceof Map || backing instanceof Set || Array.isArray(backing)) {
    return view(backing);
  }
  const shape = backing as SpaceProvider;
  const answers =
    typeof shape.match === "function" ||
    typeof shape.atoms === "function" ||
    typeof shape.add === "function" ||
    typeof shape.remove === "function";
  return answers ? shape : view(backing);
}

function groupsOf(event: JobEvent | null): AnswerGroup[] {
  if (event === null || event.kind !== "groups") return [];
  return event.groups.map((group) => ({
    answers: group.map((answer) => answer.atom),
    texts: group.map((answer) => answer.text),
  }));
}

function interpolate(source: TemplateStringsArray | string, holes: readonly Term[]): string {
  if (typeof source === "string") return source;
  let written = source[0] ?? "";
  holes.forEach((hole, index) => {
    written += toAtom(hole).text + (source[index + 1] ?? "");
  });
  return written;
}

function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return `${process.cwd()}/${path}`.replace(/\/\.\//g, "/");
}

/** Whether an atom has the shape a scope pattern describes, structurally. */
function matchesShape(scope: Atom, atom: Atom): boolean {
  // A worklist of PAIRS, so a scope pattern as deep as an engine answer still
  // decides rather than overflowing the JavaScript stack.
  const work: Atom[] = [scope, atom];
  while (work.length > 0) {
    const held = work.pop() as Atom;
    const wanted = work.pop() as Atom;
    if (wanted.kind === "variable") continue;
    if (wanted instanceof Expression) {
      if (!(held instanceof Expression)) return false;
      if (wanted.items.length !== held.items.length) return false;
      for (let at = wanted.items.length - 1; at >= 0; at -= 1) {
        work.push(wanted.items[at] as Atom, held.items[at] as Atom);
      }
      continue;
    }
    if (wanted !== held) return false;
  }
  return true;
}

/** The strict wire doors, re-exported for a conformance kit. */
export { fromTransport, toTransport };

/** Build a term without asking anything: the mention door, for a head by name. */
export function mention(head: string, ...args: readonly Term[]): Atom {
  return expr(sym(head), ...args.map(toAtom));
}

/** Every distinct variable a pattern binds, in first-seen order. */
export { termVars, rowOf };
