/**
 * Purpose: this seat's one extension seam, the seat-level twin of
 *   engine/ext_points.pl and of metta.seam on the Python seat. Every point a
 *   library can plug into is DECLARED here with its kind, its fields and what
 *   it decides; a registrant is a row against a declared point; and both read
 *   back as data, so "what can I extend" is a query rather than a source
 *   reading.
 * Assumes:
 *   - a package registers from its own module body, because ESM `import()` is
 *     asynchronous and a synchronous dispatch cannot await one. That is the
 *     one place this seam differs from the Python seat's, where a dispatch
 *     loads an advertised entry point on demand; `discover()` here is the
 *     explicit async call that does the same job for an app that wants
 *     `npm install` to be the whole of the wiring
 * Guarantees:
 *   - a point is declared once with one kind, and a second declaration of the
 *     same name is refused naming the first
 *     [tested: "declares a point once with one kind"]
 *   - registering against an undeclared point refuses naming every declared
 *     point, and a row missing a declared field refuses naming the field
 *     [tested: "refuses an undeclared point by name",
 *     "refuses a row missing a declared field, and one that gives too many"]
 *   - dispatching a point the wrong way for its kind refuses naming the right
 *     way [tested: "refuses each kind's dispatch on the other kinds"]
 *   - an ownership point consults rows in registration order and the first
 *     non-undefined answer wins; an event point runs every row
 *     [tested: "stops an ownership dispatch at the first row that claims",
 *     "runs every row of an event point, in registration order"]
 *   - a point whose rows already live somewhere keeps that storage and is
 *     still one row table from out here, so nothing about `registerType`,
 *     `registerRepr` or `registerReflector` changes
 *     [tested: "registers a type through the seam and reads it back from
 *     convert's own store",
 *     "keeps the name a reflector was registered under, which its store does
 *     not hold"]
 * Decides: four kinds, where the engine declares five. `host_service` splits
 *   `service` by an audience internal to the engine (host bindings against
 *   extensions) and a seat has one audience.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  byCodePoint,
  expr,
  registerRepr,
  reprs,
  sym,
  unregisterRepr,
} from "./atom.ts";
import { registerType, registrations, unregisterType } from "./convert.ts";
import { MettaError, NameError } from "./errors.ts";
import {
  ENTRY_POINT_GROUP,
  type EntryPoint,
  LIBRARIES_GROUP,
  type Reflector,
  SPACES_GROUP,
  entryPoints,
  loadEntryPoint,
  reflectorRows,
  registerReflector,
  unregisterReflector,
} from "./integrate.ts";
import { mettaName } from "./naming.ts";

/** The four seat kinds, in the order EXTENDING.md lists them. */
export const KINDS = ["declaration", "ownership", "event", "service"] as const;

/** One of the four. */
export type Kind = (typeof KINDS)[number];

/**
 * Who writes a kind's rows: the engine's `clauses_from/2` twin, and the reason
 * the dispatch rules are derived rather than restated. Only a kind whose rows a
 * REGISTRANT writes can have a row that declines.
 */
export const WRITTEN_BY: Readonly<Record<Kind, "registrant" | "seat">> = Object.freeze({
  declaration: "registrant",
  ownership: "registrant",
  event: "registrant",
  service: "seat",
});

/** Which seat this is, written into every catalog row. */
export const SEAT = "node";

/** Where a package advertises rows of its own, beside the three older groups. */
export const GROUP = "extensions";

/** How each kind is read, for the refusal a wrong-kind dispatch raises. */
const DISPATCH: Readonly<Record<Kind, string>> = Object.freeze({
  declaration: "table()",
  ownership: "claim(...)",
  event: "each(...)",
  service: "call()",
});

/** One registration: a point, who registered, and the fields they gave. */
export interface Row<F extends object = Record<string, unknown>> {
  /** The point this row is against. */
  readonly point: string;
  /** Who registered it. */
  readonly name: string;
  /** What they gave, as an object so a field is a NAME and not a string. */
  readonly fields: F;
  /** The package it came from, or `shipped`. */
  readonly source: string;
}

/** What an ownership dispatch answers: who claimed, and with what. */
export interface Claim<F extends object> {
  readonly name: string;
  readonly row: Row<F>;
  readonly answer: unknown;
}

/** What a point declaration takes beyond its kind and its fields. */
export interface Declaration<F extends object> {
  /** The names a row must carry. */
  readonly fields: readonly string[];
  /** What this point decides, in one paragraph. */
  readonly doc: string;
  /** The names a row may carry. */
  readonly optional?: readonly string[];
  /** Where this point's rows already live, when they do. */
  readonly reader?: () => readonly Row<F>[];
  /** How one is added there, answering the inverse. */
  readonly adder?: (row: Row<F>) => (() => void) | undefined;
}

const points = new Map<string, Point<never>>();
const held = new Map<string, Row<never>[]>();

/**
 * One declared extension point: its kind, its fields, and what it decides.
 *
 * Declared through `point(...)`, never constructed directly, because a
 * declaration is the thing the seam has to see.
 */
export class Point<F extends object = Record<string, unknown>> {
  /** This point's name, which a row is registered against. */
  readonly name: string;
  /** Which of the four kinds it is, and therefore how it is read. */
  readonly kind: Kind;
  /** Its fields, its documentation, and where its rows live. */
  readonly declaration: Declaration<F>;

  /** @internal Use `point(...)`. */
  constructor(name: string, kind: Kind, declaration: Declaration<F>) {
    this.name = name;
    this.kind = kind;
    this.declaration = declaration;
  }

  /** The names a row must carry. */
  get fields(): readonly string[] {
    return this.declaration.fields;
  }

  /** What this point decides. */
  get doc(): string {
    return this.declaration.doc;
  }

  /**
   * Add one row to this point, answering it.
   *
   * Registering an existing name REPLACES that row in its original position,
   * which is the registry's ordinary replacement and keeps ownership order
   * stable across a reload.
   */
  register(name: string, fields: F, source = "package"): Row<F> {
    if (WRITTEN_BY[this.kind] !== "registrant") {
      throw new MettaError(
        `${this.name} is a ${this.kind} point, which the SEAT writes; ` +
          `a registrant reads it with ${DISPATCH[this.kind]}`,
      );
    }
    const given = Object.keys(fields);
    const missing = this.declaration.fields.filter((field) => !given.includes(field));
    if (missing.length > 0) {
      throw new MettaError(
        `the ${this.name} point declares ${this.declaration.fields.join(", ")}; ` +
          `the ${name} registration is missing ${missing.join(", ")}`,
      );
    }
    const allowed = [...this.declaration.fields, ...(this.declaration.optional ?? [])];
    const extra = given.filter((field) => !allowed.includes(field)).sort(byCodePoint);
    if (extra.length > 0) {
      throw new MettaError(
        `the ${this.name} point declares ${allowed.slice().sort(byCodePoint).join(", ")}; ` +
          `the ${name} registration also gave ${extra.join(", ")}`,
      );
    }
    const row: Row<F> = { point: this.name, name, fields, source };
    // The row is held here whatever else happens to it, so a registration
    // keeps the NAME it was given; a point whose store is elsewhere then
    // performs the side effect through its adder.
    this.declaration.adder?.(row);
    const rows = held.get(this.name) as Row<F>[];
    const at = rows.findIndex((standing) => standing.name === name);
    if (at >= 0) rows[at] = row;
    else rows.push(row);
    return row;
  }

  /** Withdraw one row, answering whether there was one. */
  unregister(name: string): boolean {
    const rows = held.get(this.name) as Row<F>[];
    const at = rows.findIndex((standing) => standing.name === name);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  }

  /** Every row against this point, in registration order. */
  rows(): readonly Row<F>[] {
    const mine = (held.get(this.name) ?? []) as readonly Row<F>[];
    const reader = this.declaration.reader;
    if (reader === undefined) return mine;
    // A point whose rows live elsewhere still answers what was registered
    // THROUGH the older door directly; a row this table already holds is not
    // repeated. Same NAME, or the same values under every field the two spell
    // in common: a store records what IT keeps, which is rarely what the
    // registration supplied, so `type` hands back `image` where the
    // registration gave `toAtom`.
    const elsewhere = reader().filter((row) => !mine.some((ours) => same(ours, row)));
    return [...mine, ...elsewhere];
  }

  /** One row by registrant name, or nothing. */
  find(name: string): Row<F> | undefined {
    return this.rows().find((row) => row.name === name);
  }

  /** This DECLARATION point's rows as data, keyed by registrant. */
  table(): Map<string, Row<F>> {
    this.expect("declaration", "table()");
    return new Map(this.rows().map((row) => [row.name, row]));
  }

  /**
   * Consult this OWNERSHIP point: the first row whose `claims` answers.
   *
   * A row declines by answering `undefined` and the next is consulted, so a
   * library that does not own this subject costs one call.
   */
  claim(...args: readonly unknown[]): Claim<F> | undefined {
    this.expect("ownership", "claim()");
    for (const row of this.rows()) {
      const claims = (row.fields as { claims: (...a: readonly unknown[]) => unknown }).claims;
      const answer = claims(...args);
      if (answer !== undefined && answer !== null) return { name: row.name, row, answer };
    }
    return undefined;
  }

  /**
   * Run every row of this EVENT point, answering who ran.
   *
   * Every row runs, and a row that THROWS stops the ones after it and the
   * error reaches the caller. Swallowing it is the one thing an event seam
   * may not do: a handler that failed silently is a handler nothing can find.
   */
  each(...args: readonly unknown[]): readonly string[] {
    this.expect("event", "each()");
    const ran: string[] = [];
    for (const row of this.rows()) {
      (row.fields as { on: (...a: readonly unknown[]) => void }).on(...args);
      ran.push(row.name);
    }
    return ran;
  }

  /** This SERVICE point's callable, the one the seat publishes. */
  call(): unknown {
    this.expect("service", "call()");
    return (this.rows()[0]?.fields as { call: unknown }).call;
  }

  /**
   * The sentence a caller gets when no row of this point answers.
   *
   * Names the door rather than the missing library, because the caller's next
   * move is a registration and the library is only an example of one.
   */
  refusal(subject: string): string {
    const registered = this.rows()
      .map((row) => row.name)
      .join(", ");
    return (
      `no ${this.name} registration handles ${subject}; registered: ` +
      `${registered === "" ? "nothing" : registered}. A library registers with ` +
      `seam.at("${this.name}").register(<name>, { ${this.fields.join(", ")} }), ` +
      `or advertises the same call under the ${GROUP} group of its package.json`
    );
  }

  private expect(kind: Kind, spelling: string): void {
    if (this.kind !== kind) {
      throw new MettaError(
        `${this.name} is a ${this.kind} point, so ${spelling} is not how it ` +
          `is read; use ${DISPATCH[this.kind]}`,
      );
    }
  }
}

/** Whether a row read back from a foreign store is one this table holds. */
function same(ours: Row<object>, theirs: Row<object>): boolean {
  if (ours.name === theirs.name) return true;
  const mine = ours.fields as Record<string, unknown>;
  const other = theirs.fields as Record<string, unknown>;
  const shared = Object.keys(other).filter((field) => field in mine);
  return shared.length > 0 && shared.every((field) => mine[field] === other[field]);
}

/**
 * Declare one extension point, answering it.
 *
 * `kind` decides how the point is read. `fields` are the names a row must
 * carry and `optional` the ones it may; a row with anything else is refused,
 * which is what makes a typo in a registration loud.
 *
 * `reader` and `adder` are for a point whose rows already live somewhere: the
 * reader answers them, and the adder performs a registration and answers the
 * inverse to undo it. A point with neither keeps its rows here.
 */
export function point<F extends object = Record<string, unknown>>(
  name: string,
  kind: Kind,
  declaration: Declaration<F>,
): Point<F> {
  if (!KINDS.includes(kind)) {
    throw new MettaError(`an extension point is one of ${KINDS.join(", ")}, not ${kind}`);
  }
  const reserved = ["point", "name", "fields", "source"].filter(
    (word) => declaration.fields.includes(word) || (declaration.optional ?? []).includes(word),
  );
  if (reserved.length > 0) {
    throw new MettaError(
      `a row already carries ${reserved.join(", ")}, so the ${name} point ` +
        `cannot declare a field of that name`,
    );
  }
  if (kind === "ownership" && !declaration.fields.includes("claims")) {
    throw new MettaError(
      `an ownership point is consulted through a row's claims(...), so ${name} ` +
        `must declare a claims field; it declares ` +
        `${declaration.fields.join(", ") || "none"}`,
    );
  }
  if (kind === "event" && !declaration.fields.includes("on")) {
    throw new MettaError(
      `an event point runs a row's on(...), so ${name} must declare an on ` +
        `field; it declares ${declaration.fields.join(", ") || "none"}`,
    );
  }
  const standing = points.get(name);
  if (standing !== undefined) {
    throw new NameError(
      `extension point ${name} is already declared as ${standing.kind} with ` +
        `fields ${standing.fields.join(", ")}; a point has one kind`,
    );
  }
  const declared = new Point<F>(name, kind, declaration);
  points.set(name, declared as unknown as Point<never>);
  held.set(name, []);
  return declared;
}

/**
 * Publish one seat service: what a registrant may CALL.
 *
 * The other direction from the three handler kinds. A registrant that needs
 * the seat's own machinery calls a published service instead of importing a
 * private module, which is the surface SQLite publishes for the same reason
 * and the reason the engine's own service kind exists.
 */
export function service<T>(name: string, doc: string, fn: T): T {
  point(name, "service", { fields: ["call"], doc });
  (held.get(name) as Row<{ call: T }>[]).push({
    point: name,
    name: SEAT,
    fields: { call: fn },
    source: "shipped",
  });
  return fn;
}

/**
 * One declared point by name, or a refusal listing every declared point.
 *
 * The general spelling; a shipped point is also a named export of this module,
 * which is the sugar over this.
 */
export function at<F extends object = Record<string, unknown>>(name: string): Point<F> {
  const declared = points.get(name);
  if (declared === undefined) {
    const known = [...points.keys()].sort(byCodePoint).join(", ");
    throw new NameError(
      `no extension point named ${name}; this seat declares: ${known === "" ? "none" : known}`,
    );
  }
  return declared as unknown as Point<F>;
}

/** Every declared point, keyed by name: the seam as data. */
export function declared(): Map<string, Point<never>> {
  return new Map(points);
}

/** Every row of one point, or of every point, in registration order. */
export function rows(name?: string): readonly Row<never>[] {
  if (name !== undefined) return at<never>(name).rows();
  return [...points.values()].flatMap((declaredPoint) => declaredPoint.rows());
}

/** What this seat publishes for a registrant to call. */
export function services(): Map<string, unknown> {
  return new Map(
    [...points.values()]
      .filter((declaredPoint) => declaredPoint.kind === "service")
      .map((declaredPoint) => [declaredPoint.name, declaredPoint.call()]),
  );
}

/**
 * Withdraw a declared point and every row against it.
 *
 * Remove-then-redeclare is how a program deliberately widens a point whose
 * shipped contract does not fit it, the same move the engine's catalog
 * documents for a shipped kind row. Answers whether there was a point.
 */
export function withdraw(name: string): boolean {
  held.delete(name);
  return points.delete(name);
}

/** The catalog head one point row occupies. */
const POINT_HEAD = "extension-point";
/** The catalog head one registration occupies. */
const ROW_HEAD = "extension";

/**
 * Write the whole seam into a space's catalog, answering the row count.
 *
 * ```ts
 * await m.eval(S["match"](S["&metta"], ..., V.who));
 * ```
 *
 * Two kind rows make the engine's own declaration checker refuse a malformed
 * row at the write. The rows carry the seat, the point and the registrant, not
 * the callables: a callable is not knowledge, and what a program asks the
 * catalog is who registered against what.
 */
export async function publish(surface: {
  catalog: { has(atom: Atom): Promise<boolean>; add(atom: Atom): Promise<unknown> };
}): Promise<number> {
  let written = 0;
  for (const kindRow of [
    expr(sym("kind"), sym(POINT_HEAD), sym("symbol"), sym("symbol"), sym("symbol"), sym("term")),
    expr(sym("kind"), sym(ROW_HEAD), sym("symbol"), sym("symbol"), sym("symbol"), sym("term")),
  ]) {
    if (!(await surface.catalog.has(kindRow))) await surface.catalog.add(kindRow);
  }
  for (const name of [...points.keys()].sort(byCodePoint)) {
    const declaredPoint = at(name);
    const row = expr(
      sym(POINT_HEAD),
      sym(SEAT),
      sym(name),
      sym(declaredPoint.kind),
      expr(sym("fields"), ...declaredPoint.fields.map((field) => sym(field))),
    );
    if (!(await surface.catalog.has(row))) {
      await surface.catalog.add(row);
      written += 1;
    }
    for (const registration of declaredPoint.rows()) {
      const registered = expr(
        sym(ROW_HEAD),
        sym(SEAT),
        sym(name),
        sym(registration.name),
        expr(
          sym("fields"),
          ...Object.keys(registration.fields as object)
            .sort(byCodePoint)
            .map((field) => sym(field)),
        ),
      );
      if (!(await surface.catalog.has(registered))) {
        await surface.catalog.add(registered);
        written += 1;
      }
    }
  }
  return written;
}

// ---------------------------------------------------------------- the points
//
// One file declares every point of this seat, for the reason ext_points.pl
// gives for declaring every engine seam in one: the kind is the load-bearing
// fact about a seam, and a kind that lives beside its implementation is a fact
// nothing can enumerate. The implementations live in their own modules.
//
// This seat names no third-party library anywhere, so there is no registrant
// module beside this one: its two non-relative imports are swipl-wasm, the
// engine it mounts, and acorn, the parser its own `define` lowering uses, and
// neither decides behaviour toward a CLASS of libraries. It has no frame
// library notion at all, and its array notion is the platform's own TypedArray
// family, which every numeric library in this runtime already produces, so
// there is nothing here to declare a `frame` or an `array` point for; the
// Python seat has both because Python has neither of those universals.

/** How a host class crosses, both ways. */
export interface TypeFields {
  /** The class this row is about. */
  readonly constructor: abstract new (...args: never[]) => unknown;
  /** Its children, when it declares them. */
  readonly toAtom?: (value: never) => unknown;
  /** How it is rebuilt from them. */
  readonly fromAtom?: (...parts: never[]) => unknown;
  /** Which of the four images it takes. */
  readonly image?: string;
}

/** How a host class crosses, both ways. */
export const type: Point<TypeFields> = point<TypeFields>("type", "declaration", {
  fields: ["constructor"],
  optional: ["toAtom", "fromAtom", "image"],
  doc:
    "How a host class crosses, both ways, declared rather than derived. The " +
    "ROW's name is the MeTTa constructor name, so nothing is said twice; " +
    "`registerType` from metta-node/convert is the same door under the name a " +
    "program reaches for, and its registry is where these rows live.",
  reader: () =>
    registrations().map((entry) => ({
      point: "type",
      name: entry.name,
      fields: {
        constructor: entry.constructor as abstract new (...args: never[]) => unknown,
        image: entry.image,
      },
      source: "package",
    })),
  adder: (row) => {
    const constructor = row.fields.constructor;
    registerType(constructor, {
      name: row.name,
      toAtom: row.fields.toAtom as never,
      fromAtom: row.fields.fromAtom as never,
      image: row.fields.image as never,
    } as never);
    return () => void unregisterType(constructor);
  },
});

/** How a host value PRINTS inside an atom. */
export interface ReprFields {
  /** The class this rendering is for. */
  readonly constructor: abstract new (...args: never[]) => unknown;
  /** How one of its values reads as MeTTa text. */
  readonly text: (value: never) => string;
}

/** How a host value PRINTS inside an atom. */
export const repr: Point<ReprFields> = point<ReprFields>("repr", "declaration", {
  fields: ["constructor", "text"],
  doc:
    "How a host value renders inside an atom. Keyed by the value's own " +
    "constructor, so a row is one class's rendering; `registerRepr` from " +
    "metta-node/atom is the same door and its map is where these rows live.",
  reader: () =>
    reprs().map((entry) => ({
      point: "repr",
      name: entry.constructor.name,
      fields: {
        constructor: entry.constructor as abstract new (...args: never[]) => unknown,
        text: entry.text,
      },
      source: "package",
    })),
  adder: (row) => {
    const constructor = row.fields.constructor;
    registerRepr(constructor, row.fields.text as never);
    return () => void unregisterRepr(constructor);
  },
});

/** How a host object's structure becomes facts. */
export interface ReflectorFields {
  /** Whether this row lowers that value. */
  readonly claims: (value: unknown) => boolean;
  /** How it writes the facts, answering how many. */
  readonly lower: Reflector;
}

/** How a host object's structure becomes facts. */
export const reflector: Point<ReflectorFields> = point<ReflectorFields>("reflector", "ownership", {
  fields: ["claims", "lower"],
  doc:
    "How a host object's structure becomes facts. `claims(value)` recognises " +
    "what this row can lower and `lower(surface, name, target)` writes the " +
    "facts; `registerReflector` from metta-node/integrate is the same door.",
  reader: () =>
    reflectorRows().map((entry) => ({
      point: "reflector",
      name: entry.lower.name === "" ? "anonymous" : entry.lower.name,
      fields: { claims: entry.claims, lower: entry.lower },
      source: "package",
    })),
  adder: (row) => {
    registerReflector(row.fields.claims, row.fields.lower);
    return () => void unregisterReflector(row.fields.claims, row.fields.lower);
  },
});

/** One point per older group, read straight from what packages advertise. */
function advertisedRows(name: string, group: string): () => readonly Row<never>[] {
  return () =>
    [...entryPoints(group).values()].map(
      (entry) =>
        ({
          point: name,
          name: entry.name,
          fields: { entry, group },
          source: entry.package,
        }) as unknown as Row<never>,
    );
}

/** What a row read from one of the three older package.json groups carries. */
export interface AdvertisedFields {
  /** The advertised entry, unloaded. */
  readonly entry: EntryPoint;
  /** Which package.json group advertised it. */
  readonly group: string;
}

/** A space backed by a library's own storage. */
export const provider: Point<AdvertisedFields> = point<AdvertisedFields>("provider", "declaration", {
  fields: ["entry", "group"],
  doc:
    "A space backed by a library's own storage, advertised under the " +
    "`spaces` group of its package.json. The rows are what installed packages " +
    "advertise, UNLOADED; `loadEntryPoint(name)` loads one and " +
    "`registerProvider(engine, name, provider)` backs a space with it.",
  reader: advertisedRows("provider", SPACES_GROUP) as () => readonly Row<AdvertisedFields>[],
});

/** A directory of MeTTa sources a package ships. */
export const library: Point<AdvertisedFields> = point<AdvertisedFields>("library", "declaration", {
  fields: ["entry", "group"],
  doc:
    "A directory of MeTTa sources a package ships, advertised under the " +
    "`libraries` group of its package.json and importable as `(library " +
    "<name>)` once its path is registered.",
  reader: advertisedRows("library", LIBRARIES_GROUP) as () => readonly Row<AdvertisedFields>[],
});

/** A whole library wired into a space. */
export const integration: Point<AdvertisedFields> = point<AdvertisedFields>(
  "integration",
  "declaration",
  {
    fields: ["entry", "group"],
    doc:
      "A whole library wired into a space, advertised under the " +
      "`integrations` group of its package.json. `discover()` answers them in " +
      "install order and refuses a requirement cycle.",
    reader: advertisedRows("integration", ENTRY_POINT_GROUP) as () => readonly Row<AdvertisedFields>[],
  },
);

// ------------------------------------------------------------- the services

/** A term built from a head and its arguments, for a registrant building one. */
export const term: (head: string, ...args: readonly Atom[]) => Atom = service(
  "term",
  "Build an expression from a head and its arguments, so a registrant writes " +
    "atoms without reaching into the atom module's internals.",
  (head: string, ...args: readonly Atom[]): Atom => expr(sym(head), ...args),
);

/** The name a registrant should publish a MeTTa head under. */
export const name: (host: string) => string = service(
  "name",
  "The MeTTa spelling of a host name: camelCase reaches hyphens, and a name " +
    "outside the identifier grammar crosses untouched.",
  (host: string): string => mettaName(host),
);

/**
 * Load every registration advertised under the `extensions` group.
 *
 * The explicit half of discovery. A package's own module body is the primary
 * door here, because ESM `import()` is asynchronous and a synchronous dispatch
 * cannot await one; this is for an app that wants `npm install` to be the
 * whole of the wiring. A target that is callable is CALLED, which is where it
 * registers; a module target is merely imported, its body having registered on
 * the way in.
 */
export async function discover(from: string = process.cwd()): Promise<readonly string[]> {
  const advertised = [...entryPoints(GROUP, from).keys()].sort(byCodePoint);
  for (const each of advertised) {
    const target = await loadEntryPoint(each, { group: GROUP, from });
    if (typeof target === "function") (target as () => void)();
  }
  return advertised;
}

/** The registration names installed packages advertise, UNLOADED. */
export function advertised(from: string = process.cwd()): readonly string[] {
  return [...entryPoints(GROUP, from).keys()].sort(byCodePoint);
}
