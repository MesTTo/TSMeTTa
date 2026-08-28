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
import { Answers, type AskOptions, type Row } from "./answers.ts";
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
import { MettaError } from "./errors.ts";
import { type Library, useLibrary } from "./library.ts";
import { mettaName } from "./naming.ts";
import { Schema, type SchemaDeclarations } from "./schema.ts";
import { ScopeHandle, Stats, World, nextWorldName } from "./scopes.ts";
import type { Limits } from "./scopes.ts";
import { type Admission, Space, type SpaceOptions, type WatchOptions, answerIterator, hostValue, rowOf } from "./space.ts";
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
    const listed = atomFromWire(event.wire);
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
    const wire = engine.encodeWire(wireFromAtom(term));
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
    const built = toAtom(term);
    const wire = this.#engine.encodeWire(wireFromAtom(built));
    const event = this.#engine.start(["eval", wire, space.name]).sync();
    if (event === null || event.kind !== "answer") {
      throw new MettaError(`${built.text} answered nothing, where one answer was required`, {
        code: "ERR_METTA_ABSENT",
      });
    }
    return atomFromWire(event.wire);
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
    const wire = engine.encodeWire(wireFromAtom(built));
    const name = this.self.name;
    return new Answers<Atom>(
      `speculate(${built.text})`,
      () => answerIterator(engine.start(["eval", wire, name], [["speculate"]])),
      options.signal,
    );
  }

  // --- reflection -----------------------------------------------------------

  /** One atom of MeTTa source, through the engine's own reader. */
  parse(source: string): Atom {
    return atomFromWire(this.#engine.read(source));
  }

  /** The engine's own rendering of an atom, which is the authority on how it spells. */
  text(term: Term): string {
    return this.#engine.text(wireFromAtom(toAtom(term)));
  }

  /** An atom's round trip through the engine: decode it, then encode it back. */
  roundTrip(term: Term): Atom {
    return atomFromWire(this.#engine.roundTrip(wireFromAtom(toAtom(term))));
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
    return String(hostValue(atomFromWire(event.wire))) as EffectClass | "unknown";
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

function groupsOf(event: JobEvent | null): AnswerGroup[] {
  if (event === null || event.kind !== "groups") return [];
  return event.groups.map((group) => ({
    answers: group.map((answer) => atomFromWire(answer.wire)),
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
  if (scope.kind === "variable") return true;
  if (scope instanceof Expression) {
    if (!(atom instanceof Expression)) return false;
    if (scope.items.length !== atom.items.length) return false;
    return scope.items.every((item, index) => matchesShape(item, atom.items[index] as Atom));
  }
  return scope === atom;
}

/** The strict wire doors, re-exported for a conformance kit. */
export { fromTransport, toTransport };

/** Build a term without asking anything: the mention door, for a head by name. */
export function mention(head: string, ...args: readonly Term[]): Atom {
  return expr(sym(head), ...args.map(toAtom));
}

/** Every distinct variable a pattern binds, in first-seen order. */
export { termVars, rowOf };
