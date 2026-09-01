/**
 * Purpose: the structural operations over atoms that need no engine at all —
 *   unification, one-way matching, alpha-canonical keys, and variable
 *   renaming.
 * Assumes:
 *   - atoms are interned, so `===` is structural equality and a `Set` or a
 *     `Map` keyed by an atom is a structural index with nothing reimplemented
 *   - a variable named `_` is ANONYMOUS: it matches anything, binds nothing,
 *     and two occurrences never constrain each other, which is the reader's
 *     own rule and Prolog's
 * Guarantees:
 *   - `unifyTerms` is symmetric: variables in either operand bind, and the
 *     substitution it answers is NORMALISED, so an alias chain `x = y, y = a`
 *     reports both names bound to `a`
 *     [tested: "normalises an alias chain"]
 *   - neither walk is recursive, so a term ten thousand deep is unified and
 *     resolved without a stack frame per level — the ceiling C26 and C27
 *     found in the pump and in `expr` is not reintroduced here
 *     [tested: "unifies a term ten thousand deep"]
 *   - `alphaKey` is equal for two terms that differ only in variable
 *     SPELLING, so an ordinary `Map` keyed by it is an alpha-invariant index
 *   - every legal variable name binds independently of Object.prototype
 *     [tested: "binds variable names inherited by Object.prototype"; commit=WORKTREE]
 * Decides: no occurs check, which is the engine's own behaviour and the Python
 *   host matcher's. A cyclic binding is therefore reachable, and the
 *   normalisation walk is written to stay finite when it meets one rather than
 *   to prevent one: an active-name set marks the cycle and the variable
 *   resolves to itself.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, type Term, Var, exprOf, mapTerm, toAtom, variable } from "./atom.ts";

/** One substitution: each bound variable's name mapped to the atom it took. */
export type Bindings = Readonly<Record<string, Atom>>;

/** The anonymous variable's spelling, which binds nothing wherever it appears. */
const ANONYMOUS = "_";

/**
 * Follow and compress an alias path, without entering an expression.
 *
 * The union-find move: `$x -> $y -> a` answers `a` and rewrites `$x` to point
 * straight at it, so a long chain is walked once. `seen` stops a cycle, which
 * is reachable because there is no occurs check.
 */
function walk(atom: Atom, bindings: Map<string, Atom>): Atom {
  const path: string[] = [];
  const seen = new Set<string>();
  let at = atom;
  for (;;) {
    if (!(at instanceof Var) || at.name === ANONYMOUS) break;
    const bound = bindings.get(at.name);
    if (bound === undefined || seen.has(at.name)) break;
    seen.add(at.name);
    path.push(at.name);
    at = bound;
  }
  if (!(at instanceof Var && seen.has(at.name))) {
    for (const name of path) bindings.set(name, at);
  }
  return at;
}

/**
 * Unify two terms symmetrically, or answer undefined.
 *
 * Robinson's work-list unifier, iterative rather than recursive. A variable in
 * EITHER operand binds, which is what makes this the symmetric door and
 * {@link matchTerms} the directional one.
 *
 * ```ts
 * unifyTerms(S.f(1, V.y), S.f(V.x, 2));   // { x: G(1), y: G(2) }
 * unifyTerms(S.f(1), S.g(1));             // undefined
 * ```
 */
export function unifyTerms(a: Term, b: Term): Bindings | undefined {
  const bindings = new Map<string, Atom>();
  const work: [Atom, Atom][] = [[toAtom(a), toAtom(b)]];
  while (work.length > 0) {
    const [rawLeft, rawRight] = work.pop() as [Atom, Atom];
    const left = walk(rawLeft, bindings);
    const right = walk(rawRight, bindings);
    if (left === right) continue;
    if (left instanceof Var) {
      if (left.name !== ANONYMOUS) bindings.set(left.name, right);
      continue;
    }
    if (right instanceof Var) {
      if (right.name !== ANONYMOUS) bindings.set(right.name, left);
      continue;
    }
    if (left instanceof Expression && right instanceof Expression) {
      if (!pushChildren(work, left, right)) return undefined;
      continue;
    }
    // Two ground atoms that are not the same object are not equal, because
    // interning made structural equality reference equality.
    return undefined;
  }
  return normalise(bindings);
}

/**
 * Match a PATTERN against a subject: only the pattern's variables bind.
 *
 * The directional door, and the one an index wants: a stored atom is data, so
 * a variable inside it is part of the datum rather than a hole to fill.
 *
 * ```ts
 * matchTerms(S.parent(V.x, S.bob), S.parent(S.tom, S.bob));  // { x: S.tom.atom }
 * matchTerms(S.parent(S.tom, V.y), S.parent(V.a, S.bob));    // undefined: $a is data
 * ```
 */
export function matchTerms(pattern: Term, subject: Term): Bindings | undefined {
  const bindings = new Map<string, Atom>();
  const work: [Atom, Atom][] = [[toAtom(pattern), toAtom(subject)]];
  while (work.length > 0) {
    const [left, right] = work.pop() as [Atom, Atom];
    if (left instanceof Var) {
      if (left.name === ANONYMOUS) continue;
      const held = bindings.get(left.name);
      if (held === undefined) bindings.set(left.name, right);
      else if (held !== right) return undefined;
      continue;
    }
    if (left instanceof Expression && right instanceof Expression) {
      if (!pushChildren(work, left, right)) return undefined;
      continue;
    }
    if (left !== right) return undefined;
  }
  return Object.fromEntries(bindings);
}

/**
 * Queue two expressions' children as pairs, or answer false on an arity clash.
 *
 * Pushed in REVERSE so the work list pops them left to right, which makes a
 * refusal name the leftmost mismatch — the one a reader looks at first.
 */
function pushChildren(work: [Atom, Atom][], left: Expression, right: Expression): boolean {
  if (left.items.length !== right.items.length) return false;
  for (let i = left.items.length - 1; i >= 0; i -= 1) {
    work.push([left.items[i] as Atom, right.items[i] as Atom]);
  }
  return true;
}

/** Whether two terms unify at all, without building the substitution. */
export function unifies(a: Term, b: Term): boolean {
  return unifyTerms(a, b) !== undefined;
}

/**
 * Resolve every binding transitively, without making depth a call stack.
 *
 * An explicit post-order walk: a variable already resolved is reused, one
 * currently being resolved is a cycle and stands for itself, and an expression
 * whose children did not change keeps its own identity because `exprOf`
 * interns.
 */
function normalise(bindings: Map<string, Atom>): Bindings {
  const resolved = new Map<string, Atom>();
  const out: Record<string, Atom> = {};
  for (const name of bindings.keys()) {
    if (!resolved.has(name)) resolveInto(name, bindings, resolved);
    out[name] = resolved.get(name) as Atom;
  }
  return out;
}

type Step = { readonly go: "visit"; readonly atom: Atom }
  | { readonly go: "leave"; readonly name: string }
  | { readonly go: "rebuild"; readonly atom: Expression };

function resolveInto(
  start: string,
  bindings: Map<string, Atom>,
  resolved: Map<string, Atom>,
): void {
  const active = new Set<string>([start]);
  const stack: Step[] = [
    { go: "leave", name: start },
    { go: "visit", atom: bindings.get(start) as Atom },
  ];
  const built: Atom[] = [];
  while (stack.length > 0) {
    const step = stack.pop() as Step;
    if (step.go === "leave") {
      resolved.set(step.name, built[built.length - 1] as Atom);
      active.delete(step.name);
      continue;
    }
    if (step.go === "rebuild") {
      const arity = step.atom.items.length;
      const children = built.splice(built.length - arity, arity);
      built.push(exprOf(children));
      continue;
    }
    const atom = step.atom;
    if (atom instanceof Var) {
      const already = resolved.get(atom.name);
      if (already !== undefined) {
        built.push(already);
      } else if (atom.name !== ANONYMOUS && bindings.has(atom.name) && !active.has(atom.name)) {
        active.add(atom.name);
        stack.push({ go: "leave", name: atom.name });
        stack.push({ go: "visit", atom: bindings.get(atom.name) as Atom });
      } else {
        built.push(atom);
      }
      continue;
    }
    if (atom instanceof Expression) {
      stack.push({ go: "rebuild", atom });
      for (let i = atom.items.length - 1; i >= 0; i -= 1) {
        stack.push({ go: "visit", atom: atom.items[i] as Atom });
      }
      continue;
    }
    built.push(atom);
  }
}

/**
 * Rename every variable by a function of its name.
 *
 * The hygiene primitive: a library that builds a pattern around a caller's term
 * renames its own variables out of the way rather than hoping the caller did
 * not use `$x`. `fresh()` is the door when only ONE variable is wanted.
 */
export function renameVariables(atom: Term, rename: (name: string) => string): Atom {
  const seen = new Map<string, Var>();
  // `mapTerm` walks the leaves left to right on an explicit worklist, which is
  // both what keeps first-appearance order right for {@link alphaCanonical}
  // and what keeps a deep term off the JavaScript stack.
  return mapTerm(toAtom(atom), (leaf: Atom): Atom => {
    if (!(leaf instanceof Var) || leaf.name === ANONYMOUS) return leaf;
    let renamed = seen.get(leaf.name);
    if (renamed === undefined) {
      renamed = variable(rename(leaf.name));
      seen.set(leaf.name, renamed);
    }
    return renamed;
  });
}

/**
 * The same term with its variables renamed to their first-appearance index.
 *
 * Two terms that differ only in variable SPELLING canonicalise to the same
 * atom, so ordinary interning makes them the same object and an ordinary `Map`
 * becomes an alpha-invariant index. That is what {@link alphaKey} and
 * `AlphaSet` are built on.
 */
export function alphaCanonical(atom: Term): Atom {
  let next = 0;
  const index = new Map<string, string>();
  return renameVariables(atom, (name) => {
    let spelling = index.get(name);
    if (spelling === undefined) {
      spelling = `_alpha${String(next)}`;
      next += 1;
      index.set(name, spelling);
    }
    return spelling;
  });
}

/**
 * The same term with each ANONYMOUS occurrence given a distinct name.
 *
 * `$_` is fresh at every occurrence, so `(f $_ $_)` names two different
 * variables — which means it cannot be compared up to alpha at all until each
 * one has a name to be renamed FROM. This is what gives them one.
 */
export function nameAnonymous(atom: Term): Atom {
  let next = 0;
  return mapTerm(toAtom(atom), (leaf: Atom): Atom => {
    if (!(leaf instanceof Var) || leaf.name !== ANONYMOUS) return leaf;
    next += 1;
    return variable(`_anon${String(next)}`);
  });
}

/** A key equal for two terms that differ only in variable spelling. */
export function alphaKey(atom: Term): string {
  return alphaCanonical(atom).text;
}

/** Whether two terms differ only in the spelling of their variables. */
export function alphaEqual(a: Term, b: Term): boolean {
  return alphaCanonical(a) === alphaCanonical(b);
}

/**
 * Whether a term has no variables at all.
 *
 * Ground is the property a cache, an index and a provider all key on: a ground
 * term is a value, and a term with a hole in it is a question.
 */
export function isGround(atom: Term): boolean {
  const work: Atom[] = [toAtom(atom)];
  while (work.length > 0) {
    const node = work.pop() as Atom;
    if (node instanceof Var) return false;
    // Pushed one at a time rather than spread: a spread becomes one ARGUMENT
    // per child and V8 raises past about 130,000 of them, which a collapse
    // over a long generator reaches [measured 2026-08-31; C27 is the same law].
    if (node instanceof Expression) {
      for (const item of node.items) work.push(item);
    }
  }
  return true;
}
