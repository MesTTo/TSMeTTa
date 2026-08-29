/**
 * Purpose: a space whose atoms live in TypeScript. A provider answers match,
 *   add, remove and enumeration for a named space whose store is wherever the
 *   provider keeps it: a `Map`, an array, a SQL table, an HTTP service.
 * Assumes:
 *   - the engine unifies the pattern against whatever the provider yields, so
 *     a provider may OVER-approximate its filtering and stay sound. Pushing
 *     the bound parts of a pattern down into the backend is the performance
 *     lever, never a correctness requirement
 *   - the engine's ownership seam is `seam:foreign_*`, published in
 *     `engine/ext_points.pl`, and `bridge.pl` routes it here over the same
 *     trampoline a host operation uses
 * Guarantees:
 *   - capabilities are DERIVED from the methods a provider implements, so a
 *     provider that cannot remove is refused a removal by name rather than
 *     failing silently [tested: "derives its capabilities from its methods"]
 *   - a provider's own refusal sentence reaches the caller, so "implements it
 *     and declines it" reads differently from "does not have it"
 *   - subscribability is NOT derived. A provider declares what its change
 *     events promise through `delivers()`, and one that declares nothing is
 *     refused a subscription naming the missing promise. Deriving it from
 *     `add` and `remove` made a remote space claim events it could not
 *     deliver, and a watcher heard this process's own writes and missed every
 *     other one
 *   - a variable's NAME does not survive the crossing: `$x` arrives as
 *     `$_17902`, because a variable is an identity rather than a spelling and
 *     the engine renames on the way in. Ground atoms are exact in both
 *     directions
 * Decides: a provider's methods may be SYNCHRONOUS or asynchronous. A
 *   synchronous one works on every door; an asynchronous one works wherever
 *   the caller awaits, and refuses on a synchronous door by name, which is the
 *   same rule every host operation here already follows.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, G, type Term, expr, exprOf, sym, toAtom } from "./atom.ts";
import type { Engine } from "./engine.ts";
import { ProviderError } from "./errors.ts";
import { hostValue } from "./space.ts";
import type { Delivery, EventOrder } from "./vocabularies.ts";

/** What a provider can be asked to do, in the engine's own vocabulary. */
export type ProviderCapability =
  | "match"
  | "enumerate"
  | "add"
  | "add-many"
  | "remove"
  | "clear"
  | "subscribe"
  | "bounded"
  | "pushdown"
  | "plan"
  | "rules"
  | "transactional";

/** Every capability the seam names, in the engine's own vocabulary. */
export const CAPABILITIES: readonly ProviderCapability[] = Object.freeze([
  "match",
  "enumerate",
  "add",
  "add-many",
  "remove",
  "clear",
  "subscribe",
  "bounded",
  "pushdown",
  "plan",
  "rules",
  "transactional",
]);

/** What a provider promises about the change events it emits. */
export type DeliveryPromise = readonly [Delivery, EventOrder];

/**
 * The narrow protocols, one per capability.
 *
 * TypeScript spells "implements only this part" by NARROWING the one
 * interface, where Python needs a `Protocol` class each. A function that
 * needs a provider it can enumerate takes an `Enumerable`, and a provider
 * that cannot enumerate does not typecheck at its door rather than failing at
 * its first query.
 */
export type Matcher = Required<Pick<SpaceProvider, "match">>;
/** A provider that can list everything it holds. */
export type Enumerable = Required<Pick<SpaceProvider, "atoms">>;
/** A provider that can be written to. */
export type Adder = Required<Pick<SpaceProvider, "add">>;
/** A provider that can remove one atom. */
export type Remover = Required<Pick<SpaceProvider, "remove">>;
/** A provider that can empty itself. */
export type Clearer = Required<Pick<SpaceProvider, "clear">>;
/** A provider that admits a whole batch in one crossing. */
export type BulkAdder = Required<Pick<SpaceProvider, "addMany">>;
/** A provider whose match takes the caller's bound. */
export type BoundedMatcher = Required<Pick<SpaceProvider, "matchBounded">>;
/** A provider that says how exactly it filters. */
export type MatchClassifier = Required<Pick<SpaceProvider, "pushdown">>;

/** A provider that can claim a whole conjunction. */
export type Planner = Required<Pick<SpaceProvider, "plan">>;
/** A provider that takes part in a transaction. */
export type Transactional = Required<Pick<SpaceProvider, "begin" | "commit" | "rollback">>;
/** A provider that can hand back an immutable capture of itself. */
export type Snapshotter = Required<Pick<SpaceProvider, "snapshot">>;
/** A provider that promises what its change events deliver. */
export type Subscribable = Required<Pick<SpaceProvider, "delivers">>;

/**
 * What a provider took of a conjunction, and the rows it answers for it.
 *
 * `claimed` names the patterns BY POSITION in the list that was offered, which
 * is what makes the partition exact by construction: the engine derives the
 * rest, so a claim cannot drop a conjunct or name a pattern that was never
 * offered. The Python seat, whose provider hands back atoms, has to match them
 * against the wires it sent and detect the failure; here it cannot happen.
 * Positions also tell two occurrences of a repeated pattern apart.
 */
export interface PlanClaim {
  /** Which offered patterns this provider took, by position, in claim order. */
  readonly claimed: readonly number[];
  /** One row per solution: an atom per claimed pattern, in the same order. */
  readonly rows: readonly (readonly Term[])[];
}

/**
 * A space backed by TypeScript. Implement only what the backend has.
 *
 * ```ts
 * const rows = new Map<string, number>();
 * const table: SpaceProvider = {
 *   *atoms() { for (const [k, v] of rows) yield S.kv(k, v); },
 *   add(atom) { ... },
 * };
 * const kb = m.attach("&table", table);
 * for await (const { v } of kb.match(S.kv("ada", V.v))) console.log(String(v));
 * ```
 *
 * A missing method is an unsupported operation, never an assumed one. That is
 * what makes the capability set honest: nothing here guesses.
 */
export interface SpaceProvider {
  /**
   * Candidate atoms for a pattern.
   *
   * The pattern's variables arrive as variable atoms and its bound positions
   * as ground atoms, which is what a backend turns into its own filter: a
   * `WHERE` clause, a mask, an index probe. Yielding EVERY atom is always
   * correct; yielding fewer than match is never allowed to be.
   */
  match?(pattern: Atom): Iterable<Term> | AsyncIterable<Term>;

  /**
   * Every atom this space holds.
   *
   * A provider with this and no `match` is still matchable: enumeration is the
   * correct default candidate set, and the engine unifies.
   */
  atoms?(): Iterable<Term> | AsyncIterable<Term>;

  /** Admit one atom. */
  add?(atom: Atom): void | Promise<void>;

  /** Remove one atom; answer whether one went. */
  remove?(atom: Atom): boolean | Promise<boolean>;

  /**
   * Candidate atoms for a pattern, at most `limit` of them.
   *
   * A bound is ADVISORY, and honouring it is only sound where an exact match
   * is distinguishable from a candidate: truncating an over-approximated
   * candidate list at N drops true answers past the cut. Implement this ONLY
   * if your matching is exact for the patterns you take; a provider without it
   * is never told the number.
   */
  matchBounded?(pattern: Atom, limit: number): Iterable<Term> | AsyncIterable<Term>;

  /**
   * Admit several atoms in ONE crossing.
   *
   * The count is optional and the engine ignores it; a provider that knows how
   * many it took may answer, and a caller reading the provider directly finds
   * it useful.
   */
  addMany?(atoms: readonly Atom[]): void | number | Promise<void | number>;

  /** Remove every atom. */
  clear?(): void | Promise<void>;

  /**
   * How exactly this provider filters for one pattern.
   *
   * `"exact"` means every candidate it yields is a true match, which is what
   * licenses a bound reaching it. `"inexact"` is the safe answer and the
   * default for a provider that does not implement this.
   */
  pushdown?(pattern: Atom): "exact" | "inexact";

  /**
   * A whole conjunction, offered before the engine splits it.
   *
   * Answer nothing to decline, which is what a provider without a join of its
   * own should do. Otherwise answer which of the offered patterns you took,
   * BY POSITION, and one row per solution.
   *
   * This is the seam that makes a backend's own join reachable. Without it
   * every conjunction is split one pattern at a time and re-dispatched per
   * outer row, and a nested-loop plan cannot reach the AGM bound however fast
   * the provider is: for the triangle `R(x,y), S(y,z), T(z,x)` with each
   * relation of size N the bound is N^1.5, and no join plan achieves it
   * [source: Ngo, Re and Rudra, and the worst-case-optimal join literature,
   * cited at engine/ext_points.pl foreign_plan/5].
   *
   * The claim is EXACT, and this is the one place the seam differs from the
   * rest of it. Elsewhere you may over-approximate because the engine
   * re-unifies each candidate, which is cheap; there is no cheap re-check for
   * a join, because the only way to verify a row is to run it. Claiming means
   * answering exactly, and a provider that cannot must decline.
   */
  plan?(patterns: readonly Atom[]): PlanClaim | undefined;

  /**
   * Whether this space's atoms include EQUATIONS.
   *
   * Declared rather than derived, because no protocol can read a promise about
   * content off a method list. In MeTTa it is the difference between a data
   * source and a place a program lives: the provider stores an equation the
   * way it stores any atom and the ENGINE compiles it, so a rule here is the
   * same compiled clause a native one is.
   */
  readonly rules?: boolean;

  /** Begin a transaction this provider takes part in. */
  begin?(): void | Promise<void>;
  /** Commit it. */
  commit?(): void | Promise<void>;
  /** Roll it back. */
  rollback?(): void | Promise<void>;

  /**
   * An immutable capture of everything held, for a reading that must not move.
   *
   * Distinct from `atoms()`: enumeration is LIVE, and a caller that needs a
   * fixed view cannot get one by draining a live source. A provider without
   * this refuses a reification rather than having one mistaken for it.
   */
  snapshot?(): Iterable<Term> | Promise<Iterable<Term>>;

  /**
   * What this space's change events promise, or nothing.
   *
   * `["per-write-exactly", "ordered"]` from the catalog's own words.
   * Registration writes the answer into `&metta` as `(events <space> <delivery>
   * <order>)`, so a MeTTa program reads the same promise the engine acts on.
   *
   * Nothing is the default and it is the safe one: whether a space can emit
   * change events is a promise about the SPACE, not something a method list
   * can derive.
   */
  delivers?(): DeliveryPromise | undefined;

  /**
   * Why this provider says no, in its own words.
   *
   * Return a sentence and it is used verbatim; return nothing and the generic
   * wording applies. A provider that IMPLEMENTS `add` and declines it should
   * not be told it "does not implement add".
   */
  refusal?(capability: ProviderCapability): string | undefined;
}

/** Every capability a provider's own methods say it has. */
export function capabilitiesOf(provider: SpaceProvider): readonly ProviderCapability[] {
  const held: ProviderCapability[] = [];
  if (provider.match !== undefined || provider.atoms !== undefined) held.push("match");
  if (provider.atoms !== undefined) held.push("enumerate");
  if (provider.add !== undefined) held.push("add");
  if (provider.addMany !== undefined) held.push("add-many");
  if (provider.remove !== undefined) held.push("remove");
  if (provider.clear !== undefined) held.push("clear");
  if (provider.matchBounded !== undefined) held.push("bounded");
  if (provider.pushdown !== undefined) held.push("pushdown");
  if (provider.plan !== undefined) held.push("plan");
  // `rules` is DECLARED rather than derived, like `subscribe`: it is a promise
  // about what the space HOLDS -- that its atoms include equations, which in
  // MeTTa is the difference between a data source and a place a program lives
  // -- and no method list can derive a promise about content.
  if (provider.rules === true) held.push("rules");
  if (
    provider.begin !== undefined &&
    provider.commit !== undefined &&
    provider.rollback !== undefined
  ) {
    held.push("transactional");
  }
  // Two questions, both required: the declaration says the space can emit
  // change events at all, and the write protocol says which EDGE it can
  // produce, since a store with no removal never emits one and a watcher for
  // it would wait forever.
  if (
    provider.delivers?.() !== undefined &&
    provider.add !== undefined &&
    provider.remove !== undefined
  ) {
    held.push("subscribe");
  }
  return held;
}

/** The verbs `bridge.pl` sends across, one per seam clause. */
type Verb =
  | "match"
  | "match-bounded"
  | "atoms"
  | "add"
  | "add-many"
  | "remove"
  | "clear"
  | "refuse"
  | "pushdown"
  | "plan"
  | "begin"
  | "commit"
  | "rollback";

/**
 * The providers this engine holds, and the two host operations that serve
 * them.
 *
 * One registry per engine, keyed by the engine name of the space. The two
 * operations are installed on first use and are the ONLY host operations this
 * package registers by itself, which is why they are named with a leading `$`:
 * MeTTa's reader takes a leading `$` as a variable, so no source text can
 * spell either of them.
 */
const registries = new WeakMap<Engine, Map<string, SpaceProvider>>();

function registryOf(engine: Engine): Map<string, SpaceProvider> {
  let held = registries.get(engine);
  if (held !== undefined) return held;
  held = new Map<string, SpaceProvider>();
  registries.set(engine, held);
  install(engine, held);
  return held;
}

function install(engine: Engine, registry: Map<string, SpaceProvider>): void {
  // A `raw_*` operation receives its arguments as ATOMS: the space handle, the
  // verb, then whatever the verb carries. Nothing is unwrapped, because a
  // provider is handed the pattern as the term it is.
  const providerAt = (atom: unknown): SpaceProvider => {
    const name = String(atom);
    const held = registry.get(name);
    if (held === undefined) {
      throw new ProviderError(`the engine asked ${name}, which no provider here backs`);
    }
    return held;
  };
  const verbAt = (atom: unknown): Verb => String(atom) as Verb;

  engine.provide({
    name: "$provider-call",
    arity: 0,
    kind: "raw_det",
    effect: "writesState",
    run: (args: readonly unknown[]): unknown => {
      const provider = providerAt(args[0]);
      const verb = verbAt(args[1]);
      const atom = args[2] as Atom | undefined;
      switch (verb) {
        case "add":
          return callAdd(provider, atom);
        case "add-many":
          return callAddMany(provider, atom);
        case "remove":
          return callRemove(provider, atom);
        case "clear":
          return callClear(provider);
        case "pushdown":
          return provider.pushdown?.(atom as Atom) ?? "inexact";
        case "plan":
          return callPlan(provider, atom);
        case "begin":
          return settled(provider.begin?.());
        case "commit":
          return settled(provider.commit?.());
        case "rollback":
          return settled(provider.rollback?.());
        case "refuse":
          return missing(String(atom) as ProviderCapability, provider);
        default:
          throw new ProviderError(`a provider was asked ${verb}, which is not one of its verbs`);
      }
    },
  });

  engine.provide({
    name: "$provider-stream",
    arity: 0,
    kind: "raw_many",
    effect: "nondeterministicReadOnly",
    run: (args: readonly unknown[]): unknown => {
      const provider = providerAt(args[0]);
      const verb = verbAt(args[1]);
      if (verb === "atoms") return enumerate(provider);
      if (verb === "match") return candidates(provider, args[2] as Atom);
      if (verb === "match-bounded") {
        if (provider.matchBounded === undefined) missing("bounded", provider);
        return provider.matchBounded(args[2] as Atom, Number(String(args[3])));
      }
      throw new ProviderError(`a provider was asked ${verb}, which is not one of its verbs`);
    },
  });
}

function missing(capability: ProviderCapability, provider: SpaceProvider): never {
  const own = provider.refusal?.(capability);
  throw new ProviderError(
    own ?? `this space is backed by a provider that does not implement ${capability}`,
  );
}

/**
 * One planning crossing, as the atom the bridge reads back.
 *
 * `(plan (<index>...) (<row atom>...)...)`, or `False` for a decline. The
 * indices are checked HERE, where the provider that produced them can be
 * named: a duplicate or out-of-range position would otherwise reach the
 * partition as a silently wrong claim.
 */
function callPlan(provider: SpaceProvider, offered: Atom | undefined): unknown {
  if (provider.plan === undefined) missing("plan", provider);
  if (offered === undefined) throw new ProviderError("plan reached a provider with no patterns");
  const patterns = (offered as { items?: readonly Atom[] }).items ?? [offered];
  const claim = provider.plan(patterns);
  if (claim === undefined) return false;
  const seen = new Set<number>();
  for (const at of claim.claimed) {
    if (!Number.isInteger(at) || at < 0 || at >= patterns.length) {
      throw new ProviderError(
        `${label(provider)} claimed position ${String(at)} of ${String(patterns.length)} ` +
          `patterns, which is not one of them`,
      );
    }
    if (seen.has(at)) {
      throw new ProviderError(`${label(provider)} claimed position ${String(at)} twice`);
    }
    seen.add(at);
  }
  for (const row of claim.rows) {
    if (row.length !== claim.claimed.length) {
      throw new ProviderError(
        `${label(provider)} claimed ${String(claim.claimed.length)} patterns and answered a ` +
          `row of ${String(row.length)} atoms; a row carries one atom per claimed pattern`,
      );
    }
  }
  return expr(
    sym("plan"),
    exprOf(claim.claimed.map((at) => G(at))),
    ...claim.rows.map((row) => exprOf(row.map(toAtom))),
  );
}

/** A provider's own name, for a refusal that has to say which one. */
function label(provider: SpaceProvider): string {
  return provider.constructor.name === "Object" ? "this provider" : provider.constructor.name;
}

function callAdd(provider: SpaceProvider, atom: Atom | undefined): unknown {
  if (provider.add === undefined) missing("add", provider);
  if (atom === undefined) throw new ProviderError("add reached a provider with no atom");
  const answered = provider.add(atom);
  return answered instanceof Promise ? answered.then(() => true) : true;
}

/** A void answer as the `true` the det reply reads, awaiting when it must. */
function settled(answered: void | Promise<void>): unknown {
  return answered instanceof Promise ? answered.then(() => true) : true;
}

function callAddMany(provider: SpaceProvider, atoms: Atom | undefined): unknown {
  if (provider.addMany === undefined) missing("add-many", provider);
  if (atoms === undefined) throw new ProviderError("add-many reached a provider with no atoms");
  // The batch arrives as one expression, which is how a list of atoms crosses.
  const items = (atoms as { items?: readonly Atom[] }).items ?? [atoms];
  const answered = provider.addMany(items);
  return answered instanceof Promise ? answered.then(() => true) : true;
}

function callRemove(provider: SpaceProvider, atom: Atom | undefined): unknown {
  if (provider.remove === undefined) missing("remove", provider);
  if (atom === undefined) throw new ProviderError("remove reached a provider with no atom");
  return provider.remove(atom);
}

function callClear(provider: SpaceProvider): unknown {
  if (provider.clear === undefined) missing("clear", provider);
  const answered = provider.clear();
  return answered instanceof Promise ? answered.then(() => true) : true;
}

function enumerate(provider: SpaceProvider): Iterable<Term> | AsyncIterable<Term> {
  if (provider.atoms === undefined) missing("enumerate", provider);
  return provider.atoms();
}

function candidates(
  provider: SpaceProvider,
  pattern: Atom,
): Iterable<Term> | AsyncIterable<Term> {
  if (provider.match !== undefined) return provider.match(pattern);
  if (provider.atoms !== undefined) return provider.atoms();
  return missing("match", provider);
}

/**
 * Back a named space with a TypeScript provider.
 *
 * The engine-side claim comes first, so a name another provider already owns
 * is refused here by name rather than resolving by load order later.
 */
export function registerProvider(
  engine: Engine,
  name: string,
  provider: SpaceProvider,
): readonly ProviderCapability[] {
  const registry = registryOf(engine);
  const capabilities = capabilitiesOf(provider);
  const promise = provider.delivers?.();
  engine
    .start(["provider", name, [...capabilities], promise === undefined ? [] : [...promise]])
    .sync();
  registry.set(name, provider);
  return capabilities;
}

/** Stop backing a space with a provider; the name is free again afterwards. */
export function unregisterProvider(engine: Engine, name: string): void {
  const registry = registryOf(engine);
  engine.start(["unprovider", name]).sync();
  registry.delete(name);
}

/** Whether a space here is backed by a TypeScript provider. */
export function providerOf(engine: Engine, name: string): SpaceProvider | undefined {
  return registries.get(engine)?.get(name);
}

/** Whether a space here is backed by a TypeScript provider at all. */
export function hasProvider(engine: Engine, name: string): boolean {
  return registries.get(engine)?.has(name) === true;
}

/** Every space this engine backs from TypeScript, by name. */
export function providers(engine: Engine): ReadonlyMap<string, SpaceProvider> {
  return new Map(registries.get(engine) ?? []);
}

/**
 * Require a capability of a provider, or refuse in the provider's own words.
 *
 * The door for code that is about to use one: it fails at the CALL, naming
 * what is missing, rather than at whatever the missing method would have done.
 */
export function requireCapability(
  provider: SpaceProvider,
  capability: ProviderCapability,
): void {
  if (capabilitiesOf(provider).includes(capability)) return;
  missing(capability, provider);
}

/**
 * The method a host value implements to own its matching.
 *
 * Hyperon's `CustomMatch`, in this runtime's own vocabulary: a value carrying
 * this method decides for itself what it unifies with, and the engine consults
 * it whenever the value meets a non-variable operand inside `unify`.
 */
export const CUSTOM_MATCH: unique symbol = Symbol("metta.customMatch");

/**
 * A host value that owns its matching.
 *
 * ```ts
 * class Range implements CustomMatch {
 *   constructor(readonly low: number, readonly high: number) {}
 *   *[CUSTOM_MATCH](other: Atom): Iterable<Term> {
 *     const held = hostValue(other);
 *     if (typeof held === "number" && held >= this.low && held <= this.high) yield other;
 *   }
 * }
 * registerCustomMatch(m.engine, Range);
 * ```
 *
 * The method answers every way the value matches what it met, one answer per
 * binding set, and answering nothing means no match. The operand it is given
 * is the atom as the engine holds it, so binding a variable inside it is done
 * by yielding a term that unifies with it.
 */
export interface CustomMatch {
  [CUSTOM_MATCH](other: Atom): Iterable<Term>;
}

const matchers = new WeakMap<Engine, Set<Function>>();

/**
 * Let instances of one class own their matching in this engine.
 *
 * Registration is per CLASS and per engine, and it is what turns the seam on:
 * until the first call the engine's matcher carries no clause for host-owned
 * matching at all, so a program that does not use this pays nothing for it.
 */
export function registerCustomMatch(
  engine: Engine,
  constructor: abstract new (...args: never[]) => unknown,
): void {
  if (!(CUSTOM_MATCH in ((constructor as { prototype?: object }).prototype ?? {}))) {
    throw new ProviderError(
      `${constructor.name} has no [CUSTOM_MATCH]() method, so it cannot own its matching`,
    );
  }
  let held = matchers.get(engine);
  if (held === undefined) {
    held = new Set<Function>();
    matchers.set(engine, held);
    installCustomMatch(engine, held);
  }
  held.add(constructor);
  // Every registration re-enables, because turning the seam on is also what
  // forgets the engine's record of values it decided were not matchable.
  engine.start(["custommatch", true]).sync();
}

/**
 * Stop letting one class own its matching. Answers whether it was registered.
 *
 * Removing the last one turns the seam back off, so an engine that ends with
 * no custom matching is exactly as it started.
 */
export function unregisterCustomMatch(
  engine: Engine,
  constructor: abstract new (...args: never[]) => unknown,
): boolean {
  const held = matchers.get(engine);
  if (held === undefined || !held.delete(constructor)) return false;
  if (held.size === 0) engine.start(["custommatch", false]).sync();
  return true;
}

/** Every class that owns its matching in this engine. */
export function customMatchers(engine: Engine): ReadonlySet<Function> {
  return new Set(matchers.get(engine) ?? []);
}

function installCustomMatch(engine: Engine, registered: ReadonlySet<Function>): void {
  const owning = (atom: unknown): CustomMatch | undefined => {
    const held = hostValue(atom as Atom);
    if (held === null || typeof held !== "object") return undefined;
    const own = (held as { constructor?: Function }).constructor;
    if (own === undefined || !registered.has(own)) return undefined;
    return held as CustomMatch;
  };

  engine.provide({
    name: "$matchable",
    arity: 0,
    kind: "raw_det",
    effect: "pureStructural",
    run: (args: readonly unknown[]): unknown => owning(args[0]) !== undefined,
  });

  engine.provide({
    name: "$custom-match",
    arity: 0,
    kind: "raw_many",
    effect: "nondeterministicReadOnly",
    run: (args: readonly unknown[]): unknown => {
      const owner = owning(args[0]);
      if (owner === undefined) {
        throw new ProviderError("the engine asked a value that does not own its matching");
      }
      return owner[CUSTOM_MATCH](args[1] as Atom);
    },
  });
}
