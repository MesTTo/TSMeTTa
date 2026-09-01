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
 *   - marks compose on one method: `op` wins and an explicit name survives
 *     [tested: "composes equation, grounded, and named marks on one method";
 *     commit=WORKTREE]
 *   - discovery neither constructs the class nor evaluates accessors
 *     [tested: npm run build --silent && node --test
 *     --test-name-pattern='discovers decorated theory methods without constructing|skips accessors while discovering theory methods'
 *     build/test/extras.test.js; commit=fa5fec84a65958ff71483442cc76590b88cf1572]
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
 * A `WeakMap` keyed by the decorated function, rather than a property on its
 * prototype, so recording a decorator needs neither an instance nor a visible
 * addition to the theory's own surface.
 */
const marks = new WeakMap<Function, Marked>();

/** Which door wins when two marks meet: `op` is its own, `define` is the rest. */
function stronger(left: Door, right: Door): Door {
  if (left === "op" || right === "op") return "op";
  return "define";
}

function mark(method: Function, marked: Marked): void {
  // Marks COMPOSE, so `@grounded @named("fib-fast") fib()` is one host
  // operation under its exact name rather than two installations.
  const existing = marks.get(method);
  const name = marked.name ?? existing?.name;
  marks.set(method, {
    door: existing === undefined ? marked.door : stronger(existing.door, marked.door),
    ...(name === undefined ? {} : { name }),
  });
}

/** The decorator context a Stage-3 method decorator is handed. */
interface MethodContext {
  readonly kind: string;
  readonly name: string | symbol;
}

function decorator(door: Door, name?: string) {
  return function decorate<This, Args extends unknown[], Result>(
    target: (this: This, ...args: Args) => Result,
    context: MethodContext,
  ): (this: This, ...args: Args) => Result {
    if (context.kind !== "method") {
      throw new UnsupportedError(`only a method can be an ${door}, not a ${context.kind}`);
    }
    mark(target, name === undefined ? { door } : { door, name });
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

/** A theory class, inspected by its static prototype without constructing it. */
export interface TheoryClass {
  readonly name: string;
  readonly prototype: object;
}

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
  const own = Object.entries(Object.getOwnPropertyDescriptors(prototype)).flatMap(
    ([method, descriptor]) =>
      method !== "constructor" && typeof descriptor.value === "function"
        ? [{ method, body: descriptor.value as (...args: never[]) => unknown }]
        : [],
  );
  const marked = own.filter(({ body }) => marks.has(body));
  const chosen = marked.length === 0 ? own : marked;
  if (chosen.length === 0) {
    throw new NameError(
      `${theory.name} declares no methods to install; a theory is its equations`,
    );
  }
  return chosen.map(({ method, body }) => {
    const declared = marks.get(body);
    return {
      method,
      door: declared?.door ?? "define",
      body,
      ...(declared?.name === undefined ? {} : { name: declared.name }),
    };
  });
}
