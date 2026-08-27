/**
 * Purpose: the one mechanical map between a TypeScript identifier and a MeTTa
 *   name, in both directions.
 * Assumes:
 *   - ruling 4 of `ai-typescript-design.md`: per surface, the HOST'S OWN
 *     casing convention maps to the meaning's hyphens. Python's convention is
 *     snake_case, so its map is underscore-to-hyphen; TypeScript's is
 *     camelCase, so its map is camelCase-to-hyphen.
 * Guarantees:
 *   - the map fires ONLY on a plain lowerCamelCase identifier, so it is
 *     idempotent on an already-hyphenated name and leaves every spelling that
 *     is not lowerCamelCase exactly alone
 *     [tested: "fires only where it can be right", "is idempotent,
 *     so the two doors meet at one atom"]
 *   - `mettaName(mettaName(x)) === mettaName(x)` for every x
 * Decides: a name that is not lowerCamelCase is EXACT. TypeScript spells a
 *   value or a function in lowerCamelCase and a type or a constructor in
 *   PascalCase; MeTTa spells an operation with hyphens and a type or
 *   constructor in CapWords. So the map is the correspondence between those
 *   two pairs of conventions, and a PascalCase name needs no translation
 *   because both languages already agree on it. Without that guard a naive
 *   camelCase map turns `StateMonad` into `state-monad` and `%Undefined%` into
 *   `%undefined%`, both of which name nothing.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

/**
 * A plain lowerCamelCase identifier: the one shape the map can act on without
 * risking a name it should have left alone.
 *
 * Anything with a hyphen, a bang, a question mark, a percent, an underscore or
 * a leading capital is already spelled the way it means to be spelled.
 */
const LOWER_CAMEL = /^[a-z][A-Za-z0-9]*$/;

/**
 * The MeTTa name a TypeScript identifier images to.
 *
 * `carAtom` is `car-atom`, `findDivisor` is `find-divisor`, `fib` is `fib`.
 * `Number`, `StateMonad`, `%Undefined%`, `prime?` and `change-state!` are all
 * themselves, because none of them is a lowerCamelCase identifier and each
 * already says what it means.
 *
 * A run of capitals stays one word, so `loadHTTPUrl` is `load-httpurl`; that is
 * the abbreviations-as-whole-words rule read back out, and the exact door is
 * there for a head the map cannot say.
 */
export function mettaName(identifier: string): string {
  if (!LOWER_CAMEL.test(identifier)) return identifier;
  return identifier.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The TypeScript identifier a MeTTa name images to: `car-atom` is `carAtom`. */
export function tsName(name: string): string {
  return name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Whether the map changes this identifier at all.
 *
 * A name the map leaves alone can be reached by either door, which is what
 * lets `S.parent` and `S["parent"]` be one atom while `S.carAtom` and
 * `S["car-atom"]` are also one atom and `S["carAtom"]` is a third one.
 */
export function mapsExactly(identifier: string): boolean {
  return mettaName(identifier) === identifier;
}
