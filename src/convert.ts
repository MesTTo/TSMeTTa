/**
 * Purpose: the two-way projection between a host value and an atom, and the
 *   registry that teaches it one type at a time.
 * Assumes:
 *   - a value crosses into the engine by REFERENCE unless something says how
 *     it should cross by SHAPE. `G(person)` is the reference; this is the
 *     other door, for a program that wants `(Person "Ada" 36)` in the space
 * Guarantees:
 *   - `build(project(value))` reconstructs an equal value for every registered
 *     type, which is the only property a projection has to have
 *     [tested: "round-trips every registered type"]
 *   - a registration can be REMOVED without leaving the constructor or its
 *     name owned, so a test that registers cleans up completely
 *     [tested: "a registration can be removed and its name reclaimed"]
 *   - projection recurses: a registered type whose fields hold registered
 *     types projects all the way down, and arrays and plain objects project
 *     structurally without being registered at all
 * Decides: a class may carry its OWN projection rather than register one. A
 *   `[TO_ATOM]()` method and a static `[FROM_ATOM]()` are consulted first, so
 *   a type you own needs no registration and no import from this module.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  G,
  Grounded,
  Sym,
  type Term,
  expr,
  exprOf,
  lift,
  sym,
  toAtom,
} from "./atom.ts";
import { MettaError, NameError } from "./errors.ts";
import { hostValue } from "./space.ts";
import { RegistryImage } from "./vocabularies.ts";

/** The method a class implements to say how it projects. */
export const TO_ATOM: unique symbol = Symbol("metta.toAtom");

/** The static method a class implements to say how it is rebuilt. */
export const FROM_ATOM: unique symbol = Symbol("metta.fromAtom");

/** A class that projects itself. */
export interface SelfProjecting {
  [TO_ATOM](): Term;
}

/**
 * The four ways a host type can cross. A registration picks exactly one.
 *
 * The vocabulary is CLOSED and it is the ENGINE'S: `registry-image` is one of
 * the tables `vocabularies.ts` generates from a booted engine, so the four
 * words here cannot drift from the four the engine knows.
 */
export const IMAGES: readonly Image[] = Object.freeze(Object.values(RegistryImage));

/** Which of the four a type crosses under. */
export type Image = RegistryImage;

/** Whether a value crosses by shape or by reference, decided in O(1). */
export type Transparency = "transparent" | "opaque";

/** How one registered type crosses, in both directions. */
export interface Projection<T> {
  /** The constructor name the projected expression carries. */
  readonly name: string;
  /** The children, each projected recursively. */
  readonly toAtom: (value: T) => readonly Term[];
  /**
   * Rebuild the value from those children, already built back.
   *
   * `undefined` means this registration does not claim what it was offered,
   * which only the `symbol` image asks: a bare name carries no constructor to
   * look up, so every symbol registration is offered the name in turn and the
   * first that claims it wins.
   */
  readonly fromAtom: (...children: never[]) => T | undefined;
  /**
   * Which image it crosses under. `expression` by default, the shaped form.
   *
   * `symbol` crosses as the bare name its first child renders to, which is
   * how an enum member wants to read; `handle` and `operations` cross by
   * reference, the second saying additionally that the object's methods are
   * meant to become operations through `integrate.objectOps`.
   */
  readonly image?: Image;
}

/**
 * One registration, with its type parameter erased.
 *
 * The registry holds many types at once, so the entry cannot carry one, and
 * `unknown` is the honest erasure: the two functions are checked at the
 * registration door, where the type IS known.
 */
interface Registered {
  readonly constructor: Function;
  readonly projection: Projection<unknown>;
}

const byConstructor = new Map<Function, Registered>();
const byName = new Map<string, Registered>();
// Symbol-image registrations, in registration order. A bare symbol carries no
// constructor name to look up, so the reverse direction OFFERS the name to
// each in turn and the first that claims it wins. Kept separate so a program
// with no symbol registration pays one empty-array check.
const bySymbol: Registered[] = [];

/**
 * Teach the projection one type.
 *
 * ```ts
 * class Person {
 *   name: string;
 *   age: number;
 *   constructor(name: string, age: number) { this.name = name; this.age = age; }
 * }
 * registerType(Person, {
 *   name: "Person",
 *   toAtom: (person) => [person.name, person.age],
 *   fromAtom: (name: string, age: number) => new Person(name, age),
 * });
 * project(new Person("Ada", 36));     // (Person "Ada" 36)
 * ```
 *
 * `toAtom` answers the CHILDREN and `fromAtom` rebuilds from them, which is
 * what makes the pair a projection rather than two unrelated functions: the
 * reverse is yours to define, per type, and `build` consults it whenever the
 * constructor name matches.
 */
export function registerType<T>(
  constructor: abstract new (...args: never[]) => T,
  projection: Projection<T>,
): void {
  const held = byName.get(projection.name);
  if (held !== undefined && held.constructor !== constructor) {
    throw new NameError(
      `the constructor name ${projection.name} is already registered for ` +
        `${held.constructor.name}; unregister it first`,
    );
  }
  if (projection.image !== undefined && !IMAGES.includes(projection.image)) {
    throw new MettaError(
      `image must be one of ${IMAGES.join(", ")}, not ${String(projection.image)}`,
    );
  }
  const entry = { constructor, projection: projection as unknown as Projection<unknown> };
  byConstructor.set(constructor, entry);
  byName.set(projection.name, entry);
  if (projection.image === "symbol") bySymbol.push(entry);
}

/** Forget a registration, name and all. Answers whether one was there. */
export function unregisterType(constructor: abstract new (...args: never[]) => unknown): boolean {
  const held = byConstructor.get(constructor);
  if (held === undefined) return false;
  byConstructor.delete(constructor);
  byName.delete(held.projection.name);
  const at = bySymbol.indexOf(held);
  if (at >= 0) bySymbol.splice(at, 1);
  return true;
}

/** Every registered constructor name, in registration order. */
export function declarations(): readonly string[] {
  return [...byName.keys()];
}

/** Whether a value's own type is registered, or projects itself. */
export function isProjectable(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (TO_ATOM in (value as object)) return true;
  const own = (value as { constructor?: Function }).constructor;
  return own !== undefined && byConstructor.has(own);
}

/** What a class projects through, once resolved. */
export interface Registration {
  /** The constructor name its atoms carry. */
  readonly name: string;
  /** Which of the four images it crosses under. */
  readonly image: Image;
  /**
   * Whether a caller registered it, as against a default recorded here.
   *
   * The distinction matters at the operation-result door: only an EXPLICIT
   * registration projects a returned value by shape, so registering a type
   * somewhere never silently changes what an operation returning it answers.
   */
  readonly explicit: boolean;
}

// Defaults resolved for a self-projecting class, recorded on first ask so the
// second is a map hit rather than a second walk of the prototype chain.
const defaults = new Map<Function, Registration>();

/**
 * The registration a class projects through, defaults recorded.
 *
 * A registered class answers its registration; a class carrying `[TO_ATOM]`
 * answers the default recorded for it, exactly as a first projection would
 * have; anything else refuses and names the two doors that would fix it.
 */
export function ensureRegistered(
  constructor: abstract new (...args: never[]) => unknown,
): Registration {
  const held = byConstructor.get(constructor);
  if (held !== undefined) {
    return {
      name: held.projection.name,
      image: held.projection.image ?? "expression",
      explicit: true,
    };
  }
  const recorded = defaults.get(constructor);
  if (recorded !== undefined) return recorded;
  const prototype = (constructor as { prototype?: object }).prototype;
  if (prototype !== undefined && prototype !== null && TO_ATOM in prototype) {
    const made: Registration = { name: constructor.name, image: "expression", explicit: false };
    defaults.set(constructor, made);
    return made;
  }
  throw new MettaError(
    `${constructor.name} has no image: it is not registered and carries no ` +
      `[TO_ATOM]() method; teach the translator with registerType(...)`,
  );
}

/** Which image a value's own type crosses under, or undefined for an untaught one. */
export function imageOf(value: unknown): Image | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const own = (value as { constructor?: Function }).constructor;
  const held = own === undefined ? undefined : byConstructor.get(own);
  if (held !== undefined) return held.projection.image ?? "expression";
  if (TO_ATOM in (value as object)) return "expression";
  return undefined;
}

/**
 * How many members a container may hold and still cross by shape.
 *
 * Above this a conversion costs more than the program is likely to read, so
 * the value stays a reference and the program converts the part it wants.
 */
export const AUTO_TRANSPARENT_LIMIT = 64;

/**
 * `"transparent"` or `"opaque"` for one value, in O(1), reproducibly.
 *
 * The auto rung beneath a declared image: never a third behaviour, only a
 * choice between the two the vocabulary already has. A scalar and a small
 * sized container cross transparent; an ITERATOR stays opaque however short it
 * is, because measuring or converting one drains it, and draining is a side
 * effect no image choice is allowed to have. Resolution order is per call,
 * per operation, per type, then here.
 */
export function autoImage(value: unknown): Transparency {
  if (value === null || value === undefined) return "transparent";
  const kind = typeof value;
  if (kind !== "object" && kind !== "function") return "transparent";
  // An iterator is a LINEAR source: the source-discipline rule surfacing
  // inside auto. `next` beside `Symbol.iterator` is the shape of one.
  const held = value as { next?: unknown; [Symbol.iterator]?: unknown };
  if (typeof held.next === "function" && Symbol.iterator in held) return "opaque";
  if (Array.isArray(value)) {
    return value.length <= AUTO_TRANSPARENT_LIMIT ? "transparent" : "opaque";
  }
  if (value instanceof Map || value instanceof Set) {
    return value.size <= AUTO_TRANSPARENT_LIMIT ? "transparent" : "opaque";
  }
  // A re-readable sized value outside the built-in containers: a typed array,
  // an array-like, a custom collection that says how big it is.
  const sized = value as { length?: unknown; size?: unknown };
  const measured = typeof sized.length === "number" ? sized.length : sized.size;
  if (typeof measured === "number") {
    return measured <= AUTO_TRANSPARENT_LIMIT ? "transparent" : "opaque";
  }
  // A plain object is its own fields, which are sized; anything else is a
  // reference, which is what an untaught type always was.
  if ((value as { constructor?: Function }).constructor === Object) {
    return Object.keys(value).length <= AUTO_TRANSPARENT_LIMIT ? "transparent" : "opaque";
  }
  return "opaque";
}

/**
 * A host value as an atom, projected by SHAPE all the way down.
 *
 * A registered type becomes `(Name child...)`; an array becomes an expression;
 * a plain object becomes `(object (field name value)...)`; anything else is
 * an ordinary grounded atom, which is what `G` would have made of it.
 */
export function project(value: unknown): Atom {
  if (value instanceof Atom) return value;
  if (Array.isArray(value)) return exprOf(value.map(project));
  // A callable carrying its own atom — `S.Point` and every other name — is
  // that atom, which is the same rule `toAtom` follows. Without this a shape
  // written with `S` projected its heads as live JavaScript functions.
  const carried = lift(value);
  if (!(carried instanceof Grounded) || carried.value !== value) return carried;
  if (value === null || typeof value !== "object") return G(value);
  const self = value as Partial<SelfProjecting>;
  if (typeof self[TO_ATOM] === "function") return project(self[TO_ATOM]());
  const own = (value as { constructor?: Function }).constructor;
  const held = own === undefined ? undefined : byConstructor.get(own);
  if (held !== undefined) {
    const children = held.projection.toAtom(value);
    switch (held.projection.image ?? "expression") {
      // Both reference images keep the object itself; `operations` differs from
      // `handle` only in what a caller means to do with it afterwards, and the
      // atom either way is the reference.
      case "handle":
      case "operations":
        return G(value);
      case "symbol": {
        const first = children[0];
        if (first === undefined) return sym(held.projection.name);
        // A string child is the name itself; anything else renders, which is
        // how `sym` would have read it had the caller written it by hand.
        return sym(typeof first === "string" ? first : String(project(first)));
      }
      default:
        return expr(sym(held.projection.name), ...children.map(project));
    }
  }
  if (own === Object || own === undefined) {
    return expr(
      sym("object"),
      ...Object.entries(value).map(([name, held2]) => expr(sym(name), project(held2))),
    );
  }
  // A type nothing has taught crosses by REFERENCE, which is what it always
  // did: `G(value)` keeps the object itself, and the round trip is identity.
  return G(value);
}

/**
 * The host value an atom projects back to.
 *
 * The inverse of `project` for every registered type, and the identity for a
 * grounded atom carrying a live value. A symbol answers its own name and an
 * unregistered expression answers the atom itself, because inventing a value
 * for a shape nobody declared would be a guess.
 */
export function build(atom: Term): unknown {
  const built = toAtom(atom);
  if (built instanceof Grounded) return built.value;
  if (built instanceof Sym) {
    for (const each of bySymbol) {
      const claimed = (each.projection.fromAtom as unknown as (name: string) => unknown)(
        built.name,
      );
      if (claimed !== undefined) return claimed;
    }
    return built.name;
  }
  if (!(built instanceof Expression)) return built;
  const head = built.items[0];
  if (head instanceof Sym) {
    const held = byName.get(head.name);
    if (held !== undefined) {
      const children = built.items.slice(1).map(build);
      return (held.projection.fromAtom as unknown as (...args: unknown[]) => unknown)(
        ...children,
      );
    }
    if (head.name === "object") {
      const out: Record<string, unknown> = {};
      for (const field of built.items.slice(1)) {
        if (!(field instanceof Expression) || field.items.length !== 2) continue;
        out[String(field.items[0])] = build(field.items[1] as Atom);
      }
      return out;
    }
  }
  return built.items.map(build);
}

/** One projected value, beside the atom it projected to. */
export interface Projected {
  readonly value: unknown;
  readonly atom: Atom;
}

/**
 * Project a value and keep both halves, for a caller that needs them together.
 *
 * The shape a store wants: it holds the atom and hands back the value, and
 * `hostValue` is the shortcut when the atom is grounded rather than shaped.
 */
export function projected(value: unknown): Projected {
  return { value, atom: project(value) };
}

/** The plainest possible reading of an atom: its host value, or itself. */
export function plain(atom: Term): unknown {
  return hostValue(toAtom(atom));
}

/** Refuse a projection this module cannot make, naming what was asked. */
export function refuseProjection(value: unknown): never {
  throw new MettaError(
    `nothing says how ${String(value)} projects; registerType() it, give it a ` +
      `[TO_ATOM]() method, or cross it by reference with G()`,
  );
}
