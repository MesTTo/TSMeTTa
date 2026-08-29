/**
 * Purpose: install Node's own presentation hook on a class, so a handle prints
 *   as what it IS rather than as a dump of its private fields.
 * Assumes:
 *   - `util.inspect.custom` is what `console.log` consults, and a `#private`
 *     field is invisible to it, so a class with only private state prints as
 *     `Space {}` unless it says otherwise
 *     [source: https://nodejs.org/api/util.html#utilinspectcustom]
 * Guarantees:
 *   - the hook is non-enumerable, so it never appears in a `for...in`, in
 *     `Object.keys`, or in a structured clone of a plain object built from one
 *   - installing it twice on one prototype is a refusal rather than a silent
 *     overwrite, because two renderings of one class is a defect
 * Decides: the hook is installed on the PROTOTYPE from module scope rather than
 *   declared as a class member, because `--isolatedDeclarations` refuses a
 *   computed member name it cannot resolve to a late-bound symbol, and
 *   `inspect.custom` is a property access. It is not part of the typed surface
 *   either way: it is the runtime's own presentation door.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { inspect } from "node:util";

/**
 * Make instances of a class print as `render(instance)`.
 *
 * ```ts
 * class Space { ... }
 * showsAs(Space.prototype, (space: Space) => `Space(${space.name})`);
 * ```
 *
 * The renderer receives the instance and answers one line. Depth and options
 * are deliberately not passed through: every handle in this package prints as
 * a single self-describing line, and a handle that needed nesting would be a
 * data structure rather than a handle.
 */
export function showsAs<T extends object>(
  prototype: T,
  render: (value: T) => string,
): void {
  Object.defineProperty(prototype, inspect.custom, {
    value: function present(this: T): string {
      return render(this);
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });
}
