/**
 * Purpose: one proof of one answer, as data. The equations that fired, the
 *   stored atoms they rested on, and the engine goals the walk could not see
 *   inside.
 * Assumes:
 *   - the engine hands the tree across as an ordinary MeTTa atom,
 *     `(derivation (answer Call Out) Step...)`, built by the meta-interpreter
 *     in `bridge.pl`
 * Guarantees:
 *   - a node is a DISCRIMINATED UNION on `kind`, so a `switch` over one is
 *     exhaustive and TypeScript proves it — which is what TypeScript has
 *     instead of the four dataclasses the Python side needs
 *     [tested: "reads a proof tree as a discriminated union"]
 *   - `facts` and `rules` are deduplicated in first-seen order, which is
 *     usually the part a reader wants first
 *   - `complete` is false exactly when a depth budget cut the walk short, so
 *     an empty answer set and a truncated proof never read alike
 * Decides: rendering renames only the MACHINE variable names a compiled
 *   equation carries (`$_121118`), and leaves a name the author wrote alone.
 *   The stored tree keeps the originals, so nothing downstream loses identity.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { Atom, Expression, Sym, Var, exprOf, mapTerm, variable } from "./atom.ts";
import { MettaError } from "./errors.ts";
import { alphaKey } from "./matching.ts";
import { showsAs } from "./present.ts";

/** One equation firing: the call it answered, and the equation it used. */
export interface Step {
  readonly kind: "step";
  /** The call, as it was made. */
  readonly call: Atom;
  /** What it answered. */
  readonly answer: Atom;
  /** The equation that fired, as the engine stored it. */
  readonly equation: Atom;
  /** The premises of that equation, each a proof of its own. */
  readonly children: readonly ProofNode[];
}

/** A stored atom the proof rests on, and the space holding it. */
export interface Fact {
  readonly kind: "fact";
  readonly space: string;
  readonly atom: Atom;
}

/** An engine-level goal the proof used, kept as the engine wrote it. */
export interface Builtin {
  readonly kind: "builtin";
  readonly text: string;
}

/** A finite proof budget ended before this goal was explained. */
export interface Truncated {
  readonly kind: "truncated";
  readonly text: string;
}

/** One node of a proof. Narrow it with a `switch` on `kind`. */
export type ProofNode = Step | Fact | Builtin | Truncated;

/**
 * One complete proof of one answer.
 *
 * ```ts
 * const [why] = await m.derivation(S.quad(3));
 * console.log(String(why));
 * for (const fact of why.facts) console.log(fact.space, String(fact.atom));
 * ```
 */
export class Derivation {
  /** The call this proof explains. */
  readonly call: Atom;
  /** What that call answered. */
  readonly answer: Atom;
  /** The steps, in the order they fired. */
  readonly children: readonly ProofNode[];

  /** @internal Built by {@link derivationOf}. */
  constructor(call: Atom, answer: Atom, children: readonly ProofNode[]) {
    this.call = call;
    this.answer = answer;
    this.children = children;
    Object.freeze(this);
  }

  /** Every stored atom the proof rests on, deduplicated in first-seen order. */
  get facts(): readonly Fact[] {
    const seen = new Map<string, Fact>();
    for (const node of walk(this.children)) {
      if (node.kind !== "fact") continue;
      const key = `${node.space} ${alphaKey(node.atom)}`;
      if (!seen.has(key)) seen.set(key, node);
    }
    return [...seen.values()];
  }

  /**
   * Every equation that fired, deduplicated in first-seen order.
   *
   * Deduplicated up to ALPHA equivalence, which is the answer a reader wants:
   * a compiled equation carries machine variable names, and the engine renames
   * per firing, so `(= (dbl $_1276) ...)` and `(= (dbl $_2314) ...)` are one
   * rule that fired twice. Keyed by text they would be two, and "which rules
   * did this use" would answer with the recursion depth.
   */
  get rules(): readonly Atom[] {
    const seen = new Map<string, Atom>();
    for (const node of walk(this.children)) {
      if (node.kind !== "step") continue;
      const key = alphaKey(node.equation);
      if (!seen.has(key)) seen.set(key, node.equation);
    }
    return [...seen.values()];
  }

  /** Every point where a finite depth stopped this walk. */
  get truncations(): readonly Truncated[] {
    return [...walk(this.children)].filter((node): node is Truncated => node.kind === "truncated");
  }

  /** Whether the tree explains the proof without a depth cutoff. */
  get complete(): boolean {
    return this.truncations.length === 0;
  }

  /** The whole proof, indented, with machine variable names made readable. */
  toString(): string {
    const lines = [`${this.call.text} = ${this.answer.text}`];
    for (const node of this.children) lines.push(render(node, 1));
    return lines.join("\n");
  }
}

showsAs(Derivation.prototype, (proof: Derivation) => proof.toString());

/** Every node under these, depth first. */
function* walk(nodes: readonly ProofNode[]): Generator<ProofNode> {
  for (const node of nodes) {
    yield node;
    if (node.kind === "step") yield* walk(node.children);
  }
}

function render(node: ProofNode, depth: number): string {
  const pad = "  ".repeat(depth);
  switch (node.kind) {
    case "step": {
      const lines = [
        `${pad}${node.call.text} = ${node.answer.text}`,
        `${pad}  by ${readable(node.equation).text}`,
      ];
      for (const child of node.children) lines.push(render(child, depth + 1));
      return lines.join("\n");
    }
    case "fact":
      return `${pad}fact ${node.atom.text}   [${node.space}]`;
    case "builtin":
      return `${pad}builtin ${node.text}`;
    case "truncated":
      return `${pad}truncated ${node.text}`;
  }
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/**
 * The same equation with readable variable names, for display only.
 *
 * A compiled equation carries machine names such as `$_121118`; this maps them
 * to `$a`, `$b`, ... in appearance order and leaves a name the author wrote
 * alone.
 */
export function readable(atom: Atom): Atom {
  const named = new Map<string, Var>();
  const rename = (node: Atom): Atom => {
    if (node instanceof Var) {
      if (!node.name.startsWith("_")) return node;
      let renamed = named.get(node.name);
      if (renamed === undefined) {
        const at = named.size;
        renamed = variable(at < LETTERS.length ? (LETTERS[at] as string) : `v${String(at)}`);
        named.set(node.name, renamed);
      }
      return renamed;
    }
    return node;
  };
  return mapTerm(atom, rename);
}

function headed(atom: Atom, name: string): atom is Expression {
  return (
    atom instanceof Expression &&
    atom.items.length > 0 &&
    atom.items[0] instanceof Sym &&
    (atom.items[0] as Sym).name === name
  );
}

/** Read one `(derivation (answer Call Out) Step...)` atom into a proof. */
export function derivationOf(tree: Atom): Derivation {
  if (!headed(tree, "derivation") || tree.items.length < 2) {
    throw new MettaError(
      `malformed derivation node ${tree.text}: expected (derivation (answer Call Out) Step...)`,
    );
  }
  const answer = tree.items[1] as Atom;
  if (!headed(answer, "answer") || answer.items.length !== 3) {
    throw new MettaError(
      `malformed answer node ${answer.text}: expected (answer Call Out)`,
    );
  }
  return new Derivation(
    answer.items[1] as Atom,
    answer.items[2] as Atom,
    tree.items.slice(2).map(nodeOf),
  );
}

function nodeOf(atom: Atom): ProofNode {
  if (headed(atom, "step")) return stepOf(atom);
  if (headed(atom, "fact")) return factOf(atom);
  if (headed(atom, "builtin")) return { kind: "builtin", text: textOf(atom, "builtin") };
  if (headed(atom, "truncated")) return { kind: "truncated", text: textOf(atom, "truncated") };
  throw new MettaError(
    `malformed derivation node ${atom.text}: expected step, fact, builtin or truncated`,
  );
}

function stepOf(node: Expression): Step {
  if (node.items.length < 3) {
    throw new MettaError(
      `malformed step node ${node.text}: expected (step (call Call Out) Equation Child...)`,
    );
  }
  const call = node.items[1] as Atom;
  if (!headed(call, "call") || call.items.length !== 3) {
    throw new MettaError(`malformed call node ${call.text}: expected (call Call Out)`);
  }
  return {
    kind: "step",
    call: call.items[1] as Atom,
    answer: call.items[2] as Atom,
    equation: node.items[2] as Atom,
    children: node.items.slice(3).map(nodeOf),
  };
}

function factOf(node: Expression): Fact {
  if (node.items.length !== 3) {
    throw new MettaError(`malformed fact node ${node.text}: expected (fact Space Atom)`);
  }
  const space = node.items[1] as Atom;
  return {
    kind: "fact",
    space: space instanceof Sym ? space.name : space.text,
    atom: node.items[2] as Atom,
  };
}

function textOf(node: Expression, what: string): string {
  if (node.items.length !== 2) {
    throw new MettaError(`malformed ${what} node ${node.text}: expected (${what} Text)`);
  }
  const payload = node.items[1] as Atom;
  const held = payload as { kind: string; value?: unknown };
  return held.kind === "grounded" ? String(held.value) : payload.text;
}
