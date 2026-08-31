/**
 * Purpose: the module tier. One lazily booted engine behind free functions, so
 *   the first program a reader writes needs no setup line at all.
 * Assumes:
 *   - booting is asynchronous here where it is synchronous in an embedded SWI,
 *     because the engine is WebAssembly and instantiating it is a promise
 * Guarantees:
 *   - importing this module boots NOTHING. The engine is created by the first
 *     verb that needs it, and a program that only builds terms never starts one
 *     [tested: "boots nothing until a verb needs the engine"]
 *   - an ask returned here is LAZY in the same way `m.match` is: the boot
 *     happens on the first pull, so `match(p)` is a description and
 *     `for await (... of match(p))` is the work
 *   - `reset()` disposes the engine and forgets it, so a test suite can start
 *     from nothing without a process boundary
 * Decides: the reduction door is `evaluate` here and `m.eval` on the surface.
 *   `eval` cannot be a module-level binding at all — ECMAScript refuses it as
 *   a declaration name in strict mode, which every module is — so the free
 *   function takes the nearest English word and the method keeps the engine's.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import type { Atom, Term } from "./atom.ts";
import { MettaError } from "./errors.ts";
import { Answers, type AskOptions, type Row } from "./answers.ts";
import type { Defined, DefineOptions, OpOptions } from "./define/define.ts";
import type { AnswerGroup, BootOptions, MeTTa } from "./metta.ts";
import { metta } from "./metta.ts";
import type { Space } from "./space.ts";

let held: Promise<MeTTa> | undefined;
let options: BootOptions = {};

/**
 * The process-wide engine, created on first use.
 *
 * ```ts
 * const m = await engine();
 * ```
 *
 * Every free function in this module goes through it, so a program that mixes
 * the two is talking to one engine.
 */
export function engine(): Promise<MeTTa> {
  if (held !== undefined) return held;
  // A boot that FAILS is forgotten. Remembering the rejected promise made
  // every later verb re-raise the first failure with no way back, because
  // `configure` then refused as "already booted" and `reset` awaited the same
  // rejection [measured 2026-08-31, see C48].
  const booting: Promise<MeTTa> = metta(options).catch((error: unknown) => {
    if (held === booting) held = undefined;
    throw error;
  });
  held = booting;
  return booting;
}

/**
 * Choose what the default engine will be booted with.
 *
 * Only before it exists: an engine already booted is not reconfigured, because
 * the mount is fixed at boot and pretending otherwise would be a lie.
 */
export function configure(boot: BootOptions): void {
  if (held !== undefined) {
    throw new MettaError("the default engine has already booted; call reset() first");
  }
  options = boot;
}

/** Dispose the default engine and forget it. The next verb boots a new one. */
export async function reset(): Promise<void> {
  const engineHeld = held;
  held = undefined;
  if (engineHeld === undefined) return;
  // A boot that failed has nothing to dispose, and re-raising its failure here
  // would leave a program that wanted to start over with no way to.
  const surface = await engineHeld.catch(() => undefined);
  surface?.dispose();
}

/**
 * An ask over an engine that may not exist yet.
 *
 * The boot happens inside the iterator's first `next()`, which is what keeps
 * the free functions as lazy as the methods they stand for.
 */
function deferred<T>(description: string, open: (surface: MeTTa) => Answers<T>): Answers<T> {
  return new Answers<T>(description, (signal) => {
    let inner: AsyncIterator<T> | undefined;
    const start = async (): Promise<AsyncIterator<T>> => {
      const surface = await engine();
      const ask = open(surface);
      return (signal === undefined ? ask : ask.until(signal))[Symbol.asyncIterator]();
    };
    return {
      async next(): Promise<IteratorResult<T>> {
        inner ??= await start();
        return inner.next();
      },
      async return(): Promise<IteratorResult<T>> {
        await inner?.return?.(undefined);
        return { done: true, value: undefined as never };
      },
    };
  });
}

/** The default engine's own space. */
export async function self(): Promise<Space> {
  return (await engine()).self;
}

/** The reflection space, where everything the engine knows about itself lives. */
export async function catalog(): Promise<Space> {
  return (await engine()).catalog;
}

/** A space by name in the default engine. */
export async function space(name: Term): Promise<Space> {
  return (await engine()).space(name);
}

/** Admit atoms into the default engine's own space. */
export async function add(...atoms: readonly Term[]): Promise<void> {
  (await engine()).add(...atoms);
}

/** Remove one atom from the default engine's own space. */
export async function remove(atom: Term): Promise<boolean> {
  return (await engine()).remove(atom);
}

/** Whether the default engine's own space holds an atom unifying with this. */
export async function has(pattern: Term): Promise<boolean> {
  return (await engine()).has(pattern);
}

/** The answers to a pattern in the default engine's own space. */
export function match(pattern: Term, askOptions: AskOptions = {}): Answers<Row> {
  return deferred<Row>(`match(${String(pattern)})`, (surface) =>
    surface.match(pattern, askOptions),
  );
}

/** Reduce a term in the default engine's own space. */
export function evaluate(term: Term, askOptions: AskOptions = {}): Answers<Atom> {
  return deferred<Atom>(`eval(${String(term)})`, (surface) => surface.eval(term, askOptions));
}

/** A source query, typed from its own text, in the default engine. */
export function q(source: string, askOptions: AskOptions = {}): Answers<Row> {
  return deferred<Row>(`q(${source})`, (surface) => surface.q(source, askOptions));
}

/** Run MeTTa source in the default engine. */
export async function run(source: string): Promise<AnswerGroup[]> {
  return (await engine()).run(source);
}

/** Load a `.metta` file into the default engine. */
export async function loadFile(path: string): Promise<AnswerGroup[]> {
  return (await engine()).loadFile(path);
}

/** Install a definition in the default engine. */
export async function define(
  target: (...args: never[]) => unknown,
  defineOptions: DefineOptions = {},
): Promise<Defined> {
  return (await engine()).define(target, defineOptions);
}

/** Register a host operation in the default engine. */
export async function op(
  target: (...args: never[]) => unknown,
  opOptions: OpOptions = {},
): Promise<Defined> {
  return (await engine()).op(target, opOptions);
}

/** One atom of MeTTa source, through the default engine's own reader. */
export async function parse(source: string): Promise<Atom> {
  return (await engine()).parse(source);
}

/** Every top-level form of some source, read but not evaluated. */
export async function forms(source: string): Promise<ReturnType<MeTTa["forms"]>> {
  return (await engine()).forms(source);
}

/** Why one answer holds: its first proof, or nothing. */
export async function why(target: Term): Promise<ReturnType<MeTTa["why"]>> {
  return (await engine()).why(target);
}
