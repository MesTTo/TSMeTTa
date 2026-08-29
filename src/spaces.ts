/**
 * Purpose: space views and combinators, every one of them an ordinary
 *   {@link SpaceProvider}. A live `Map` becomes queryable, two spaces read as
 *   one, a space is handed out read-only, a shape is renamed on the way
 *   through, and a front layer takes every write.
 * Assumes:
 *   - the engine unifies the pattern against whatever a member yields, so a
 *     combinator may over-approximate freely and stay sound. That is what
 *     makes `union` one `yield*` per member rather than a join
 * Guarantees:
 *   - `view` reads the host object AFRESH for every query, so a mutation made
 *     in TypeScript is visible to the next MeTTa query with nothing published
 *     [tested: "reads a live Map through the engine"]
 *   - `union` and `readOnly` implement no write method, so the ENGINE's own
 *     capability refusal answers `add-atom` on them rather than a check
 *     written here [tested: "refuses a write through the engine's own
 *     capability rule"]
 *   - `overlay` reads both layers and writes, removes and clears the FRONT
 *     only, which is `ChainMap`'s own rule. Removing an atom the back holds
 *     leaves it answering, exactly as deleting a key from a ChainMap's first
 *     map leaves the second map's value visible
 *   - `mapped` derives both directions from one declaration, so a rename, a
 *     projection or a legacy-shape adapter is one line rather than a provider
 * Decides: a combinator takes a live `Space` handle or a provider, never a
 *   NAME. A name alone carries no engine, and a combinator that accepted one
 *   would have to guess which engine it meant.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  type Term,
  Sym,
  G,
  expr,
  substitute,
  sym,
  toAtom,
} from "./atom.ts";
import { MettaError } from "./errors.ts";
import { alphaKey, isGround, matchTerms } from "./matching.ts";
import type { SpaceProvider } from "./provider.ts";
import { Space } from "./space.ts";

/** What every combinator accepts as a layer: a live space, or a provider. */
export type Source = Space | SpaceProvider;

/** Anything a provider method may answer, sync or async. */
type Atoms = Iterable<Term> | AsyncIterable<Term>;

/**
 * One layer read uniformly.
 *
 * A live `Space` answers through its own indexed query; a provider answers
 * through its own `match` or, failing that, its enumeration. Combinators
 * compose members, so nothing below cares which kind it holds.
 */
class Member {
  readonly #target: Source;

  constructor(target: Source) {
    if (typeof target === "string") {
      throw new MettaError(
        `a combinator takes a space handle or a provider, not the name ` +
          `${JSON.stringify(target)}; a name alone carries no engine`,
      );
    }
    this.#target = target;
  }

  /** How this member reads in a refusal or a rendering. */
  get label(): string {
    return this.#target instanceof Space ? this.#target.name : "provider";
  }

  atoms(): Atoms {
    const target = this.#target;
    if (target instanceof Space) return target.atoms();
    if (target.atoms === undefined) return [];
    return target.atoms();
  }

  match(pattern: Atom): Atoms {
    const target = this.#target;
    // A space answers ROWS; the atom this member owes its caller is the
    // pattern with that row substituted in, which is the same atom the space
    // matched.
    if (target instanceof Space) {
      return target.match(pattern).map((row) => substitute(pattern, row));
    }
    if (target.match !== undefined) return target.match(pattern);
    return this.atoms();
  }

  add(atom: Atom): void | Promise<void> {
    const target = this.#target;
    if (target instanceof Space) {
      target.add(atom);
      return;
    }
    if (target.add === undefined) {
      throw new MettaError(`${this.label} has no write door`);
    }
    return target.add(atom);
  }

  remove(atom: Atom): boolean | Promise<boolean> {
    const target = this.#target;
    if (target instanceof Space) return target.delete(atom);
    if (target.remove === undefined) return false;
    return target.remove(atom);
  }

  clear(): void | Promise<void> {
    const target = this.#target;
    if (target instanceof Space) {
      target.clear();
      return;
    }
    return target.clear?.();
  }
}

async function* walk(source: Atoms): AsyncGenerator<Atom> {
  if (Symbol.asyncIterator in source) {
    for await (const atom of source as AsyncIterable<Term>) yield toAtom(atom);
    return;
  }
  for (const atom of source as Iterable<Term>) yield toAtom(atom);
}

/**
 * A set of spaces read as ONE, with writes refused by capability.
 *
 * ```ts
 * const all = m.attach("&all", union(kb, rules));
 * await m.eval(Match(all.handle, S.edge(V.a, V.b), V.b));
 * ```
 *
 * Every member's candidates answer, and a duplicate across members answers
 * twice: the multiset reading a union of multisets has, and the same reading
 * two overlapping equations already have one level down. `rdflib`'s
 * `ReadOnlyGraphAggregate` is the same shape for the same reason.
 */
export function union(...sources: readonly Source[]): SpaceProvider {
  if (sources.length === 0) throw new MettaError("a union needs at least one space");
  const members = sources.map((source) => new Member(source));
  return {
    async *atoms(): AsyncGenerator<Atom> {
      for (const member of members) yield* walk(member.atoms());
    },
    async *match(pattern: Atom): AsyncGenerator<Atom> {
      for (const member of members) yield* walk(member.match(pattern));
    },
  };
}

/**
 * The inner space, reads only.
 *
 * There is no write method here at all, so the refusal a write meets is the
 * ENGINE's own standing capability error rather than a check written in
 * TypeScript. That is the one-line spelling for handing a space to code that
 * must not mutate it.
 */
export function readOnly(inner: Source): SpaceProvider {
  const member = new Member(inner);
  return {
    atoms: (): Atoms => member.atoms(),
    match: (pattern: Atom): Atoms => member.match(pattern),
  };
}

/**
 * Both layers read as one; every write lands on the FRONT.
 *
 * `ChainMap`'s own rule, and the form `union` deliberately refuses to be. The
 * back layer is never written, so removing an atom the back holds leaves it
 * answering — exactly as deleting a key from a ChainMap's first map leaves
 * the second map's value visible. Said loudly rather than hidden, because for
 * multisets a silent routing rule would be inventing a placement decision.
 */
export function overlay(front: Source, back: Source): SpaceProvider {
  const head = new Member(front);
  const tail = new Member(back);
  return {
    async *atoms(): AsyncGenerator<Atom> {
      yield* walk(head.atoms());
      yield* walk(tail.atoms());
    },
    async *match(pattern: Atom): AsyncGenerator<Atom> {
      yield* walk(head.match(pattern));
      yield* walk(tail.match(pattern));
    },
    add: (atom: Atom): void | Promise<void> => head.add(atom),
    remove: (atom: Atom): boolean | Promise<boolean> => head.remove(atom),
    clear: (): void | Promise<void> => head.clear(),
  };
}

/**
 * A shape view over any space, from ONE declaration.
 *
 * ```ts
 * const edges = mapped(kb, "(bridge (edge $a $b) (triple $a linked-to $b))");
 * ```
 *
 * presents the inner space's `(triple ...)` atoms as `(edge ...)` atoms, both
 * directions derived from the pattern pair by matching. A rename, a
 * projection or a legacy-shape adapter stops being a custom provider and
 * becomes this one line. Adds map right to left, a removal maps its pattern
 * through, and atoms the declaration does not map are invisible here and
 * untouched there.
 */
export function mapped(inner: Source, declaration: Term): SpaceProvider {
  const parsed = toAtom(declaration);
  if (
    !(parsed instanceof Expression) ||
    parsed.items.length !== 3 ||
    !(parsed.items[0] instanceof Sym) ||
    (parsed.items[0] as Sym).name !== "bridge" ||
    !(parsed.items[1] instanceof Expression) ||
    !(parsed.items[2] instanceof Expression)
  ) {
    throw new MettaError(
      `a mapped declaration is (bridge <outer-shape> <inner-shape>), got ${parsed.text}` +
        (typeof declaration === "string"
          ? "; this module never parses source text, because parsing needs the " +
            "engine and this runs without one — m.parse() it first"
          : ""),
    );
  }
  const outer = parsed.items[1];
  const shape = parsed.items[2];
  const member = new Member(inner);
  const inward = (atom: Atom): Atom | undefined => {
    const bindings = matchTerms(outer, atom);
    return bindings === undefined ? undefined : substitute(shape, bindings);
  };
  const outward = (atom: Atom): Atom | undefined => {
    const bindings = matchTerms(shape, atom);
    return bindings === undefined ? undefined : substitute(outer, bindings);
  };
  return {
    async *atoms(): AsyncGenerator<Atom> {
      for await (const atom of walk(member.atoms())) {
        const shown = outward(atom);
        if (shown !== undefined) yield shown;
      }
    },
    async *match(pattern: Atom): AsyncGenerator<Atom> {
      const inside = inward(pattern);
      if (inside === undefined) {
        // Matching is ONE-WAY, so its failure proves absence only for a
        // GROUND pattern, where one-way and two-way agree. A pattern with
        // variables can still touch instances a one-way walk refuses, such as
        // `(edge $x $x)` against a shape carrying literals, so the sound side
        // is enumeration and the engine's own re-unification keeps the
        // answers right.
        if (!isGround(pattern)) yield* this.atoms?.() as AsyncGenerator<Atom>;
        return;
      }
      for await (const candidate of walk(member.match(inside))) {
        const shown = outward(candidate);
        if (shown !== undefined) yield shown;
      }
    },
    add(atom: Atom): void | Promise<void> {
      const inside = inward(atom);
      if (inside === undefined) {
        throw new MettaError(
          `${atom.text} does not fit this view's shape ${outer.text}; the view ` +
            `admits only atoms the declaration maps`,
        );
      }
      return member.add(inside);
    },
    remove(atom: Atom): boolean | Promise<boolean> {
      const inside = inward(atom);
      if (inside === undefined) return false;
      return member.remove(inside);
    },
  };
}

/**
 * How two spaces differ, as a pair of multiset surpluses.
 *
 * A digest says WHETHER two spaces differ; this says how. A space holding an
 * atom twice against one holding it once differs by the one copy.
 * Alpha-equivalent atoms count as the same atom, and each side's extras come
 * back in that side's own enumeration order. Each side is enumerated exactly
 * once, so a live space is compared at one moment.
 */
export async function diff(
  a: Source,
  b: Source,
): Promise<{ readonly onlyInFirst: readonly Atom[]; readonly onlyInSecond: readonly Atom[] }> {
  const first = await collect(new Member(a).atoms());
  const second = await collect(new Member(b).atoms());
  return { onlyInFirst: surplus(first, second), onlyInSecond: surplus(second, first) };
}

async function collect(source: Atoms): Promise<Atom[]> {
  const held: Atom[] = [];
  for await (const atom of walk(source)) held.push(atom);
  return held;
}

function surplus(these: readonly Atom[], those: readonly Atom[]): Atom[] {
  const remaining = new Map<string, number>();
  for (const atom of those) {
    const key = alphaKey(atom);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const extras: Atom[] = [];
  for (const atom of these) {
    const key = alphaKey(atom);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else extras.push(atom);
  }
  return extras;
}

/** The relation a `view` images a keyed collection through. */
const KV = sym("kv");

/**
 * A live `Map`, `Set`, array or plain object, as a queryable space.
 *
 * A map, an array and a plain object all image as `(kv key value)`; an array's
 * keys are its zero-based indices, so a value-bound query answers every
 * matching index. A `Set` images as its raw members. The object is read AFRESH
 * for every query, so a mutation made in TypeScript is visible to the next
 * MeTTa query with nothing published.
 *
 * ```ts
 * const scores = new Map([["ada", 3]]);
 * const live = m.attach("&scores", view(scores));
 * scores.set("bob", 5);                       // no publication step
 * await live.match(S.kv(V.who, V.n));         // both rows
 * ```
 */
export function view(data: object): SpaceProvider {
  const entries = (): Iterable<readonly [Term, unknown]> => {
    if (data instanceof Map) return [...data.entries()] as [Term, unknown][];
    if (Array.isArray(data)) return data.map((value, index) => [index, value] as const);
    return Object.entries(data).map(([key, value]) => [sym(key), value] as const);
  };
  const keyAtom = (key: Term): Atom => (typeof key === "string" ? sym(key) : toAtom(key));
  if (data instanceof Set) {
    return {
      *atoms(): Generator<Atom> {
        for (const member of data) yield toAtom(member as Term);
      },
      *match(pattern: Atom): Generator<Atom> {
        // A ground probe is one `Set.has`, which is the whole point of
        // pushing the pattern down: the collection's own index answers.
        if (isGround(pattern)) {
          for (const member of data) {
            if (toAtom(member as Term) === pattern) yield pattern;
          }
          return;
        }
        for (const member of data) yield toAtom(member as Term);
      },
      add(atom: Atom): void {
        data.add(hostOf(atom));
      },
      remove(atom: Atom): boolean {
        return data.delete(hostOf(atom));
      },
      clear(): void {
        data.clear();
      },
    };
  }
  return {
    *atoms(): Generator<Atom> {
      for (const [key, value] of entries()) yield expr(KV, keyAtom(key), toAtom(value as Term));
    },
    *match(pattern: Atom): Generator<Atom> {
      if (
        !(pattern instanceof Expression) ||
        pattern.items.length !== 3 ||
        pattern.items[0] !== KV
      ) {
        return;
      }
      for (const [key, value] of entries()) {
        const candidate = expr(KV, keyAtom(key), toAtom(value as Term));
        if (matchTerms(pattern, candidate) !== undefined) yield candidate;
      }
    },
    add(atom: Atom): void {
      const pair = kvOf(atom);
      if (pair === undefined) throw new MettaError(`a view writes (kv key value), not ${atom.text}`);
      const [key, value] = pair;
      if (data instanceof Map) data.set(hostOf(key), hostOf(value));
      else if (Array.isArray(data)) data[Number(hostOf(key))] = hostOf(value);
      else (data as Record<string, unknown>)[String(hostOf(key))] = hostOf(value);
    },
    remove(atom: Atom): boolean {
      const pair = kvOf(atom);
      if (pair === undefined) return false;
      const key = hostOf(pair[0]);
      if (data instanceof Map) return data.delete(key);
      if (Array.isArray(data)) {
        const index = Number(key);
        if (index < 0 || index >= data.length) return false;
        data.splice(index, 1);
        return true;
      }
      return delete (data as Record<string, unknown>)[String(key)];
    },
  };
}

/** The `(kv key value)` pair inside an atom, or nothing. */
function kvOf(atom: Atom): readonly [Atom, Atom] | undefined {
  if (!(atom instanceof Expression) || atom.items.length !== 3 || atom.items[0] !== KV) {
    return undefined;
  }
  return [atom.items[1] as Atom, atom.items[2] as Atom];
}

/** The host value behind an atom: a symbol is its name, a ground value is itself. */
function hostOf(atom: Atom): unknown {
  if (atom instanceof Sym) return atom.name;
  const held = atom as { kind: string; value?: unknown };
  return held.kind === "grounded" ? held.value : atom;
}

/**
 * One live host object presented as `(field <object> <name> <value>)`.
 *
 * Enumeration names the object's own enumerable properties. Adding an atom of
 * the same shape WRITES the property, so a MeTTa program can drive a
 * TypeScript object through `add-atom`. Compose it with stored facts through
 * `union(stored, objectView(obj))` and attach the result like any other
 * provider.
 */
export function objectView(
  target: object,
  options: { readonly relation?: string } = {},
): SpaceProvider {
  const relation = sym(options.relation ?? "field");
  const root = G(target);
  const fieldAtom = (name: string): Atom =>
    expr(relation, root, sym(name), toAtom((target as Record<string, unknown>)[name] as Term));
  const names = (): string[] => Object.keys(target);
  const parts = (atom: Atom): readonly [Atom, Atom, Atom] | undefined => {
    if (!(atom instanceof Expression) || atom.items.length !== 4) return undefined;
    if (atom.items[0] !== relation) return undefined;
    return [atom.items[1] as Atom, atom.items[2] as Atom, atom.items[3] as Atom];
  };
  return {
    *atoms(): Generator<Atom> {
      for (const name of names()) yield fieldAtom(name);
    },
    *match(pattern: Atom): Generator<Atom> {
      const shape = parts(pattern);
      if (shape === undefined) return;
      const [owner, name] = shape;
      if (owner.kind !== "variable" && owner !== root) return;
      const wanted =
        name.kind === "variable" ? names() : name instanceof Sym ? [name.name] : [String(hostOf(name))];
      for (const each of wanted) {
        if (!Object.hasOwn(target, each)) continue;
        const candidate = fieldAtom(each);
        if (matchTerms(pattern, candidate) !== undefined) yield candidate;
      }
    },
    add(atom: Atom): void {
      const shape = parts(atom);
      if (shape === undefined) {
        throw new MettaError(
          `an object view writes (${relation.name} <object> <field> <value>), not ${atom.text}`,
        );
      }
      const [owner, name, value] = shape;
      if (owner !== root) throw new MettaError("an object view writes only the object it presents");
      const field = name instanceof Sym ? name.name : String(hostOf(name));
      (target as Record<string, unknown>)[field] = hostOf(value);
    },
  };
}
