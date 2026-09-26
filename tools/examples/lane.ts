/**
 * Purpose: decide whether a twin agrees with its original, given the two
 *   sides' reports, so the decision is a pure function the tests can drive.
 * Guarantees:
 *   - each rule is one finding with the evidence in it: a failed side, too few
 *     assertions, a definition the original makes matchable and the twin does
 *     not, a twin that never asked the engine, and stored atoms that differ
 *     from the original's other than exactly as declared; a definition whose
 *     equations the twin's DIVERGENCE declares only the original stores is that
 *     declared difference, not a hidden one
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "agree"]
 *   - stored atoms compare as MULTISETS per space, so order is not an answer
 *     and a duplicate copy is
 *   - a declared divergence must match in both directions: a new difference,
 *     a changed one and a stale one over agreeing runs are each a finding
 *   - an original runs as written, less exactly the `!` forms residue.json
 *     says this build refuses, and its claims are the assert-family forms
 *     that remain; a refused form it does not have is an error, never a no-op
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "keeps an original's forms"]
 *   - a refused form that runs without error, at its own place and with the
 *     kept forms after it, is a finding, so an entry goes stale loudly the day
 *     the build learns to run it [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "agree: a
 *     refused form that now runs is stale"]
 *   - an original refused whole is walked form by form, each `!` form tried
 *     after the forms kept before it, and the claims that run there are
 *     reported with the forms that fail, which is the per-form refusal a
 *     stale whole entry becomes [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "walks an
 *     original refused whole"]
 *   - an atom the original itself stores differently in two runs, a clock
 *     reading or a draw, is owed only in shape: the twin must hold an instance
 *     of the two runs' least general generalization, and every other atom
 *     compares exactly [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "agree: an atom the
 *     original changes from run to run is owed only in shape"]
 *   - a shape a DIVERGENCE declares volatile is owed only in shape in every
 *     run, including one whose two original runs stored the same reading, and
 *     a declared shape the original no longer stores is a finding
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "agree: a declared volatile shape"]
 */
import {
  type Atom,
  Expression,
  type Form,
  Sym,
  atomFromWire,
  byCodePoint,
  exprOf,
  fromTransport,
  matchTerms,
  toTransport,
  transportFromJson,
  transportToJson,
  variable,
  wireFromAtom,
} from "tsmetta";
import type { Divergence, VolatilePattern } from "./corpus.ts";
import type { Report } from "./side.ts";

/** The heads that STATE A CLAIM in a MeTTa original: the assert family. */
export const ASSERT_HEADS = new Set([
  "test",
  "test-no-answer",
  "assert",
  "assertEqual",
  "assertAlphaEqual",
  "assertEqualToResult",
  "assertAlphaEqualToResult",
  "assertIncludes",
  "assertEqualMsg",
  "assertAlphaEqualMsg",
  "assertEqualToResultMsg",
  "assertAlphaEqualToResultMsg",
]);

/** Whether a form states a claim: a `!` form headed by the assert family. */
function claims(form: Form): boolean {
  const head = form.atom instanceof Expression ? form.atom.items[0] : undefined;
  return form.kind === "runnable" && head instanceof Sym && ASSERT_HEADS.has(head.name);
}

/** A form's source text, a `!` form regaining the bang the reader strips. */
function source(form: Form): string {
  return form.kind === "runnable" ? `!${form.text}` : form.text;
}

/**
 * The program an original runs as in this build, the claims it states, and
 * the forms it runs without.
 *
 * `refused` counts the `!` forms from 1, as residue.json does. Every form
 * keeps its source text, so what runs is the original minus exactly the
 * refused forms, and each of those comes back with its number and the kept
 * program around it, `before` and `after`, so a lane can ask whether it still
 * fails where it stands. Both halves are needed: a form that reads a file a
 * later form deletes runs in its place and fails after the whole program, and
 * a form that runs but leaves the engine refusing what follows, as this build
 * does after `(pragma! max-time 30)`, is not one the original can keep.
 * Time: O(n) forms, each `before` sharing the one prefix string built so far
 * and each `after` a suffix of the kept program.
 */
export function keptProgram(
  forms: readonly Form[],
  refused: ReadonlySet<number>,
): {
  readonly text: string;
  readonly claims: number;
  readonly dropped: readonly {
    readonly at: number;
    readonly text: string;
    readonly before: string;
    readonly after: string;
  }[];
} {
  const runnable = forms.filter((form) => form.kind === "runnable").length;
  const missing = [...refused].filter((at) => at < 1 || at > runnable);
  if (missing.length > 0) {
    throw new Error(
      `residue.json refuses form ${missing.join(", ")}, and the original has ${String(runnable)} ! forms`,
    );
  }
  const kept: Form[] = [];
  const cut: { at: number; text: string; before: string }[] = [];
  let before = "";
  let at = 0;
  for (const form of forms) {
    if (form.kind === "runnable" && refused.has((at += 1))) {
      cut.push({ at, text: source(form), before });
    } else {
      kept.push(form);
      before = before === "" ? source(form) : `${before}\n${source(form)}`;
    }
  }
  // The kept program is `before`, a newline, then `after`, for every cut.
  const dropped = cut.map(({ at: number, text, before: prefix }) => ({
    at: number,
    text,
    before: prefix,
    after: before.slice(prefix === "" ? 0 : prefix.length + 1),
  }));
  return { text: before, claims: kept.filter(claims).length, dropped };
}

/**
 * The claims of an original that run where they stand, and the `!` forms that
 * fail there, once every `!` form that fails is left out of what follows it.
 *
 * Each `!` form, counted from 1, is tried by `runs` after the forms kept so
 * far and kept when it loads; every other form is kept as written, as
 * `keptProgram` keeps it. A residue entry refusing the original whole says no
 * claim of it can be twinned, so a claim that runs here makes the entry stale,
 * and `fails` is then the per-form refusal that replaces it; a whole original
 * that loads is the case where nothing fails. Time: n calls of `runs` for n
 * `!` forms, the k-th given at most k - 1 kept `!` forms before its own.
 */
export async function walkForms(
  forms: readonly Form[],
  runs: (at: number, before: string, form: string) => Promise<boolean>,
): Promise<{ readonly claims: readonly number[]; readonly fails: readonly number[] }> {
  const running: number[] = [];
  const fails: number[] = [];
  let before = "";
  let at = 0;
  for (const form of forms) {
    const text = source(form);
    if (form.kind === "runnable") {
      at += 1;
      // One at a time, since each try loads what the tries before it kept.
      if (!(await runs(at, before, text))) {
        fails.push(at);
        continue;
      }
      if (claims(form)) running.push(at);
    }
    before = before === "" ? text : `${before}\n${text}`;
  }
  return { claims: running, fails };
}

/** The atoms `these` hold beyond `those`, duplicate copies kept. Time: O(|these| + |those|). */
export function surplus(these: readonly string[], those: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const atom of those) counts.set(atom, (counts.get(atom) ?? 0) + 1);
  const out: string[] = [];
  for (const atom of these) {
    const left = counts.get(atom) ?? 0;
    if (left > 0) counts.set(atom, left - 1);
    else out.push(atom);
  }
  return out;
}

/** Per space, what each side stored that the other did not. */
export interface Difference {
  readonly originalOnly: Record<string, string[]>;
  readonly twinOnly: Record<string, string[]>;
  /** Per space, the shapes the original's own runs filled with different values in this run. */
  readonly volatile: Record<string, VolatilePattern[]>;
}

/**
 * The least general generalization of two atoms: what they share, with a
 * variable wherever they differ and the same variable for the same pair of
 * differing parts, so `(at 1 1)` and `(at 2 2)` give `(at $volatile0
 * $volatile0)` [source 2026-09-26T18:00:56+10:00: G. D. Plotkin, "A Note on
 * Inductive Generalization", Machine Intelligence 5 (1970) 153-163,
 * https://homepages.inf.ed.ac.uk/gdp/publications/MI5_note_ind_gen.pdf].
 * Time: O(n) in the smaller atom's size.
 */
export function generalize(a: Atom, b: Atom): Atom {
  const slots = new Map<Atom, Map<Atom, Atom>>();
  let made = 0;
  const walk = (x: Atom, y: Atom): Atom => {
    if (x === y) return x;
    if (x instanceof Expression && y instanceof Expression && x.items.length === y.items.length) {
      return exprOf(x.items.map((item, at) => walk(item, y.items[at])));
    }
    const row = slots.get(x) ?? new Map<Atom, Atom>();
    slots.set(x, row);
    const known = row.get(y);
    if (known !== undefined) return known;
    const slot = variable(`volatile${String(made)}`);
    made += 1;
    row.set(y, slot);
    return slot;
  };
  return walk(a, b);
}

/** A stored atom's structure, rebuilt from its portable transport JSON. */
function structure(wire: string): Atom {
  return atomFromWire(fromTransport(transportFromJson(wire)));
}

/** A volatile shape as a DIVERGENCE keeps it: printed, and as transport JSON. */
function volatilePattern(atom: Atom): VolatilePattern {
  return { pattern: String(atom), wire: transportToJson(toTransport(wireFromAtom(atom))) };
}

/** A declared volatile shape's structure, refusing one whose text and wire disagree. */
function declaredShape({ pattern, wire }: VolatilePattern): Atom {
  const atom = structure(wire);
  if (String(atom) !== pattern) {
    throw new Error(
      `DIVERGENCE declares the volatile shape ${pattern}, and its wire reads ${String(atom)}`,
    );
  }
  return atom;
}

/** Whether a stored atom, given by its transport JSON, is an instance of a shape. */
function fits(shape: Atom, wire: string | undefined): boolean {
  return wire !== undefined && matchTerms(shape, structure(wire)) !== undefined;
}

/**
 * The volatile shapes to declare after a run: the ones declared before and the
 * ones this run told apart, one per printed pattern, per space. A shape stays
 * once seen, because a later run's two original runs can store the same
 * reading and so not tell it apart.
 */
export function mergeVolatile(
  earlier: Divergence["volatile"],
  observed: Readonly<Record<string, readonly VolatilePattern[]>>,
): Record<string, VolatilePattern[]> {
  const names = [...new Set([...Object.keys(earlier ?? {}), ...Object.keys(observed)])];
  return Object.fromEntries(
    names.toSorted(byCodePoint).map((name) => {
      const shapes = [...(earlier?.[name] ?? []), ...(observed[name] ?? [])];
      const unique = new Map(shapes.map((shape) => [shape.pattern, shape]));
      return [name, [...unique.values()].toSorted((x, y) => byCodePoint(x.pattern, y.pattern))];
    }),
  );
}

/**
 * The declared shapes a DIVERGENCE names for a space that the original
 * holds no instance of, which is a declaration gone stale.
 * Time: O(P*A), P declared shapes, A atoms the original stores in the space.
 */
export function staleVolatile(original: Report, declared?: Divergence["volatile"]): string[] {
  return Object.entries(declared ?? {}).flatMap(([name, shapes]) => {
    const wires = original.wires?.[name] ?? {};
    const held = original.spaces?.[name] ?? [];
    return shapes
      .filter((shape) => !held.some((text) => fits(declaredShape(shape), wires[text])))
      .map(({ pattern }) => `${name} ${pattern}`);
  });
}

/** A definition's `name/arity`, the key a `(= head body)` is matched back by. */
export function headKey(head: Atom): string {
  if (head instanceof Expression && head.items.length > 0) {
    return `${String(head.items[0])}/${String(head.items.length - 1)}`;
  }
  return `${String(head)}/0`;
}

/**
 * The heads of the equations a divergence declares only the original stores,
 * each rebuilt from the original's portable wires.
 *
 * Every equation for a head the twin leaves undefined is among the original's
 * atoms the twin lacks, and a divergence has to name that difference exactly,
 * so a head found here is one the declaration already accounts for, with its
 * reason. Time: O(d) for d declared atoms.
 */
function declaredHeads(original: Report, divergence: Divergence | undefined): Set<string> {
  const heads = new Set<string>();
  for (const [space, texts] of Object.entries(divergence?.originalOnly ?? {})) {
    for (const text of texts) {
      const wire = original.wires?.[space]?.[text];
      if (wire === undefined) continue;
      const atom = structure(wire);
      if (atom instanceof Expression && atom.items.length === 3 && String(atom.items[0]) === "=") {
        heads.add(headKey(atom.items[1]));
      }
    }
  }
  return heads;
}

/**
 * Per space, what each side stored that the other did not, setting aside
 * what the original itself stores differently from run to run.
 *
 * `again` is the original run a second time. An atom one of its runs stores
 * and the other does not is VOLATILE, a clock reading or a random draw no
 * twin can reproduce, so the twin owes it only in shape: the two runs'
 * versions pair up in text order, each pair generalizes to a pattern, and a
 * twin atom that is an instance of an unused pattern fills that slot. A space
 * whose two original runs disagree on how many atoms moved, or hold one the
 * transport cannot carry, compares exactly, as does every space without
 * `again`. A shape `declared` names for a space then pairs what is left: an
 * original atom and a twin atom that are both instances of it are the same
 * volatile atom, whether or not this run's two original runs told it apart.
 * Time: O(A + P*E) per space, A atoms, P volatile patterns, E twin extras.
 */
export function storedDifference(
  original: Report,
  twin: Report,
  again?: Report,
  declared?: Divergence["volatile"],
): Difference {
  const left = original.spaces ?? {};
  const right = twin.spaces ?? {};
  const originalOnly: Record<string, string[]> = {};
  const twinOnly: Record<string, string[]> = {};
  const volatile: Record<string, VolatilePattern[]> = {};
  for (const name of [...new Set([...Object.keys(left), ...Object.keys(right)])].toSorted(
    byCodePoint,
  )) {
    const mine = left[name] ?? [];
    const theirs = right[name] ?? [];
    const first = surplus(mine, again?.spaces?.[name] ?? mine).toSorted(byCodePoint);
    const second = surplus(again?.spaces?.[name] ?? mine, mine).toSorted(byCodePoint);
    const firstWires = original.wires?.[name] ?? {};
    const secondWires = again?.wires?.[name] ?? {};
    const shaped =
      first.length > 0 &&
      first.length === second.length &&
      first.every((text) => text in firstWires) &&
      second.every((text) => text in secondWires);
    const patterns = shaped
      ? first.map((text, at) =>
          generalize(structure(firstWires[text]), structure(secondWires[second[at]])),
        )
      : [];
    const core = shaped ? surplus(mine, first) : mine;
    const lacking = surplus(core, theirs);
    const extras = surplus(theirs, core);
    const twinWires = twin.wires?.[name] ?? {};
    const filled = new Set<number>();
    const unmatched: string[] = [];
    patterns.forEach((pattern, at) => {
      const slot = extras.findIndex((text, index) => {
        const wire = twinWires[text];
        return (
          !filled.has(index) &&
          wire !== undefined &&
          matchTerms(pattern, structure(wire)) !== undefined
        );
      });
      if (slot === -1) unmatched.push(first[at]);
      else filled.add(slot);
    });
    const a = [...lacking, ...unmatched];
    const b = extras.filter((_, index) => !filled.has(index));
    for (const shape of (declared?.[name] ?? []).map(declaredShape)) {
      for (;;) {
        const stored = a.findIndex((text) => fits(shape, firstWires[text]));
        const owed = b.findIndex((text) => fits(shape, twinWires[text]));
        if (stored === -1 || owed === -1) break;
        a.splice(stored, 1);
        b.splice(owed, 1);
      }
    }
    if (a.length > 0) originalOnly[name] = a.toSorted(byCodePoint);
    if (b.length > 0) twinOnly[name] = b.toSorted(byCodePoint);
    if (patterns.length > 0) {
      volatile[name] = patterns
        .map(volatilePattern)
        .toSorted((x, y) => byCodePoint(x.pattern, y.pattern));
    }
  }
  return { originalOnly, twinOnly, volatile };
}

function sameSpaces(
  seen: Readonly<Record<string, readonly string[]>>,
  said: Readonly<Record<string, readonly string[]>>,
): boolean {
  const keys = new Set([...Object.keys(seen), ...Object.keys(said)]);
  return [...keys].every((key) => {
    const a = (seen[key] ?? []).toSorted(byCodePoint);
    const b = (said[key] ?? []).toSorted(byCodePoint);
    return a.length === b.length && a.every((atom, at) => atom === b[at]);
  });
}

/** Everything wrong with one twin beside its original. */
export function agree(
  original: Report,
  twin: Report,
  options: {
    readonly declined: number;
    readonly idle: number;
    readonly divergence?: Divergence;
    /** The original run a second time, which tells a volatile atom from a stable one. */
    readonly again?: Report;
  },
): string[] {
  const findings: string[] = [];
  if (!original.ok)
    findings.push(`the original failed under tsmetta: ${original.error ?? "no error reported"}`);
  if (!twin.ok) findings.push(`the twin failed: ${twin.error ?? "no error reported"}`);
  if (!original.ok || !twin.ok) return findings;
  if (twin.exported !== true) findings.push("the twin does not export the engine it built as `m`");
  const runsNow = original.runsNow ?? [];
  if (runsNow.length > 0) {
    findings.push(
      `residue.json refuses form ${runsNow.join(", ")}, which now runs without error; delete it from its entry`,
    );
  }
  const owed = Math.max(0, original.claims - options.declined);
  if (twin.claims < owed) {
    findings.push(
      `the original states ${String(original.claims)} claims${options.declined > 0 ? `, ${String(options.declined)} declined,` : ""} ` +
        `and the twin asserted ${String(twin.claims)} times; a claim a twin cannot make is a residue entry, never a silent gap`,
    );
  }
  const defined = new Set(twin.heads ?? []);
  const declared = declaredHeads(original, options.divergence);
  const hidden = (original.heads ?? []).filter(
    (head) => !defined.has(head) && !head.includes("_Spec_") && !declared.has(head),
  );
  if (hidden.length > 0) {
    findings.push(
      `the twin's &self does not define ${hidden.join(" ")}, which the original makes matchable`,
    );
  }
  if ((twin.inferences ?? 0) <= options.idle) {
    findings.push(
      "the twin never asked the engine anything; a twin twins a program the engine runs",
    );
  }
  if (options.again?.ok === false) {
    findings.push(
      `the original failed when run a second time: ${options.again.error ?? "no error reported"}`,
    );
  }
  const stale = staleVolatile(original, options.divergence?.volatile);
  if (stale.length > 0) {
    findings.push(
      `DIVERGENCE declares volatile shapes the original no longer stores: ${stale.join(", ")}`,
    );
  }
  const { originalOnly, twinOnly } = storedDifference(
    original,
    twin,
    options.again,
    options.divergence?.volatile,
  );
  const differs = Object.keys(originalOnly).length > 0 || Object.keys(twinOnly).length > 0;
  const settled = options.divergence;
  if (settled === undefined && differs) {
    findings.push(
      `the two runs stored different atoms: original-only ${JSON.stringify(originalOnly)}, twin-only ${JSON.stringify(twinOnly)}`,
    );
  } else if (
    settled !== undefined &&
    !(sameSpaces(originalOnly, settled.originalOnly) && sameSpaces(twinOnly, settled.twinOnly))
  ) {
    findings.push(
      "the runs no longer differ the way DIVERGENCE declares: observed " +
        `original-only ${JSON.stringify(originalOnly)}, twin-only ${JSON.stringify(twinOnly)}`,
    );
  }
  return findings;
}
