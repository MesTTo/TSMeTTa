/**
 * Purpose: reader classes of the host's own — a full-token regex and the
 *   JavaScript function that turns a matching lexeme into an atom.
 * Assumes:
 *   - `library(pcre)` is present, which this build's own platform census
 *     reports; a build without it can register no class at all and the engine
 *     refuses at the registration door rather than at the parse
 * Guarantees:
 *   - the constructor never leaves this side: the engine keeps the pattern and
 *     a KEY, and hands the key back when the reader meets a matching lexeme
 *     [tested: "parses a lexeme of its own into whatever the host says"]
 *   - a later registration of the same pattern replaces the constructor, and
 *     only future parses read the new mapping, because an atom already
 *     returned is an immutable value [tested: "replaces a pattern's meaning"]
 * Decides: this is per ENGINE rather than per space. There is one reader, so a
 *   token class registered anywhere is one every space's source is read under,
 *   and pretending otherwise would be a scope nothing enforces.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { type Atom, type Term, toAtom } from "./atom.ts";
import type { Engine } from "./engine.ts";
import { CapabilityError, MettaError } from "./errors.ts";
import { hostValue } from "./space.ts";

/** What a reader class does with the lexeme it matched. */
export type TokenConstructor = (lexeme: string) => Term;

interface Registered {
  readonly construct: TokenConstructor;
  readonly key: string;
}

const registries = new WeakMap<Engine, Map<string, Registered>>();

/** The pattern as the engine keeps it: a string, whichever way it was written. */
function patternOf(pattern: string | RegExp): string {
  const source = typeof pattern === "string" ? pattern : pattern.source;
  if (source === "") throw new MettaError("a reader-token pattern cannot be empty");
  if (pattern instanceof RegExp && pattern.flags.replace(/[su]/g, "") !== "") {
    throw new MettaError(
      `a reader-token pattern carries no flags, and this one has ${pattern.flags}; ` +
        `the engine matches the WHOLE lexeme with its own settings`,
    );
  }
  return source;
}

function registryOf(engine: Engine): Map<string, Registered> {
  let held = registries.get(engine);
  if (held !== undefined) return held;
  held = new Map<string, Registered>();
  registries.set(engine, held);
  install(engine, held);
  return held;
}

function install(engine: Engine, registry: Map<string, Registered>): void {
  engine.provide({
    name: "$token-construct",
    arity: 0,
    kind: "raw_det",
    effect: "pureStructural",
    run: (args: readonly unknown[]): unknown => {
      const key = String(args[0]);
      // The RAW door hands atoms, so the lexeme is read as a value rather than
      // rendered: `String()` on a grounded string gives its printed form,
      // quotes and all, and `#ff8800` would arrive nine characters long.
      const held = hostValue(args[1] as Atom);
      const lexeme = typeof held === "string" ? held : String(args[1]);
      for (const held of registry.values()) {
        if (held.key === key) return toAtom(held.construct(lexeme));
      }
      throw new MettaError(`the reader asked ${key}, which no token class here answers`);
    },
  });
}

/**
 * Teach the reader one token class.
 *
 * ```ts
 * registerToken(m.engine, /#[0-9a-f]{6}/, (lexeme) => G(parseInt(lexeme.slice(1), 16)));
 * m.run("!(colour #ff8800)");        // the lexeme arrives as a number
 * ```
 *
 * The constructor receives the COMPLETE matched lexeme, quotes included for a
 * string token, and answers the atom the reader returns. Registering the same
 * pattern again replaces the constructor; atoms already parsed are values and
 * do not change.
 */
export function registerToken(
  engine: Engine,
  pattern: string | RegExp,
  construct: TokenConstructor,
): void {
  const source = patternOf(pattern);
  const registry = registryOf(engine);
  // The key is the pattern itself, so a replacement re-registers the same key
  // and the engine's own table does the replacing.
  const entry = { construct, key: `token:${source}` };
  try {
    engine.start(["token", source, entry.key]).sync();
  } catch (error) {
    // A build without library(pcre) refuses here rather than at a later parse,
    // which is where a reader that silently did not recognise a lexeme would
    // otherwise be diagnosed.
    throw new CapabilityError(
      `this build cannot compile a reader-token pattern: ${String(error)}`,
      { cause: error },
    );
  }
  registry.set(source, entry);
}

/** Forget one reader class. Answers whether one was there. */
export function unregisterToken(engine: Engine, pattern: string | RegExp): boolean {
  const source = patternOf(pattern);
  const registry = registries.get(engine);
  if (registry === undefined || !registry.has(source)) return false;
  engine.start(["untoken", source]).sync();
  registry.delete(source);
  return true;
}

/** Every reader class this engine holds, by pattern. */
export function tokens(engine: Engine): ReadonlyMap<string, TokenConstructor> {
  return new Map(
    [...(registries.get(engine) ?? [])].map(([source, held]) => [source, held.construct]),
  );
}

/** The atom a registered class would build for one lexeme, without parsing. */
export function construct(engine: Engine, pattern: string | RegExp, lexeme: string): Atom {
  const held = registries.get(engine)?.get(patternOf(pattern));
  if (held === undefined) {
    throw new MettaError(`no reader class is registered for ${patternOf(pattern)}`);
  }
  return toAtom(held.construct(lexeme));
}
