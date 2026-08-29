/**
 * Purpose: reach into a LIVE host value from a MeTTa program, naming only the
 *   fields wanted, without projecting the object graph into atoms first.
 * Assumes:
 *   - a host value crosses into the engine by REFERENCE, so the engine holds
 *     an opaque handle and the object stays here. That is what makes a lazy
 *     reach possible at all: there is something on this side to reach into
 * Guarantees:
 *   - a path is IMMUTABLE and composable, so one built once is reused, and
 *     `profile.then("age")` never mutates `profile`
 *   - the walk is CYCLE-SAFE: an object identity seen twice ends the walk as a
 *     non-match rather than looping [tested: "ends a cyclic reach rather than
 *     looping"]
 *   - a missing field, a bad index or a value that cannot be subscripted all
 *     answer NOTHING rather than raising, because a reach inside a query is a
 *     filter and a filter that throws is a query that cannot be written
 * Decides: the reach is an OPERATION, not a pattern modifier. Python needs the
 *   pattern-position form because its query builder lifts the marker out of
 *   the pattern before matching; this surface evaluates `(match ...)` as an
 *   ordinary term, so the same job is done by a registered operation the
 *   engine calls, which is a door TypeScript already has and Python does not.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, type Term, G, Sym, expr, sym, toAtom } from "./atom.ts";
import { MettaError } from "./errors.ts";
import type { MeTTa } from "./metta.ts";
import { showsAs } from "./present.ts";

/** One step of a reach: a named property, or a subscript. */
export type Segment =
  | { readonly kind: "attr"; readonly name: string }
  | { readonly kind: "key"; readonly value: unknown };

/** One named-property step. */
export function attr(name: string): Segment {
  if (name === "") throw new MettaError("an attribute path segment cannot be empty");
  return { kind: "attr", name };
}

/** One subscript step, for a key that is not a property name. */
export function key(value: unknown): Segment {
  return { kind: "key", value };
}

/**
 * An immutable sequence of reach steps.
 *
 * ```ts
 * const age = path("profile", "age");
 * const first = age.then(0);           // a new path; `age` is unchanged
 * reach(person, age);                  // person.profile.age
 * ```
 *
 * A bare string is a property name and a bare number is a subscript, which is
 * the same reading `person.profile[0]` has in TypeScript.
 */
export class Path {
  /** The steps, in order. */
  readonly segments: readonly Segment[];

  constructor(segments: readonly Segment[]) {
    if (segments.length === 0) throw new MettaError("a path needs at least one segment");
    this.segments = Object.freeze([...segments]);
    Object.freeze(this);
  }

  /** This path with more steps after it. Answers a NEW path. */
  then(...more: readonly (string | number | Segment)[]): Path {
    return new Path([...this.segments, ...more.map(segmentOf)]);
  }

  /** The path as the atom the engine reads: `(segments (attr "x") (key 0))`. */
  get atom(): Atom {
    return expr(
      SEGMENTS,
      ...this.segments.map((segment) =>
        segment.kind === "attr"
          ? expr(sym("attr"), G(segment.name))
          : expr(sym("key"), toAtom(segment.value as Term)),
      ),
    );
  }

  toString(): string {
    return this.segments
      .map((segment) => (segment.kind === "attr" ? `.${segment.name}` : `[${String(segment.value)}]`))
      .join("");
  }
}

showsAs(Path.prototype, (path: Path) => `Path(${path.toString()})`);

const SEGMENTS = sym("segments");

/** The head a reach reduces under, in MeTTa source. */
export const PATH_AT = "path-at";

function segmentOf(step: string | number | Segment): Segment {
  if (typeof step === "string") return attr(step);
  if (typeof step === "number") return key(step);
  return step;
}

/**
 * Build a path from bare steps.
 *
 * ```ts
 * path("profile", "age")     // .profile.age
 * path("rows", 0, "id")      // .rows[0].id
 * ```
 */
export function path(...segments: readonly (string | number | Segment)[]): Path {
  return new Path(segments.map(segmentOf));
}

/**
 * Walk a live host value, or answer nothing.
 *
 * Cycle-safe: an object identity seen twice ends the walk, so a self-
 * referential structure answers nothing instead of looping. A missing field,
 * an out-of-range index and a value that cannot be subscripted all answer
 * nothing too, because a reach used as a filter must be able to fail.
 */
export function reach(root: unknown, walk: Path): unknown {
  const seen = new Set<object>();
  let at: unknown = root;
  if (!remember(at, seen)) return undefined;
  for (const segment of walk.segments) {
    if (at === null || at === undefined) return undefined;
    let stepped: unknown;
    try {
      if (segment.kind === "attr") {
        if (typeof at !== "object" && typeof at !== "function") return undefined;
        stepped = (at as Record<string, unknown>)[segment.name];
      } else if (at instanceof Map) {
        stepped = at.get(segment.value);
      } else {
        stepped = (at as Record<string, unknown>)[String(segment.value)];
      }
    } catch {
      return undefined;
    }
    if (stepped === undefined) return undefined;
    if (!remember(stepped, seen)) return undefined;
    at = stepped;
  }
  return at;
}

function remember(value: unknown, seen: Set<object>): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return true;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  return true;
}

/**
 * Install the `path-at` operation, so a MeTTa program reaches too.
 *
 * ```ts
 * installPaths(m);
 * m.load`!(path-at ${G(person)} (segments (attr "profile") (attr "age")))`;
 * ```
 *
 * It answers NOTHING where the reach fails, which is `(empty)`: a filter that
 * prunes its branch, rather than an error atom that would have to be caught.
 */
export function installPaths(surface: MeTTa): void {
  // A GENERATOR body, because that is how this surface spells "answers zero or
  // more times": a reach that fails yields nothing, which is `(empty)`, and a
  // reach that lands yields one value.
  surface.op(
    function* pathAt(root: unknown, segments: unknown): Generator<unknown> {
      const value = reach(root, pathOf(segments as Atom));
      if (value !== undefined) yield value;
    } as unknown as (...args: never[]) => unknown,
    { name: PATH_AT, effect: "readOnlyLookup" },
  );
}

/** Read a `(segments ...)` atom back into a path. */
export function pathOf(atom: Atom): Path {
  if (!(atom instanceof Expression) || atom.items[0] !== SEGMENTS) {
    throw new MettaError(`a path is (segments (attr "x") (key 0)), not ${atom.text}`);
  }
  return new Path(
    atom.items.slice(1).map((step) => {
      if (!(step instanceof Expression) || step.items.length !== 2) {
        throw new MettaError(`invalid path segment ${step.text}`);
      }
      const head = step.items[0];
      const payload = step.items[1] as Atom;
      const held = payload as { kind: string; value?: unknown };
      const value = held.kind === "grounded" ? held.value : payload;
      if (head instanceof Sym && head.name === "attr") {
        return attr(payload instanceof Sym ? payload.name : String(value));
      }
      if (head instanceof Sym && head.name === "key") return key(value);
      throw new MettaError(`invalid path segment ${step.text}`);
    }),
  );
}
