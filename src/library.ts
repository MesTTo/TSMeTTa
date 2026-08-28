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
 *     law each MeTTa Kernel backend already follows: the backend decides whether its
 *     artifact is present, and absence is a fact rather than a silent skip
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Term, expr, sym, toAtom } from "./atom.ts";
import { MettaError } from "./errors.ts";
import { type Grant } from "./space.ts";

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
  readonly grants?: readonly Grant[];
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
    throw new MettaError(
      `the library ${library.name} needs an artifact this deployment does not have; ` +
        `it refuses here rather than failing later somewhere else`,
      { code: "ERR_METTA_CAPABILITY" },
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
