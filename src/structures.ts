/**
 * Purpose: the atom-keyed collections a program wants before it has an engine:
 *   a set that is blind to variable spelling, a map whose point is "which
 *   entries apply to this atom?", and an index that answers that question
 *   sublinearly over many patterns at once.
 * Assumes:
 *   - the three collections need NO engine. They build and query structure,
 *     and that is why they never parse source text: parsing needs the engine,
 *     so a caller hands them built atoms and `m.parse` is the door for text
 *   - the two VIEWS at the end are different, and say so: a closure and a
 *     computed cache are readings of a space, and both rest on the engine's
 *     own tabling, which is what makes a cyclic closure terminate and a cache
 *     stay correct when its inputs change
 *   - atoms are interned, so a `Map` keyed by an atom is already a structural
 *     map and only the ALPHA and the UNIFICATION questions need machinery
 * Guarantees:
 *   - READING one of these is the platform's own protocol: `PatternMap` IS a
 *     `ReadonlyMap<Atom, V>`, and `AlphaSet` answers every `Set` verb, so
 *     `new Set(alphaSet)`, `Object.fromEntries(patternMap)` and spread all work
 *     [tested: "answers the platform's own collection doors"]
 *   - WRITING to one is wider than the platform's, and deliberately: every
 *     door in this package reads an array in term position as an expression,
 *     so `set.add([S.f, V.x])` is `set.add(S.f(V.x))` here as everywhere. That
 *     is why the mutable interface is not claimed: `Set<Atom>.add` promises to
 *     take an atom and nothing else, and this takes more
 *   - `PatternMap`'s MAPPING protocol stays exact: `get(k)` answers what was
 *     stored under that very key, never a unification. `matching(a)` is the
 *     separate door for the dispatch question
 *   - a ground key costs one `Map` operation, which is the no-tax rule: a
 *     program that never stores a pattern pays nothing for the ones it could
 *     have
 *   - `MatchIndex.matches` answers in REGISTRATION order whatever order the
 *     tree walk reached them in, reads its ordered registration map directly
 *     when no tree walk is possible, and prunes dead trie paths on deletion
 *     [tested: "answers in registration order"; "walks registration order without sorting";
 *     commit=WORKTREE]
 * Decides: `MatchIndex` is an imperfect discrimination tree — the term-indexing
 *   structure automated theorem provers use at millions-of-terms scale. The
 *   tree answers CANDIDATES and `matchTerms` confirms, which is what makes a
 *   nonlinear pattern such as `(f $x $x)` exact rather than approximate
 *   [source: Graf, Term Indexing, LNAI 1053, 1996, chapter 5].
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, Sym, type Term, Var, expr, sym, toAtom, variable } from "./atom.ts";
import {
  alphaCanonical,
  isGround,
  matchTerms,
  unifies,
} from "./matching.ts";
import { MettaError } from "./errors.ts";
import { showsAs } from "./present.ts";
import type { Space } from "./space.ts";

/**
 * A set of atoms that is blind to the SPELLING of variables.
 *
 * `(f $x)` and `(f $y)` are one member, because they are the same pattern said
 * twice. Everything else is the platform's own `Set`, so `has`, `add`,
 * `delete`, `size`, iteration and spreading all mean what they mean.
 *
 * ```ts
 * const seen = new AlphaSet([S.f(V.x)]);
 * seen.has(S.f(V.y));    // true
 * seen.has(S.f(S.a));    // false
 * ```
 */
export class AlphaSet {
  // The canonical atom is the key AND the stored member, so iteration answers
  // one representative per class rather than whichever spelling arrived first.
  // Interning makes the canonical form a shared object, so the map costs one
  // reference per member.
  readonly #members = new Set<Atom>();

  constructor(items: Iterable<Term> = []) {
    for (const item of items) this.add(item as Term);
  }

  /** How many distinct patterns are held, counting alpha-variants as one. */
  get size(): number {
    return this.#members.size;
  }

  add(value: Term): this {
    this.#members.add(alphaCanonical(value));
    return this;
  }

  delete(value: Term): boolean {
    return this.#members.delete(alphaCanonical(value));
  }

  has(value: Term): boolean {
    return this.#members.has(alphaCanonical(value));
  }

  clear(): void {
    this.#members.clear();
  }

  forEach(
    visit: (value: Atom, key: Atom, set: AlphaSet) => void,
    thisArg?: unknown,
  ): void {
    for (const member of this.#members) visit.call(thisArg, member, member, this);
  }

  keys(): SetIterator<Atom> {
    return this.#members.keys();
  }

  values(): SetIterator<Atom> {
    return this.#members.values();
  }

  entries(): SetIterator<[Atom, Atom]> {
    return this.#members.entries();
  }

  [Symbol.iterator](): SetIterator<Atom> {
    return this.#members[Symbol.iterator]();
  }

  /** The members as a plain `Set`, for a caller that needs the platform's own. */
  toSet(): Set<Atom> {
    return new Set(this.#members);
  }

  // --- the ES2025 set composition family ------------------------------------
  //
  // Each one answers an AlphaSet rather than a plain Set, because a result that
  // was blind to variable spelling on the way in and exact on the way out would
  // be a trap: `a.union(b).has(S.f(V.y))` must read the same as `a.has(...)`.
  // That is also why the class does not DECLARE `Set<Atom>`: the platform's own
  // `union` answers `Set<T | U>`, which no class preserving this invariant can
  // return, and claiming an interface it cannot satisfy would be the lie.

  /** Every member of either set. */
  union<U>(other: ReadonlySetLike<U>): AlphaSet {
    const joined = new AlphaSet(this);
    for (const value of iterate(other)) joined.add(value as Term);
    return joined;
  }

  /** The members this set and `other` share. */
  intersection<U>(other: ReadonlySetLike<U>): AlphaSet {
    const shared = new AlphaSet();
    for (const value of iterate(other)) {
      if (this.has(value as Term)) shared.add(value as Term);
    }
    return shared;
  }

  /** The members of this set that `other` does not hold. */
  difference<U>(other: ReadonlySetLike<U>): AlphaSet {
    const rest = new AlphaSet(this);
    for (const value of iterate(other)) rest.delete(value as Term);
    return rest;
  }

  /** The members exactly one of the two sets holds. */
  symmetricDifference<U>(other: ReadonlySetLike<U>): AlphaSet {
    const either = new AlphaSet(this);
    for (const value of iterate(other)) {
      if (this.has(value as Term)) either.delete(value as Term);
      else either.add(value as Term);
    }
    return either;
  }

  /** Whether `other` holds every member of this set. */
  isSubsetOf<U>(other: ReadonlySetLike<U>): boolean {
    const theirs = new AlphaSet(iterate(other) as Iterable<Term>);
    for (const member of this) {
      if (!theirs.has(member)) return false;
    }
    return true;
  }

  /** Whether this set holds every member of `other`. */
  isSupersetOf<U>(other: ReadonlySetLike<U>): boolean {
    for (const value of iterate(other)) {
      if (!this.has(value as Term)) return false;
    }
    return true;
  }

  /** Whether the two sets share no member. */
  isDisjointFrom<U>(other: ReadonlySetLike<U>): boolean {
    for (const value of iterate(other)) {
      if (this.has(value as Term)) return false;
    }
    return true;
  }

  get [Symbol.toStringTag](): string {
    return "AlphaSet";
  }
}

/**
 * The members of a set-like, whatever shape it arrived in.
 *
 * The ES2025 set methods take a `ReadonlySetLike`, which promises `size`, `has`
 * and `keys` and NOT iterability, so the members are read through `keys()` as
 * the specification says rather than through `Symbol.iterator`.
 */
function* iterate<U>(other: ReadonlySetLike<U>): Generator<U> {
  const keys = other.keys();
  for (;;) {
    const step = keys.next();
    if (step.done === true) return;
    yield step.value;
  }
}

showsAs(AlphaSet.prototype, (set: AlphaSet) => `AlphaSet(${String(set.size)})`);

/** The bucket a pattern key lands in: its head name and arity, or the any-bucket. */
type Bucket = string;

const ANY_BUCKET: Bucket = "*";

function bucketOf(key: Atom): Bucket {
  if (key instanceof Expression && key.items.length > 0) {
    const head = key.items[0];
    const name = head instanceof Sym ? head.name : "";
    return `${name}/${String(key.items.length)}`;
  }
  return ANY_BUCKET;
}

/** Every bucket a GROUND probe could touch, most specific first. */
function* probeBuckets(probe: Atom): Generator<Bucket> {
  if (probe instanceof Expression && probe.items.length > 0) {
    const head = probe.items[0];
    if (head instanceof Sym) yield `${head.name}/${String(probe.items.length)}`;
    yield `/${String(probe.items.length)}`;
  }
  yield ANY_BUCKET;
}

/**
 * A `Map` keyed by atoms whose real question is "which entries apply here?".
 *
 * Ground keys hash exactly, which is the no-tax rule: `set`, `get` and `delete`
 * on a ground key are one `Map` operation. A key carrying variables is a
 * PATTERN, lands in a head-and-arity bucket, and `matching(atom)` probes only
 * the buckets an atom could touch.
 *
 * ```ts
 * const routes = new PatternMap<Handler>();
 * routes.set(S.route(S.home), home);          // ground: Map speed
 * routes.set(S.route(V.anything), fallback);  // pattern: bucketed
 * for (const [key, handler] of routes.matching(S.route(S.home))) handler();
 * ```
 *
 * The mapping protocol stays EXACT. `get(S.route(V.x))` answers what was stored
 * under that pattern, alpha-equal, and never a unification; the dispatch
 * question has its own door so the two can never be confused.
 */
export class PatternMap<V> implements ReadonlyMap<Atom, V> {
  readonly #ground = new Map<Atom, V>();
  // Keyed by the alpha-canonical form, so two spellings of one pattern are one
  // entry; the stored key is the spelling that was written, because that is
  // what a caller reading an entry back expects to see.
  readonly #patterns = new Map<Atom, [Atom, V]>();
  readonly #buckets = new Map<Bucket, Set<Atom>>();

  constructor(entries: Iterable<readonly [Term, V]> = []) {
    for (const [key, value] of entries) this.set(key, value);
  }

  /** How many entries are held, ground and pattern together. */
  get size(): number {
    return this.#ground.size + this.#patterns.size;
  }

  set(key: Term, value: V): this {
    const atom = toAtom(key);
    if (isGround(atom)) {
      this.#ground.set(atom, value);
      return this;
    }
    const canonical = alphaCanonical(atom);
    if (!this.#patterns.has(canonical)) {
      const bucket = bucketOf(canonical);
      const held = this.#buckets.get(bucket);
      if (held === undefined) this.#buckets.set(bucket, new Set([canonical]));
      else held.add(canonical);
    }
    this.#patterns.set(canonical, [atom, value]);
    return this;
  }

  get(key: Term): V | undefined {
    const atom = toAtom(key);
    if (isGround(atom)) return this.#ground.get(atom);
    return this.#patterns.get(alphaCanonical(atom))?.[1];
  }

  has(key: Term): boolean {
    const atom = toAtom(key);
    return isGround(atom)
      ? this.#ground.has(atom)
      : this.#patterns.has(alphaCanonical(atom));
  }

  delete(key: Term): boolean {
    const atom = toAtom(key);
    if (isGround(atom)) return this.#ground.delete(atom);
    const canonical = alphaCanonical(atom);
    if (!this.#patterns.delete(canonical)) return false;
    this.#buckets.get(bucketOf(canonical))?.delete(canonical);
    return true;
  }

  clear(): void {
    this.#ground.clear();
    this.#patterns.clear();
    this.#buckets.clear();
  }

  /** The value under `key`, inserting `value` first when there is none. */
  getOrInsert(key: Term, value: V): V {
    const held = this.get(key);
    if (held !== undefined || this.has(key)) return held as V;
    this.set(key, value);
    return value;
  }

  /** The value under `key`, computing and inserting one when there is none. */
  getOrInsertComputed(key: Term, compute: (key: Atom) => V): V {
    const held = this.get(key);
    if (held !== undefined || this.has(key)) return held as V;
    const made = compute(toAtom(key));
    this.set(key, made);
    return made;
  }

  /**
   * Every entry whose KEY unifies with this atom: the dispatch question.
   *
   * A ground probe costs one `Map` hit plus the buckets its head and arity
   * could touch. A probe carrying variables consults every entry, because a
   * variable probe can reach any bucket, and that is the honest spelling of
   * "no index helps here".
   */
  *matching(atom: Term): Generator<[Atom, V]> {
    const probe = toAtom(atom);
    if (isGround(probe)) {
      const exact = this.#ground.get(probe);
      if (exact !== undefined || this.#ground.has(probe)) yield [probe, exact as V];
      const candidates = new Set<Atom>();
      for (const bucket of probeBuckets(probe)) {
        for (const canonical of this.#buckets.get(bucket) ?? []) candidates.add(canonical);
      }
      for (const canonical of candidates) {
        const entry = this.#patterns.get(canonical);
        if (entry === undefined) continue;
        if (matchTerms(entry[0], probe) !== undefined) yield [entry[0], entry[1]];
      }
      return;
    }
    for (const [key, value] of this.#ground) {
      if (matchTerms(probe, key) !== undefined) yield [key, value];
    }
    for (const [stored, value] of this.#patterns.values()) {
      if (unifies(stored, probe)) yield [stored, value];
    }
  }

  *entries(): MapIterator<[Atom, V]> {
    yield* this.#ground.entries();
    for (const entry of this.#patterns.values()) yield [entry[0], entry[1]];
  }

  *keys(): MapIterator<Atom> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(
    visit: (value: V, key: Atom, map: ReadonlyMap<Atom, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.entries()) visit.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[Atom, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "PatternMap";
  }
}

showsAs(
  PatternMap.prototype,
  (map: PatternMap<unknown>) => `PatternMap(${String(map.size)})`,
);

/**
 * One token of a term's preorder walk. A variable is one SKIP token, whatever
 * it would bind, which is what makes a variable edge in the tree.
 */
type Token = string;

const SKIP: Token = "*";

/**
 * The preorder token path of a term.
 *
 * An open token carries the arity, so the skip table can compute where a whole
 * subterm ends without re-walking it. A number's token is its numeric value
 * rather than its MeTTa spelling, because the kernel compares numbers by value
 * and `0` and `0.0` must reach one edge.
 */
function tokens(atom: Atom): Token[] {
  const out: Token[] = [];
  const stack: Atom[] = [atom];
  while (stack.length > 0) {
    const node = stack.pop() as Atom;
    if (node instanceof Var) {
      out.push(SKIP);
      continue;
    }
    if (node instanceof Expression) {
      out.push(`(${String(node.items.length)}`);
      for (let i = node.items.length - 1; i >= 0; i -= 1) stack.push(node.items[i] as Atom);
      continue;
    }
    if (node instanceof Sym) {
      out.push(`s:${node.name}`);
      continue;
    }
    const value = (node as { value?: unknown }).value;
    if (typeof value === "number" || typeof value === "bigint") {
      out.push(`n:${String(Number(value))}`);
      continue;
    }
    // Everything else is identified by the atom itself, which interning has
    // already made one object per distinct value.
    out.push(`a:${String(node.id)}`);
  }
  return out;
}

/** For each position, where the whole subterm starting there ends. */
function skipTable(path: readonly Token[]): number[] {
  const skips = new Array<number>(path.length).fill(0);
  for (let at = path.length - 1; at >= 0; at -= 1) {
    const token = path[at] as Token;
    if (token.startsWith("(")) {
      let landing = at + 1;
      const arity = Number(token.slice(1));
      for (let i = 0; i < arity; i += 1) landing = skips[landing] as number;
      skips[at] = landing;
    } else {
      skips[at] = at + 1;
    }
  }
  return skips;
}

interface TreeNode {
  readonly edges: Map<Token, TreeNode>;
  readonly leaves: number[];
}

function emptyNode(): TreeNode {
  return { edges: new Map(), leaves: [] };
}

/**
 * Many registered patterns, one incoming atom, "which patterns match it?"
 * answered sublinearly.
 *
 * The shape behind pub/sub topic matching, rule dispatch, feature targeting and
 * webhook routing. Each pattern flattens to a preorder token path with
 * variables as skip edges; retrieval walks the probe's own tokens following
 * exact and skip edges at once; and every candidate is confirmed with
 * `matchTerms`, so a nonlinear pattern such as `(f $x $x)` is exact.
 *
 * ```ts
 * const inbox = new MatchIndex<Handler>();
 * inbox.add(S.order(V.id, S.express), rush);
 * for (const [pattern, handler] of inbox.matches(S.order(7, S.express))) handler();
 * ```
 */
export class MatchIndex<V = undefined> {
  #root: TreeNode = emptyNode();
  // Keyed by a counter that only goes UP, which makes the key both unique and
  // the registration order. A live count would go back down on a removal, so a
  // later registration would take a number a survivor still holds and the two
  // would sort by whichever the tree walk reached first.
  readonly #entries = new Map<number, [Atom, V]>();
  #next = 0;
  #size = 0;

  /** How many registrations are held. */
  get size(): number {
    return this.#size;
  }

  /** Register a pattern with a value: a handler, a topic, an id. */
  add(pattern: Term, value: V): this {
    const atom = toAtom(pattern);
    let node = this.#root;
    for (const token of tokens(atom)) {
      let step = node.edges.get(token);
      if (step === undefined) {
        step = emptyNode();
        node.edges.set(token, step);
      }
      node = step;
    }
    const id = this.#next;
    this.#next += 1;
    node.leaves.push(id);
    this.#entries.set(id, [atom, value]);
    this.#size += 1;
    return this;
  }

  /**
   * Remove one registration of exactly this pattern and value.
   *
   * Answers whether one existed, which is what `Set.prototype.delete` and
   * `Map.prototype.delete` both answer.
   */
  delete(pattern: Term, value: V): boolean {
    const atom = toAtom(pattern);
    let node = this.#root;
    const trail: { readonly parent: TreeNode; readonly token: Token; readonly child: TreeNode }[] = [];
    for (const token of tokens(atom)) {
      const child: TreeNode | undefined = node.edges.get(token);
      if (child === undefined) return false;
      trail.push({ parent: node, token, child });
      node = child;
    }
    for (let at = 0; at < node.leaves.length; at += 1) {
      const id = node.leaves[at] as number;
      const held = this.#entries.get(id);
      if (held === undefined) continue;
      if (held[0] !== atom || held[1] !== value) continue;
      node.leaves.splice(at, 1);
      this.#entries.delete(id);
      this.#size -= 1;
      for (let step = trail.length - 1; step >= 0; step -= 1) {
        const { parent, token, child } = trail[step] as (typeof trail)[number];
        if (child.leaves.length > 0 || child.edges.size > 0) break;
        parent.edges.delete(token);
      }
      return true;
    }
    return false;
  }

  /** Forget every registration. */
  clear(): void {
    this.#root = emptyNode();
    this.#entries.clear();
    this.#size = 0;
  }

  /**
   * Every registered pattern that matches this atom, in registration order.
   *
   * The tree answers candidates and `matchTerms` confirms. A probe that itself
   * carries variables cannot be walked literally — every edge would have to be
   * followed — so it falls back to consulting each entry, which is the honest
   * spelling of "no index helps here" and stays exact through `unifies`.
   */
  *matches(atom: Term): Generator<[Atom, V]> {
    const probe = toAtom(atom);
    if (!isGround(probe)) {
      for (const entry of this.#entries.values()) {
        if (unifies(entry[0], probe)) yield entry;
      }
      return;
    }
    const path = tokens(probe);
    const skips = skipTable(path);
    const found: [number, [Atom, V]][] = [];
    const stack: [TreeNode, number][] = [[this.#root, 0]];
    while (stack.length > 0) {
      const [node, position] = stack.pop() as [TreeNode, number];
      if (position === path.length) {
        for (const id of node.leaves) {
          const entry = this.#entries.get(id);
          if (entry !== undefined && matchTerms(entry[0], probe) !== undefined) {
            found.push([id, entry]);
          }
        }
        continue;
      }
      const exact = node.edges.get(path[position] as Token);
      if (exact !== undefined) stack.push([exact, position + 1]);
      const starred = node.edges.get(SKIP);
      if (starred !== undefined) stack.push([starred, skips[position] as number]);
    }
    found.sort((a, b) => a[0] - b[0]);
    for (const [, entry] of found) yield entry;
  }

  /** Every registration, in registration order. */
  *entries(): Generator<[Atom, V]> {
    yield* this.#entries.values();
  }

  [Symbol.iterator](): Generator<[Atom, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "MatchIndex";
  }
}

showsAs(
  MatchIndex.prototype,
  (index: MatchIndex<unknown>) => `MatchIndex(${String(index.size)} patterns)`,
);

// ---------------------------------------------------------------------------
// The two views. Unlike the collections above, these read a SPACE.

/** What a view needs of the surface, structurally, so there is no cycle. */
interface ViewHost {
  run(source: string): { readonly texts: readonly string[] }[];
}

/** Import the tabling library, idempotently: a view's dependency is its setup. */
function tablingReady(surface: ViewHost): void {
  surface.run("!(import! &self (library lib_tabling))");
}

function accepted(surface: ViewHost, source: string, what: string): void {
  const answered = surface.run(`!(${source})`);
  const verdict = answered[0]?.texts[0];
  if (verdict !== "true" && verdict !== "True") {
    throw new MettaError(`${what} was not accepted: ${JSON.stringify(answered[0]?.texts ?? [])}`);
  }
}

/**
 * Reachability over a stored relation: dependencies, hierarchies, ancestry.
 *
 * ```ts
 * const deps = await ClosureView.open(m, kb, "imports");
 * await deps.holds(S.app, S.libc);
 * await deps.reachable(S.app);
 * ```
 *
 * The closure is a pair of MeTTa equations over the relation's own atoms,
 * TABLED from birth. Tabling is not an optimisation here: it is what makes a
 * cyclic or symmetric closure terminate at all, and what keeps the answers
 * fresh when the relation's atoms change, because the space is read by its
 * literal name and the engine invalidates on writes.
 *
 * Nodes are ATOMS rather than names. A JavaScript string is a MeTTa String and
 * not the symbol of the same spelling, so `reachable("app")` answers nothing
 * where `reachable(S.app)` answers the closure. The relation NAME is a string,
 * because it names a function rather than an atom.
 */
export class ClosureView {
  readonly #space: Space;
  readonly #relation: string;
  readonly #head: string;

  /** @internal Use {@link ClosureView.open}. */
  constructor(space: Space, relation: string, head: string) {
    this.#space = space;
    this.#relation = relation;
    this.#head = head;
  }

  /**
   * Declare the closure over one relation and answer the view.
   *
   * `symmetric` adds the reversed base case, which is the undirected reading;
   * without tabling that spelling never terminates, which is why this always
   * tables.
   */
  static async open(
    surface: ViewHost,
    space: Space,
    relation: string,
    options: { readonly symmetric?: boolean } = {},
  ): Promise<ClosureView> {
    tablingReady(surface);
    const step = `${relation}-step`;
    const head = `${relation}-closure`;
    const name = space.name;
    surface.run(`(= (${step} $x $y) (match ${name} (${relation} $x $y) $y))`);
    if (options.symmetric === true) {
      surface.run(`(= (${step} $x $y) (match ${name} (${relation} $y $x) $y))`);
    }
    surface.run(`(= (${head} $x $y) (${step} $x $y))`);
    surface.run(`(= (${head} $x $z) (let $y (${step} $x $y) (${head} $y $z)))`);
    for (const declared of [step, head]) {
      accepted(surface, `tabled (${declared} $a $b)`, `tabling (${declared} ...)`);
    }
    await Promise.resolve();
    return new ClosureView(space, relation, head);
  }

  /** Whether one node reaches another. */
  async holds(from: Term, to: Term): Promise<boolean> {
    return (await this.#space.eval(expr(sym(this.#head), toAtom(from), toAtom(to))).find()) !== undefined;
  }

  /**
   * Every node reachable from one, as a set.
   *
   * A set rather than a list, because the closure is a RELATION: a node
   * reachable two ways is reachable, and the second answer is multiplicity
   * rather than data.
   */
  async reachable(from: Term): Promise<Set<Atom>> {
    const answers = await this.#space
      .eval(expr(sym(this.#head), toAtom(from), variable("_reach")))
      .toArray();
    return new Set(answers);
  }

  toString(): string {
    return `ClosureView(${this.#relation} on ${this.#space.name})`;
  }
}

showsAs(ClosureView.prototype, (view: ClosureView) => view.toString());

/** What the engine's own tables report about one function. */
export interface TableStats {
  readonly tables: number;
  readonly answers: number;
  readonly completeCall: number;
  readonly invalidated: number;
  readonly reevaluated: number;
}

/**
 * A computed cache that stays correct: a read-only view of a TABLED function.
 *
 * ```ts
 * const distances = await TabledMap.open(m, kb, "distance", { arity: 2 });
 * await distances.get(S.a, S.b);      // computed once, then read from the table
 * await distances.stats();            // the engine's own counters
 * ```
 *
 * The cache is the ENGINE's, not a `Map` kept beside it, and that is the whole
 * point: the engine invalidates a table when the atoms it was computed from
 * change, so the answer is never stale. A host-side memo would have to be told.
 */
export class TabledMap {
  readonly #space: Space;
  readonly #name: string;
  readonly #arity: number;
  readonly #pattern: Atom;

  /** @internal Use {@link TabledMap.open}. */
  constructor(space: Space, name: string, arity: number, pattern: Atom) {
    this.#space = space;
    this.#name = name;
    this.#arity = arity;
    this.#pattern = pattern;
  }

  /** Declare the function tabled and answer the view over it. */
  static async open(
    surface: ViewHost,
    space: Space,
    name: string,
    options: { readonly arity: number },
  ): Promise<TabledMap> {
    tablingReady(surface);
    const holes = Array.from({ length: options.arity }, (_, at) => variable(`x${String(at)}`));
    const pattern = expr(sym(name), ...holes);
    accepted(surface, `tabled ${pattern.text}`, `tabling ${pattern.text}`);
    await Promise.resolve();
    return new TabledMap(space, name, options.arity, pattern);
  }

  #call(key: readonly Term[]): Atom {
    if (key.length !== this.#arity) {
      throw new MettaError(
        `${this.#name} takes ${String(this.#arity)} argument(s), got ${String(key.length)}`,
      );
    }
    return expr(sym(this.#name), ...key.map(toAtom));
  }

  /** The value for one key, or undefined when the function answers nothing. */
  async get(...key: readonly Term[]): Promise<Atom | undefined> {
    return this.#space.eval(this.#call(key)).find();
  }

  /** Whether the function answers for one key at all. */
  async has(...key: readonly Term[]): Promise<boolean> {
    return (await this.get(...key)) !== undefined;
  }

  /**
   * The engine's own counters for this function's tables.
   *
   * `invalidated` above `reevaluated` is the engine deciding a table is not
   * worth rebuilding yet; both moving is the freshness machinery working.
   */
  async stats(): Promise<TableStats> {
    const answered = await this.#space.eval(expr(sym("table-stats"), this.#pattern)).find();
    const report: Record<string, number> = {};
    if (answered instanceof Expression) {
      for (const pair of answered.items) {
        if (!(pair instanceof Expression) || pair.items.length !== 2) continue;
        report[String(pair.items[0])] = Number(String(pair.items[1]));
      }
    }
    return {
      tables: report["tables"] ?? 0,
      answers: report["answers"] ?? 0,
      completeCall: report["complete-call"] ?? 0,
      invalidated: report["invalidated"] ?? 0,
      reevaluated: report["reevaluated"] ?? 0,
    };
  }

  /** Drop this function's tables; the next read recomputes. */
  clear(surface: ViewHost): void {
    surface.run(`!(table-clear ${this.#pattern.text})`);
  }

  toString(): string {
    return `TabledMap(${this.#name}/${String(this.#arity)} on ${this.#space.name})`;
  }
}

showsAs(TabledMap.prototype, (view: TabledMap) => view.toString());
