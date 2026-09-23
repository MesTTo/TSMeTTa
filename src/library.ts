/**
 * Purpose: the extension tier. A library installs in BOTH realms at once, the
 *   engine-side payload and the TypeScript-side surface, through one call.
 * Assumes:
 *   - core stays platform-neutral: nothing in it names any library's domain,
 *     and a capability arrives as a library rather than as a branch in the
 *     engine
 * Guarantees:
 *   - a library is DATA once it is loaded: `m.match(S.library(V.name))`
 *     enumerates what is here, its vocabulary and its declared capabilities
 *     included
 *   - a library DECLARES the capabilities it needs, so a restricted space
 *     refuses it by grant and the refusal names what was missing
 *   - a library that cannot find its own artifact refuses loudly, which is the
 *     law each MeTTa backend already follows: the backend decides whether its
 *     artifact is present, and absence is a fact rather than a silent skip
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { ATOM_OF, type Atom, type HasAtom, type Term, expr, sym, toAtom } from "./atom.ts";
import { CapabilityError } from "./errors.ts";
import type { SpaceCapability } from "./vocabularies.ts";

/** A library: one npm package, two realms. */
export interface Library {
  /** The name it is known by, and the name `(library ...)` records. */
  readonly name: string;
  /** Its version, recorded beside the name. */
  readonly version?: string;
  /** MeTTa source the engine loads when the library activates. */
  readonly source?: string;
  /** `.metta` files the engine loads, by absolute path. */
  readonly files?: readonly string[];
  /** The capabilities its operations need. A restricted space checks these. */
  readonly grants?: readonly SpaceCapability[];
  /** The vocabulary it declares, recorded so a program can read it back. */
  readonly vocabulary?: readonly string[];
  /**
   * Whether the library's own artifact is here.
   *
   * A library that rests on something outside the package (a WASM build, a
   * browser API, a native module) answers false when it is absent, and
   * activating it then refuses by name instead of failing later and elsewhere.
   */
  readonly present?: () => boolean;
  /** The TypeScript half: operations, definitions, whatever the surface needs. */
  readonly install?: (surface: LibraryHost) => void;
}

/** What a library's `install` is handed. Structural, so core names no class. */
export interface LibraryHost {
  op(target: (...args: never[]) => unknown, options?: Record<string, unknown>): unknown;
  define(target: (...args: never[]) => unknown, options?: Record<string, unknown>): unknown;
  run(source: string): unknown;
  loadFile(path: string): unknown;
  add(...atoms: readonly Term[]): unknown;
  readonly catalog: { add(...atoms: readonly Term[]): unknown };
}

/**
 * Activate a library.
 *
 * The engine-side payload lands first, so the TypeScript half can name what it
 * put there; the record of what is loaded lands last, so a half-activated
 * library never claims to be here.
 */
export function useLibrary(surface: LibraryHost, library: Library): void {
  if (library.present !== undefined && !library.present()) {
    throw new CapabilityError(
      `the library ${library.name} needs an artifact this deployment does not have; ` +
        `it refuses here rather than failing later somewhere else`,
    );
  }
  if (library.source !== undefined) surface.run(library.source);
  for (const file of library.files ?? []) surface.loadFile(file);
  library.install?.(surface);
  surface.catalog.add(
    expr(sym("library"), sym(library.name), toAtom(library.version ?? "0.0.0")),
    ...(library.grants ?? []).map((grant) =>
      expr(sym("library-grant"), sym(library.name), sym(grant)),
    ),
    ...(library.vocabulary ?? []).map((word) =>
      expr(sym("library-word"), sym(library.name), sym(word)),
    ),
  );
}

/**
 * A MeTTa library or module, named for `import!`: what `space.import` loads.
 *
 * It is also a term, the module form `import!` receives, so it drops into a
 * term wherever that form belongs.
 */
export interface LibraryRef extends HasAtom { readonly [ATOM_OF]: Atom; }

export class LibraryRef {
  /** The module form: `(library lib_x)`, `(library alias file)`, or a path. */
  readonly form: Atom;

  /** @internal Use {@link lib}. */
  constructor(form: Atom) {
    this.form = form;
    Object.defineProperty(this, ATOM_OF, { value: form });
  }

  toString(): string {
    return this.form.text;
  }
}

/** The shipped libraries by name, and the exact door for any other. */
export interface LibraryNamespace {
  /** `(library lib_<name>)`: `lib.spaces` is the shipped library `lib_spaces`. */
  readonly [name: string]: LibraryRef;
  /**
   * `(library name)` for a library outside the `lib_` family, and
   * `(library alias file)` for a file inside a registered library path.
   */
  (name: string, file?: string): LibraryRef;
}

/**
 * The shipped libraries, named as the engine's own `lib/` directory names them
 * less their family prefix: `lib.spaces` is `lib_spaces` and `lib.import` is
 * `lib_import`, since a property may be spelled with a reserved word.
 *
 * A library's name is a FILE name, so no casing map applies: `lib.pln2` is
 * `lib_pln2`. `lib("minimal_metta_lib")` names a library outside the family
 * exactly, and `lib("metta_fixture_lib", "fixture")` a file inside a library
 * path registered under that alias.
 */
export const lib: LibraryNamespace = new Proxy(
  (name: string, file?: string): LibraryRef =>
    new LibraryRef(
      file === undefined
        ? expr(sym("library"), sym(name))
        : expr(sym("library"), sym(name), sym(file)),
    ),
  {
    get(_target, key): unknown {
      // `then` would make the namespace thenable, as it would for S.
      return typeof key === "string" && key !== "then"
        ? new LibraryRef(expr(sym("library"), sym(`lib_${key}`)))
        : undefined;
    },
    has(_target, key): boolean {
      return typeof key === "string" && key !== "then";
    },
  },
) as unknown as LibraryNamespace;
