/**
 * Purpose: the interface a TypeScript library implements to work with MeTTa,
 *   and the toolkit that makes implementing it a page rather than a project.
 * Assumes:
 *   - a library's own module is the natural unit: its exported functions are
 *     candidate operations, its classes are candidate types, and its data is a
 *     candidate space. Nothing here needs the library to know about MeTTa
 * Guarantees:
 *   - every registration has an exact removal counterpart, so a test that
 *     integrates cleans up completely and a plugin can be unloaded
 *     [tested: "installs and uninstalls an integration completely"]
 *   - an integration installs ATOMICALLY: a failure part way undoes what it
 *     did rather than leaving half a library registered
 *     [tested: "leaves nothing behind when an install fails"]
 *   - what is installed is DATA: `(integration <name>)` and one
 *     `(operation <name> <arity>)` per operation land in `&metta`, so a MeTTa
 *     program reads what a library gave it
 * Decides: discovery reads `package.json`, because that is where a Node
 *   package declares things about itself. A package says it integrates by
 *   carrying a `metta` field naming the module to import; nothing is scanned
 *   and nothing is guessed.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { type Atom, G, type Term, Var, expr, sym } from "./atom.ts";
import { MettaError, NameError, SourceNotFoundError } from "./errors.ts";
import type { Defined } from "./define/define.ts";
import type { MeTTa } from "./metta.ts";
import { mettaName } from "./naming.ts";
import { showsAs } from "./present.ts";
import { hostValue } from "./space.ts";
import type { EffectClass } from "./vocabularies.ts";

/** What a library implements to work with MeTTa. */
export interface Integration {
  /** Its own name, which is what `&metta` records and what removal names. */
  readonly name: string;
  /** Everything it adds. Called once, and expected to be idempotent. */
  install(surface: MeTTa): void | Promise<void>;
  /** How to take it back out, when it needs more than the automatic removal. */
  uninstall?(surface: MeTTa): void | Promise<void>;
}

/** A module that IS an integration, by exporting the installer. */
export interface IntegratingModule {
  installMetta(surface: MeTTa): void | Promise<void>;
}

/** What one installed integration left behind. */
export class Installed {
  /** The integration's own name. */
  readonly name: string;
  /** Every operation it registered, by head and arity. */
  readonly operations: readonly (readonly [string, number])[];
  readonly #surface: MeTTa;
  readonly #uninstall: ((surface: MeTTa) => void | Promise<void>) | undefined;

  /** @internal Built by {@link integrate}. */
  constructor(
    surface: MeTTa,
    name: string,
    operations: readonly (readonly [string, number])[],
    uninstall?: (surface: MeTTa) => void | Promise<void>,
  ) {
    this.#surface = surface;
    this.name = name;
    this.operations = operations;
    this.#uninstall = uninstall;
  }

  /** Take the integration back out: its operations, its facts, and its own hook. */
  async remove(): Promise<void> {
    await this.#uninstall?.(this.#surface);
    for (const [head, arity] of this.operations) {
      this.#surface.engine.unregister(head, arity);
      this.#surface.catalog.delete(expr(sym("operation"), sym(head), G(arity)));
    }
    this.#surface.catalog.delete(expr(sym("integration"), sym(this.name)));
  }

  toString(): string {
    return `Installed(${this.name}, ${String(this.operations.length)} operations)`;
  }
}

showsAs(Installed.prototype, (installed: Installed) => installed.toString());

/**
 * Install an integration, and record what it gave.
 *
 * ```ts
 * const installed = await integrate(m, {
 *   name: "clock",
 *   install: (surface) => { moduleOps(surface, { now: () => Date.now() }); },
 * });
 * await m.match(S.integration(V.name));      // (integration clock)
 * await installed.remove();
 * ```
 *
 * A module exporting `installMetta` is an integration too, so a library can be
 * one without importing anything from here.
 */
export async function integrate(
  surface: MeTTa,
  integration: Integration | IntegratingModule,
  options: { readonly name?: string } = {},
): Promise<Installed> {
  const named = "name" in integration ? integration.name : options.name;
  if (named === undefined || named === "") {
    throw new MettaError(
      "an integration needs a name: give the object one, or pass { name } beside a module",
    );
  }
  const install =
    "install" in integration
      ? integration.install.bind(integration)
      : integration.installMetta.bind(integration);
  const before = new Set(registeredHeads(surface).map(key));
  try {
    await install(surface);
  } catch (error) {
    // Whatever it managed to register comes back out, so a failed install
    // leaves the surface as it found it.
    for (const [head, arity] of registeredHeads(surface)) {
      if (!before.has(key([head, arity]))) surface.engine.unregister(head, arity);
    }
    throw error;
  }
  const added = registeredHeads(surface).filter((each) => !before.has(key(each)));
  surface.catalog.add(expr(sym("integration"), sym(named)));
  for (const [head, arity] of added) {
    surface.catalog.add(expr(sym("operation"), sym(head), G(arity)));
  }
  const uninstall = "uninstall" in integration ? integration.uninstall : undefined;
  return new Installed(
    surface,
    named,
    added,
    uninstall === undefined ? undefined : uninstall.bind(integration),
  );
}

/** Every host operation this engine holds, as head and arity. */
function registeredHeads(surface: MeTTa): (readonly [string, number])[] {
  return surface.engine.operations().map((op) => [op.name, op.arity] as const);
}

/** One operation's identity, which is its head AND its arity. */
function key([head, arity]: readonly [string, number]): string {
  return `${head}/${String(arity)}`;
}

/** What `moduleOps` accepts. */
export interface ModuleOpsOptions {
  /** A prefix every name takes, so two libraries cannot collide. */
  readonly prefix?: string;
  /** The effect class every operation declares. `oracleIO` by default. */
  readonly effect?: EffectClass;
  /** Which exports to take. Every function, by default. */
  readonly only?: readonly string[];
}

/**
 * Register every exported function of a module as an operation.
 *
 * ```ts
 * import * as crypto from "node:crypto";
 * moduleOps(m, { randomUUID: crypto.randomUUID }, { prefix: "crypto" });
 * await m.eval(S["crypto-random-uuid"]()).one();
 * ```
 *
 * The name each one takes is this package's own casing map applied to its
 * export name, so `randomUUID` is `random-uuid` and a MeTTa program spells it
 * the way MeTTa spells things.
 */
export function moduleOps(
  surface: MeTTa,
  module: Readonly<Record<string, unknown>>,
  options: ModuleOpsOptions = {},
): Defined[] {
  const installed: Defined[] = [];
  for (const [name, held] of Object.entries(module)) {
    if (typeof held !== "function") continue;
    if (options.only !== undefined && !options.only.includes(name)) continue;
    const head =
      options.prefix === undefined
        ? mettaName(name)
        : `${mettaName(options.prefix)}-${mettaName(name)}`;
    installed.push(
      surface.op(held as (...args: never[]) => unknown, {
        name: head,
        effect: options.effect ?? "oracleIO",
      }),
    );
  }
  return installed;
}

/**
 * Register an object's own methods as operations, bound to that object.
 *
 * The door for a library whose surface is an INSTANCE rather than a module: a
 * client, a connection, a session. Each method keeps its receiver, so calling
 * it from MeTTa is calling it on that object.
 */
export function objectOps(
  surface: MeTTa,
  instance: object,
  options: ModuleOpsOptions = {},
): Defined[] {
  const prototype = Object.getPrototypeOf(instance) as object;
  const names = new Set([
    ...Object.getOwnPropertyNames(instance),
    ...Object.getOwnPropertyNames(prototype),
  ]);
  names.delete("constructor");
  const bound: Record<string, unknown> = {};
  for (const name of names) {
    if (name.startsWith("#") || name.startsWith("_")) continue;
    const held = (instance as Record<string, unknown>)[name];
    if (typeof held !== "function") continue;
    // The bound method keeps its own `length`, which is the arity the
    // registration reads, so binding does not change how it is called.
    const method = (held as (...args: unknown[]) => unknown).bind(instance);
    Object.defineProperty(method, "length", { value: (held as { length: number }).length });
    bound[name] = method;
  }
  return moduleOps(surface, bound, options);
}

/**
 * One function as an operation, named and classified by the caller.
 *
 * The single-target form of {@link moduleOps}, for a library that wants one
 * function across rather than its whole surface.
 */
export function wrapCallable(
  surface: MeTTa,
  name: string,
  target: (...args: never[]) => unknown,
  options: { readonly effect?: EffectClass } = {},
): Defined {
  return surface.op(target, { name, effect: options.effect ?? "oracleIO" });
}

/**
 * Named methods of one object as operations, bound to it.
 *
 * ```ts
 * wrapObject(m, "db", connection, { execute: "db-query!", close: "db-close!" });
 * ```
 *
 * The map says which methods cross and what each is called, which is the
 * difference from {@link objectOps}: that door takes everything and derives
 * the names, this one takes exactly what is listed. The object itself lands in
 * the catalog as `(wrapped <name> <object>)`, so a rule can enumerate what is
 * wrapped rather than being told separately.
 */
export function wrapObject(
  surface: MeTTa,
  name: string,
  instance: object,
  methods: Readonly<Record<string, string>> | readonly string[],
  options: { readonly effects?: Readonly<Record<string, EffectClass>> } = {},
): Defined[] {
  const spelled: Record<string, string> =
    Array.isArray(methods)
      ? Object.fromEntries(methods.map((each) => [each, `${name}-${mettaName(each)}`]))
      : { ...(methods as Record<string, string>) };
  const installed: Defined[] = [];
  for (const [method, head] of Object.entries(spelled)) {
    const held = (instance as Record<string, unknown>)[method];
    if (typeof held !== "function") {
      throw new MettaError(`${instance.constructor.name} has no method ${method}`);
    }
    const bound = (held as (...args: unknown[]) => unknown).bind(instance);
    Object.defineProperty(bound, "length", { value: (held as { length: number }).length });
    installed.push(
      surface.op(bound as (...args: never[]) => unknown, {
        name: head,
        effect: options.effects?.[method] ?? "oracleIO",
      }),
    );
  }
  surface.catalog.add(expr(sym("wrapped"), sym(name), G(instance)));
  return installed;
}

/**
 * The groups a package advertises under, mirroring the provider ecosystem's
 * own convention: a third-party package names an integration, a space factory
 * or a directory of MeTTa sources, and the app loads BY NAME.
 *
 * Nothing auto-registers on import. Discovery answers names; loading stays the
 * app's explicit call, which is the same control the engine keeps on its side
 * of the seam.
 */
export const ENTRY_POINT_GROUP = "integrations";

/** Where a package advertises a space provider factory. */
export const SPACES_GROUP = "spaces";

/** Where a package advertises the directory of MeTTa sources it ships. */
export const LIBRARIES_GROUP = "libraries";

/** The three groups, for a caller enumerating them. */
export const GROUPS: readonly string[] = Object.freeze([
  ENTRY_POINT_GROUP,
  SPACES_GROUP,
  LIBRARIES_GROUP,
]);

/** One advertised name, UNLOADED. */
export interface EntryPoint {
  /** The name the app loads by. */
  readonly name: string;
  /** The package that advertises it. */
  readonly package: string;
  /** The module specifier, resolved against that package. */
  readonly specifier: string;
  /** Which export within it, or `default`. */
  readonly export: string;
}

/** The `metta` field of one package manifest, in either of its two forms. */
type MettaField = string | Partial<Record<string, string | Record<string, string>>>;

function manifestOf(at: string): { readonly metta?: MettaField } | undefined {
  try {
    return JSON.parse(readFileSync(at, "utf8")) as { readonly metta?: MettaField };
  } catch {
    return undefined;
  }
}

/**
 * Every name installed packages advertise for one group, UNLOADED.
 *
 * Asking imports nothing and registers nothing, so discovery is free to call
 * and the app keeps deciding what loads. A package advertises by carrying a
 * `metta` field naming, per group, the specifier for each name:
 *
 * ```json
 * {
 *   "metta": {
 *     "spaces": { "duck": "./dist/duck.js#createDuck" },
 *     "libraries": { "nars": "./metta" }
 *   }
 * }
 * ```
 *
 * A `#export` suffix picks the export; without one it is `default`.
 */
export function entryPoints(
  group: string = SPACES_GROUP,
  from: string = process.cwd(),
): Map<string, EntryPoint> {
  const root = manifestOf(join(from, "package.json"));
  if (root === undefined) throw new SourceNotFoundError(`no package.json at ${from}`);
  const found = new Map<string, EntryPoint>();
  const dependencies = Object.keys(
    (root as { dependencies?: Record<string, string> }).dependencies ?? {},
  );
  for (const owner of dependencies) {
    const theirs = manifestOf(join(from, "node_modules", owner, "package.json"));
    const field = theirs?.metta;
    if (field === undefined) continue;
    // The string form is the integration shorthand: one module, no names.
    const advertised =
      typeof field === "string"
        ? group === ENTRY_POINT_GROUP
          ? { [owner]: field }
          : undefined
        : field[group];
    if (advertised === undefined || typeof advertised === "string") continue;
    for (const [name, specifier] of Object.entries(advertised)) {
      const clash = found.get(name);
      if (clash !== undefined) {
        throw new NameError(
          `both ${clash.package} and ${owner} advertise ${name} under ${group}; ` +
            `advertised names must be unique`,
        );
      }
      const at = specifier.indexOf("#");
      found.set(name, {
        name,
        package: owner,
        specifier: at < 0 ? specifier : specifier.slice(0, at),
        export: at < 0 ? "default" : specifier.slice(at + 1),
      });
    }
  }
  return found;
}

/**
 * Load one advertised name, calling a callable target with the given arguments.
 *
 * ```ts
 * m.attach("&duck", await loadEntryPoint("duck"));
 * const sources = await loadEntryPoint("nars", { group: LIBRARIES_GROUP });
 * ```
 *
 * A `spaces` target is a provider class or factory; a `libraries` target
 * answers the directory of sources the package ships. A non-callable target
 * answers as it is, the module-level-instance form. An unknown name refuses,
 * listing what IS installed, so a typo reads as one.
 */
export async function loadEntryPoint(
  name: string,
  options: {
    readonly group?: string;
    readonly from?: string;
    readonly args?: readonly unknown[];
  } = {},
): Promise<unknown> {
  const from = options.from ?? process.cwd();
  const advertised = entryPoints(options.group ?? SPACES_GROUP, from);
  const entry = advertised.get(name);
  if (entry === undefined) {
    const known = [...advertised.keys()].sort().join(", ") || "none";
    throw new NameError(
      `no package advertises ${name} under ${options.group ?? SPACES_GROUP}; installed: ${known}`,
    );
  }
  const module = (await import(
    // A relative specifier resolves against the advertising package, which is
    // where the file it names actually is.
    entry.specifier.startsWith(".")
      ? pathToFileURL(join(from, "node_modules", entry.package, entry.specifier)).href
      : entry.specifier
  )) as Record<string, unknown>;
  const target = module[entry.export];
  if (target === undefined) {
    throw new NameError(`${entry.package} advertises ${name} but exports no ${entry.export}`);
  }
  if (typeof target !== "function") {
    if ((options.args ?? []).length > 0) {
      throw new MettaError(`${name} is not callable and takes no arguments`);
    }
    return target;
  }
  return (target as (...args: readonly unknown[]) => unknown)(...(options.args ?? []));
}

/** How one kind of host object lowers into facts. */
export type Reflector = (surface: MeTTa, name: string, target: object) => number;

const reflectors: { claims: (value: unknown) => boolean; lower: Reflector }[] = [];

/** Teach `reflect` how one kind of object lowers. Latest registration wins. */
export function registerReflector(claims: (value: unknown) => boolean, lower: Reflector): void {
  reflectors.push({ claims, lower });
}

/** Remove the latest reflector registered for those exact two functions. */
export function unregisterReflector(
  claims: (value: unknown) => boolean,
  lower: Reflector,
): boolean {
  for (let at = reflectors.length - 1; at >= 0; at -= 1) {
    const held = reflectors[at];
    if (held !== undefined && held.claims === claims && held.lower === lower) {
      reflectors.splice(at, 1);
      return true;
    }
  }
  return false;
}

/**
 * Lower an object's structure into facts, by whichever reflector claims it.
 *
 * The default claims a plain object and an array, writing one
 * `(field <name> <key> <value>)` per entry, so the common case needs no
 * registration. Answers how many facts it wrote.
 */
export function reflect(surface: MeTTa, name: string, target: object): number {
  for (let at = reflectors.length - 1; at >= 0; at -= 1) {
    const held = reflectors[at];
    if (held !== undefined && held.claims(target)) return held.lower(surface, name, target);
  }
  throw new MettaError(
    `no reflector claims ${target.constructor.name}; register one with registerReflector`,
  );
}

registerReflector(
  (value) => Array.isArray(value) || Object.getPrototypeOf(value as object) === Object.prototype,
  (surface, name, target) => {
    const entries = Array.isArray(target)
      ? target.map((each, at) => [String(at), each] as const)
      : Object.entries(target);
    for (const [key, held] of entries) {
      surface.catalog.add(expr(sym("field"), sym(name), sym(key), G(held)));
    }
    return entries.length;
  },
);

/**
 * The two operations that turn CALLING a host object into REASONING about one.
 *
 * `(js-attr $object $name)` reads one property and answers its value.
 * `(js-field $object $name)` is the same reading as a RELATION, answering a
 * `(name value)` pair: with the name bound it is a getter, and unbound it
 * enumerates the object's own fields, one answer per field. That second mode
 * is what a function cannot offer and a relation can, and it is the reason
 * this exists beside the ordinary operation door.
 */
export function installReflectionOps(surface: MeTTa): Defined[] {
  const attr = surface.op(
    function jsAttr(target: Atom, name: Atom): unknown {
      const held = (hostValue(target) as Record<string, unknown>)[fieldName(name)];
      return held === undefined ? null : held;
    } as (...args: never[]) => unknown,
    { name: "js-attr", effect: "readOnlyLookup", raw: true },
  );
  // A generator body IS the nondeterministic door: `op` installs it as `many`
  // and every yield is one answer. Raw, because the second mode is decided by
  // whether the name arrived BOUND, which only the atom can say.
  const field = surface.op(
    function* jsField(target: Atom, name: Atom): Generator<unknown> {
      const object = hostValue(target) as Record<string, unknown>;
      // Both modes answer the SAME shape, a `(name value)` pair, which is what
      // makes this one relation rather than two functions wearing one name.
      if (!(name instanceof Var)) {
        const asked = fieldName(name);
        const held = object[asked];
        if (held !== undefined) yield expr(sym(asked), G(held));
        return;
      }
      for (const [key, held] of Object.entries(object)) yield expr(sym(key), G(held));
    } as (...args: never[]) => unknown,
    { name: "js-field", effect: "nondeterministicReadOnly", raw: true },
  );
  return [attr, field];
}

/** A field name as written, whether it arrived as a symbol or as text. */
function fieldName(name: Atom): string {
  const held = hostValue(name);
  return typeof held === "string" ? held : String(name);
}

/** Write many atoms into a space at once. Answers how many. */
export function facts(surface: MeTTa, atoms: Iterable<Term>): number {
  const held = [...atoms];
  if (held.length > 0) surface.add(...held);
  return held.length;
}

/** One package that says it integrates with MeTTa. */
export interface Discovered {
  /** The package's name. */
  readonly name: string;
  /** The module specifier its `metta` field names. */
  readonly module: string;
  /** The integrations it must be installed after. */
  readonly requires: readonly string[];
}

/**
 * Every installed package that declares a MeTTa integration, in install order.
 *
 * A package says so by carrying a `metta` field in its `package.json` naming
 * the module to import, either directly or under `integrations`:
 *
 * ```json
 * { "name": "my-lib", "metta": "./dist/metta.js" }
 * { "name": "my-lib", "metta": { "integrations": "./dist/metta.js",
 *                                "requires": ["base-lib"] } }
 * ```
 *
 * Nothing is scanned and nothing is guessed: a package that says nothing is
 * not discovered, which is what keeps discovery from being a surprise. What a
 * package `requires` is installed before it, so a library built on another one
 * does not have to tell its users the right order by hand.
 */
export function discover(from: string = process.cwd()): Discovered[] {
  const root = manifestOf(join(from, "package.json"));
  if (root === undefined) throw new SourceNotFoundError(`no package.json at ${from}`);
  const found = new Map<string, Discovered>();
  for (const name of Object.keys(
    (root as { dependencies?: Record<string, string> }).dependencies ?? {},
  )) {
    // A dependency that is not installed, or has no manifest, simply does not
    // declare an integration.
    const field = manifestOf(join(from, "node_modules", name, "package.json"))?.metta;
    if (field === undefined) continue;
    const module =
      typeof field === "string" ? field : (field[ENTRY_POINT_GROUP] as string | undefined);
    if (typeof module !== "string") continue;
    const requires = typeof field === "string" ? [] : requirementsOf(field, name);
    found.set(name, { name, module, requires });
  }
  return installOrder(found);
}

/** The `requires` list of one manifest, checked to be a list of names. */
function requirementsOf(field: Exclude<MettaField, string>, owner: string): readonly string[] {
  const raw = (field as Record<string, unknown>)["requires"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.some((each) => typeof each !== "string")) {
    throw new MettaError(`${owner}'s metta.requires must be a list of integration names`);
  }
  return raw as readonly string[];
}

/**
 * Discovered packages in an order that installs each after what it requires.
 *
 * Kahn's algorithm, with the ready set taken in name order so the answer is
 * reproducible rather than dependent on which manifest was read first. A cycle
 * refuses and names the packages still waiting, because installing any of them
 * first would be a guess about which requirement was the wrong one.
 */
function installOrder(found: ReadonlyMap<string, Discovered>): Discovered[] {
  const waiting = new Map<string, Set<string>>();
  for (const [name, each] of found) {
    const unmet = new Set<string>();
    for (const required of each.requires) {
      if (!found.has(required)) {
        throw new MettaError(
          `${name} requires the integration ${required}, which no installed package advertises`,
        );
      }
      unmet.add(required);
    }
    waiting.set(name, unmet);
  }
  const ordered: Discovered[] = [];
  while (waiting.size > 0) {
    const ready = [...waiting].filter(([, unmet]) => unmet.size === 0).map(([name]) => name).sort();
    if (ready.length === 0) {
      throw new MettaError(
        `integrations require each other in a cycle: ${[...waiting.keys()].sort().join(", ")}`,
      );
    }
    for (const name of ready) {
      const held = found.get(name);
      if (held !== undefined) ordered.push(held);
      waiting.delete(name);
    }
    for (const unmet of waiting.values()) for (const name of ready) unmet.delete(name);
  }
  return ordered;
}

/** Every integration this engine has installed, as data. */
export function installed(surface: MeTTa): Promise<Atom[]> {
  return surface.catalog
    .match(expr(sym("integration"), sym("$name")), expr(sym("integration"), sym("$name")))
    .toArray();
}

/** Declare a fact about an integration, so a program can read what it provides. */
export function fact(surface: MeTTa, ...parts: readonly Term[]): Atom {
  const atom = expr(sym("integration-fact"), ...parts.map((part) => sym(String(part))));
  surface.catalog.add(atom);
  return atom;
}
