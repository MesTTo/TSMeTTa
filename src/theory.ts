/**
 * Purpose: group equations as a class, so a theory is one unit a program
 *   loads, names and reads back.
 * Assumes:
 *   - a method's own `name` is the head, mapped through TypeScript's own
 *     casing, exactly as a free function's is
 * Guarantees:
 *   - `m.theory(Theory)` defines every own prototype method, so the class needs
 *     no decorator and works on any runtime
 *   - `@equation` and `@grounded` narrow that to the marked methods when a
 *     class also carries helpers
 * Decides: reflection is the floor and the decorators are the sugar above it.
 *   Stage-3 decorators reach methods and TypeScript compiles them, but V8 has
 *   not shipped them, so `node theory.ts` under type stripping rejects the
 *   syntax outright [measured 2026-08-27, Node 24.20.0]. A grouping form that
 *   only worked after a build would not be the grouping form of a library
 *   whose sources run.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { NameError, UnsupportedError } from "./errors.ts";

/** How a marked method is installed. */
export type Door = "define" | "op";

/** What one method of a theory declares about itself. */
export interface Marked {
  readonly door: Door;
  readonly name?: string;
}

/**
 * The marks a theory's own class carries.
 *
 * A `WeakMap` keyed by the prototype, rather than a property on it, so a
 * theory's own surface stays exactly the methods its author wrote.
 */
const marks = new WeakMap<object, Map<string, Marked>>();

/** Which door wins when two marks meet: `op` is its own, `define` is the rest. */
function stronger(left: Door, right: Door): Door {
  if (left === "op" || right === "op") return "op";
  return "define";
}

function mark(prototype: object, method: string, marked: Marked): void {
  let held = marks.get(prototype);
  if (held === undefined) {
    held = new Map<string, Marked>();
    marks.set(prototype, held);
  }
  // Marks COMPOSE, so `@tabled @equation fib()` is one definition the engine
  // tables rather than two definitions of one head, and an explicit name given
  // by either mark survives the other.
  const existing = held.get(method);
  const name = marked.name ?? existing?.name;
  held.set(method, {
    door: existing === undefined ? marked.door : stronger(existing.door, marked.door),
    ...(name === undefined ? {} : { name }),
  });
}

/** The decorator context a Stage-3 method decorator is handed. */
interface MethodContext {
  readonly kind: string;
  readonly name: string | symbol;
  addInitializer?: (initializer: () => void) => void;
}

function decorator(door: Door, name?: string) {
  return function decorate(
    target: (...args: never[]) => unknown,
    context: MethodContext,
  ): (...args: never[]) => unknown {
    if (context.kind !== "method") {
      throw new UnsupportedError(`only a method can be an ${door}, not a ${context.kind}`);
    }
    context.addInitializer?.(function initialize(this: object) {
      const prototype = Object.getPrototypeOf(this) as object;
      mark(prototype, String(context.name), name === undefined ? { door } : { door, name });
    });
    return target;
  };
}

/** Mark a method as an equation the engine holds. */
export const equation: ReturnType<typeof decorator> = decorator("define");

/** Mark a method as host code the engine calls. */
export const grounded: ReturnType<typeof decorator> = decorator("op");

/** Mark a method, and say the exact head it installs under. */
export function named(head: string, door: Door = "define"): ReturnType<typeof decorator> {
  return decorator(door, head);
}

/** A theory's constructor, as `m.theory` receives it. */
export type TheoryClass = new () => object;

/** What one method of a theory installs. */
export interface TheoryMethod {
  readonly method: string;
  readonly door: Door;
  readonly body: (...args: never[]) => unknown;
  readonly name?: string;
}

/**
 * Every method a theory installs, in declaration order.
 *
 * A class with no marks installs every own prototype method, which is the
 * convention; one WITH marks installs exactly the marked ones, which is the
 * opt-in for a class that also carries helpers.
 */
export function methodsOf(theory: TheoryClass): TheoryMethod[] {
  const prototype = theory.prototype as object;
  // Constructing once is what runs the decorators' initializers, which is
  // where a mark lands under the Stage-3 protocol.
  const instance = new theory();
  void instance;
  const marked = marks.get(prototype);
  const own = Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor");
  const chosen = marked === undefined ? own : own.filter((name) => marked.has(name));
  if (chosen.length === 0) {
    throw new NameError(
      `${theory.name} declares no methods to install; a theory is its equations`,
    );
  }
  return chosen.map((method) => {
    const body = (prototype as Record<string, unknown>)[method] as (...args: never[]) => unknown;
    const declared = marked?.get(method);
    return {
      method,
      door: declared?.door ?? "define",
      body,
      ...(declared?.name === undefined ? {} : { name: declared.name }),
    };
  });
}
