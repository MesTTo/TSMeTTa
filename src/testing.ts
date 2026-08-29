/**
 * Purpose: generate atoms, check properties over them, and hold a space
 *   implemented in TypeScript to the contract the engine expects of one.
 * Assumes:
 *   - a test wants REPRODUCIBILITY before it wants variety, so every generator
 *     is driven by a seeded pseudo-random source and a failing run reports the
 *     seed that produced it
 * Guarantees:
 *   - the same seed produces the same atoms, on every platform and every run,
 *     because the source is an arithmetic generator here rather than
 *     `Math.random` [tested: "generates the same atoms from the same seed"]
 *   - a failing property is SHRUNK before it is reported, so the counterexample
 *     is the smallest one the shrinker could reach rather than the first one
 *     the generator happened to produce
 *   - `checkSpaceProvider` exercises exactly the capabilities a provider
 *     claims, so a provider that implements four of the six is checked on four
 *     and refused on neither
 * Decides: no test-framework dependency. The property runner answers a RESULT
 *   rather than calling an assertion, so it works under `node:test`, under a
 *   runner this package has never heard of, and inside an ordinary program.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  G,
  Sym,
  type Term,
  expr,
  exprOf,
  substitute,
  sym,
  toAtom,
  variable,
} from "./atom.ts";
import { MettaError } from "./errors.ts";
import { Random } from "./random.ts";
import { type Bindings, alphaEqual, alphaKey, matchTerms, nameAnonymous } from "./matching.ts";
import type { Planner, SpaceProvider } from "./provider.ts";
import { capabilitiesOf } from "./provider.ts";
import type { Space } from "./space.ts";

/** The seeded source every generator here draws from. */
export { Random };

/**
 * Something that generates values, and knows how to make one smaller.
 *
 * The `fast-check` shape, at the size this package needs it: a generator and a
 * shrinker, so a counterexample is reported small.
 */
export interface Arbitrary<T> {
  /** One value, drawn from this source at this size. */
  generate(random: Random, size: number): T;
  /** Simpler values to try in place of one that failed. May be empty. */
  shrink?(value: T): Iterable<T>;
}

/** Always this value. */
export function constant<T>(value: T): Arbitrary<T> {
  return { generate: (): T => value };
}

/** One of these generators, uniformly. */
export function oneOf<T>(...sources: readonly Arbitrary<T>[]): Arbitrary<T> {
  return {
    generate: (random, size): T => random.pick(sources).generate(random, size),
    *shrink(value: T): Iterable<T> {
      for (const source of sources) yield* source.shrink?.(value) ?? [];
    },
  };
}

/** Each generated value through a transform. Shrinking follows the source. */
export function map<T, U>(source: Arbitrary<T>, transform: (value: T) => U): Arbitrary<U> {
  return { generate: (random, size): U => transform(source.generate(random, size)) };
}

/** An integer in a range, shrinking toward zero. */
export function integers(low = -100, high = 100): Arbitrary<number> {
  return {
    generate: (random): number => random.between(low, high),
    *shrink(value: number): Iterable<number> {
      if (value === 0) return;
      const toward = Math.trunc(value / 2);
      if (toward !== value) yield toward;
      if (value !== 0 && low <= 0 && high >= 0) yield 0;
    },
  };
}

const WORDS = [
  "ada",
  "bob",
  "cy",
  "edge",
  "node",
  "parent",
  "likes",
  "car-atom",
  "prime?",
  "Number",
  "%Undefined%",
] as const;

/** A MeTTa symbol, from a vocabulary that includes the awkward spellings. */
export function symbols(): Arbitrary<Atom> {
  return { generate: (random): Atom => sym(random.pick(WORDS)) };
}

/** A MeTTa variable. */
export function variables(): Arbitrary<Atom> {
  return { generate: (random): Atom => variable(random.pick(["x", "y", "z", "n", "_"])) };
}

/** A grounded number, integer or float. */
export function numbers(): Arbitrary<Atom> {
  return {
    generate: (random): Atom =>
      random.next() < 0.5 ? G(random.between(-1000, 1000)) : G(random.next() * 2000 - 1000),
  };
}

/** A grounded string. */
export function texts(): Arbitrary<Atom> {
  return {
    generate: (random): Atom =>
      G(random.pick(["", "a", "hello world", '"quoted"', "line\nbreak", "é中"])),
  };
}

/** A grounded boolean. */
export function booleans(): Arbitrary<Atom> {
  return { generate: (random): Atom => G(random.next() < 0.5) };
}

/** Any atom that is not an expression. */
export function groundAtoms(): Arbitrary<Atom> {
  return oneOf(symbols(), numbers(), texts(), booleans());
}

/** An expression of atoms, nested up to `size` deep. */
export function expressions(inner: Arbitrary<Atom> = groundAtoms()): Arbitrary<Atom> {
  const build = (random: Random, size: number): Atom => {
    if (size <= 0) return inner.generate(random, 0);
    const arity = random.between(0, 3);
    return exprOf(
      Array.from({ length: arity }, () =>
        random.next() < 0.4 ? build(random, size - 1) : inner.generate(random, size - 1),
      ),
    );
  };
  return { generate: build, shrink: shrinkAtom };
}

/** Any atom at all: ground, variable or expression. */
export function atoms(): Arbitrary<Atom> {
  return {
    generate: (random, size): Atom =>
      random.next() < 0.35
        ? expressions().generate(random, size)
        : oneOf(groundAtoms(), variables()).generate(random, size),
    shrink: shrinkAtom,
  };
}

/** An atom with variables in it: something to match WITH. */
export function patterns(): Arbitrary<Atom> {
  return {
    generate: (random, size): Atom =>
      expressions(oneOf(groundAtoms(), variables())).generate(random, Math.max(1, size)),
    shrink: shrinkAtom,
  };
}

/**
 * An instance of one pattern: its variables filled with ground atoms.
 *
 * The generator a matching test wants, because an instance is guaranteed to
 * match the pattern it came from and any failure is therefore the matcher's.
 */
export function fromPattern(pattern: Term): Arbitrary<Atom> {
  const built = toAtom(pattern);
  const ground = groundAtoms();
  return {
    generate: (random, size): Atom => fill(built, random, size, ground),
    shrink: shrinkAtom,
  };
}

function fill(atom: Atom, random: Random, size: number, ground: Arbitrary<Atom>): Atom {
  if (atom.kind === "variable") return ground.generate(random, size);
  if (atom instanceof Expression) {
    return exprOf(atom.items.map((item) => fill(item, random, size, ground)));
  }
  return atom;
}

/** Simpler atoms to try in place of one that failed. */
function* shrinkAtom(atom: Atom): Iterable<Atom> {
  if (!(atom instanceof Expression)) return;
  // A child in place of the whole, then the whole with one child dropped:
  // between them they reach every subterm and every shorter arity.
  yield* atom.items;
  for (let at = 0; at < atom.items.length; at += 1) {
    yield exprOf([...atom.items.slice(0, at), ...atom.items.slice(at + 1)]);
  }
}

/** What `forAll` reports. */
export type PropertyResult<T> =
  | { readonly ok: true; readonly runs: number; readonly seed: number }
  | {
      readonly ok: false;
      readonly runs: number;
      readonly seed: number;
      /** The smallest failing value the shrinker reached. */
      readonly counterexample: T;
      /** What the property raised, or `undefined` when it simply answered false. */
      readonly error: unknown;
    };

/** What `forAll` accepts. */
export interface PropertyOptions {
  /** How many values to try. A hundred, by default. */
  readonly runs?: number;
  /** The seed, so a failing run is reproducible. */
  readonly seed?: number;
  /** How deep a generated atom may nest. Three, by default. */
  readonly size?: number;
  /** How many shrink steps to take. A hundred, by default. */
  readonly shrinks?: number;
}

/**
 * Check a property over generated values.
 *
 * ```ts
 * const outcome = forAll(atoms(), (atom) => m.roundTrip(atom) === atom);
 * assert.ok(outcome.ok, `seed ${outcome.seed}: ${String(outcome.counterexample)}`);
 * ```
 *
 * The property answers `false` or throws; either is a failure, and the value
 * is shrunk before it is reported. Nothing is asserted here, so this composes
 * with whatever runner the caller uses.
 */
export function forAll<T>(
  source: Arbitrary<T>,
  property: (value: T) => boolean | void,
  options: PropertyOptions = {},
): PropertyResult<T> {
  const runs = options.runs ?? 100;
  const seed = options.seed ?? 1;
  const size = options.size ?? 3;
  const random = new Random(seed);
  for (let run = 0; run < runs; run += 1) {
    const value = source.generate(random, size);
    const failure = check(property, value);
    if (failure === undefined) continue;
    const smallest = shrinkTo(source, property, value, options.shrinks ?? 100);
    return {
      ok: false,
      runs: run + 1,
      seed,
      counterexample: smallest.value,
      error: smallest.error,
    };
  }
  return { ok: true, runs, seed };
}

function check<T>(
  property: (value: T) => boolean | void,
  value: T,
): { readonly error: unknown } | undefined {
  try {
    return property(value) === false ? { error: undefined } : undefined;
  } catch (error) {
    return { error };
  }
}

function shrinkTo<T>(
  source: Arbitrary<T>,
  property: (value: T) => boolean | void,
  start: T,
  budget: number,
): { value: T; error: unknown } {
  let value = start;
  let error = check(property, start)?.error;
  let left = budget;
  for (;;) {
    let improved = false;
    for (const candidate of source.shrink?.(value) ?? []) {
      if (left <= 0) return { value, error };
      left -= 1;
      const failure = check(property, candidate);
      if (failure === undefined) continue;
      value = candidate;
      error = failure.error;
      improved = true;
      break;
    }
    if (!improved) return { value, error };
  }
}

/** One check a conformance suite ran. */
export interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

/** What `checkSpaceProvider` accepts beyond the samples. */
export interface SpaceProviderCheckOptions {
  /**
   * Conjunctions to offer a planning provider, so its claim can be checked.
   *
   * A claim cannot be verified from a single pattern, and a planner's claim is
   * the one part of this seam the engine cannot re-check cheaply, so it has to
   * be given the shape of a real query.
   */
  readonly conjunctions?: readonly (readonly Term[])[];
}

/**
 * Hold a space implemented in TypeScript to the contract the engine expects.
 *
 * Exactly the capabilities a provider claims are exercised, so a read-only
 * provider is checked on its reads and asked nothing about writes. Every check
 * goes THROUGH the engine, because a provider that satisfies its own interface
 * and not the engine's is the failure this exists to catch.
 *
 * A provider that can write IS written to: the samples are added and stay, and
 * one probe of the suite's own is added and removed. Point it at a space you
 * are willing to have written.
 *
 * ```ts
 * const results = await checkSpaceProvider(m, "&table", table, [S.kv(S.ada, 3)]);
 * assert.ok(results.every((each) => each.ok));
 * ```
 */
export async function checkSpaceProvider(
  space: Space,
  provider: SpaceProvider,
  samples: readonly Term[],
  options: SpaceProviderCheckOptions = {},
): Promise<CheckResult[]> {
  const capabilities = new Set(capabilitiesOf(provider));
  const results: CheckResult[] = [];
  let probes = 0;
  const record = async (name: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error) });
    }
  };

  if (capabilities.has("enumerate")) {
    await record("enumeration answers through the engine", async () => {
      const held = await space.atoms().toArray();
      if (!held.every((atom) => atom instanceof Atom)) {
        throw new MettaError("enumeration answered something that is not an atom");
      }
    });
  }

  if (capabilities.has("match")) {
    await record("every stored atom matches itself", async () => {
      const held = await space.atoms().take(20).toArray();
      for (const atom of held) {
        if (!space.has(atom)) {
          throw new MettaError(`${atom.text} enumerates but does not match itself`);
        }
      }
    });
    await record("a pattern nothing matches answers nothing", async () => {
      const absent = expr(sym("$absent-shape-no-provider-holds"), G(Math.PI));
      if (space.has(absent)) throw new MettaError("a shape nothing holds answered a match");
    });
  }

  if (capabilities.has("add") && capabilities.has("match")) {
    await record("an added atom is found afterwards", async () => {
      for (const sample of samples) {
        space.add(sample);
        if (!space.has(sample)) {
          throw new MettaError(`${toAtom(sample).text} was added and does not match`);
        }
      }
    });
  }

  if (capabilities.has("remove") && capabilities.has("add")) {
    await record("a removed atom is gone afterwards", () => {
      // A probe of this suite's own, not one of the caller's samples: a space
      // is a MULTISET, so removing one copy of an atom the add check already
      // stored leaves the other copy answering, and the check would be reading
      // its own earlier write as a failure.
      probes += 1;
      const probe = expr(sym("$conformance-probe"), G(probes));
      space.add(probe);
      if (!space.has(probe)) throw new MettaError("a probe was added and does not match");
      space.delete(probe);
      if (space.has(probe)) {
        throw new MettaError(`${probe.text} was removed and still matches`);
      }
    });
  }

  if (capabilities.has("plan")) {
    const conjunctions = options.conjunctions ?? [];
    if (conjunctions.length === 0) {
      // Not silently skipped. A planner's claim is the one part of this seam
      // the engine cannot re-check cheaply, so a suite that quietly did not
      // check it would read as coverage it does not have.
      results.push({
        name: "the planner's claim is exact",
        ok: false,
        detail:
          "this provider declares plan and no conjunction was offered to check it against; " +
          "pass { conjunctions: [[patternA, patternB]] } so the claim can be verified",
      });
    }
    for (const [at, conjunction] of conjunctions.entries()) {
      await record(`the planner's claim is exact (conjunction ${String(at + 1)})`, async () => {
        const patterns = conjunction.map(toAtom);
        const claim = (provider as Planner).plan(patterns);
        // Declining is always correct, and is what a provider should do for a
        // conjunction it has no join for.
        if (claim === undefined) return;
        const claimed = claim.claimed.map((position) => patterns[position] as Atom);
        const held = await space.atoms().toArray();
        const expected = nestedLoopJoin(claimed, held);
        const answered = claim.rows.map((row) => row.map(toAtom));
        const key = (row: readonly Atom[]): string => row.map((atom) => alphaKey(atom)).join(" ");
        const wanted = expected.map(key).sort();
        const got = answered.map(key).sort();
        if (wanted.length !== got.length || wanted.some((each, index) => each !== got[index])) {
          throw new MettaError(
            `the claim is not exact: the same join over this space's own atoms has ` +
              `${String(wanted.length)} rows and the provider answered ${String(got.length)}. ` +
              `A claim means answering EXACTLY, because there is no cheap re-check for a join; ` +
              `a provider that cannot must decline`,
          );
        }
      });
    }
  }

  return results;
}

/**
 * The same join, computed by the slowest correct method there is.
 *
 * A planner claims that its own join answers exactly what the engine's split
 * would have. The only way to check that is to run the split, so this does:
 * one nested loop per pattern over everything the space holds, carrying the
 * bindings forward. It is the oracle, not the implementation.
 */
function nestedLoopJoin(patterns: readonly Atom[], held: readonly Atom[]): Atom[][] {
  let rows: { readonly row: Atom[]; readonly bound: Bindings }[] = [{ row: [], bound: {} }];
  for (const pattern of patterns) {
    const next: { readonly row: Atom[]; readonly bound: Bindings }[] = [];
    for (const { row, bound } of rows) {
      const asked = substitute(pattern, bound);
      for (const atom of held) {
        const taken = matchTerms(asked, atom);
        if (taken === undefined) continue;
        next.push({ row: [...row, atom], bound: { ...bound, ...taken } });
      }
    }
    rows = next;
  }
  return rows.map((each) => each.row);
}

/**
 * Hold any server to the remote-space protocol.
 *
 * The gateway suite: it speaks the wire rather than the TypeScript, so it
 * checks a server written in any language, including the reference ones this
 * repository ships. Every check is one the protocol page fixes, not one this
 * implementation happens to satisfy.
 *
 * ```ts
 * const results = await checkGateway(gateway.url, { space: "&served" });
 * assert.ok(results.every((each) => each.ok));
 * ```
 */
export async function checkGateway(
  url: string,
  options: { readonly space?: string; readonly token?: string } = {},
): Promise<CheckResult[]> {
  const { httpTransport } = await import("./remote.ts");
  const transport =
    options.token === undefined ? httpTransport(url) : httpTransport(url, { token: options.token });
  const space = options.space ?? "&self";
  const results: CheckResult[] = [];
  const record = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, detail: String(error) });
    }
  };

  await record("health names its protocol revision and capabilities", async () => {
    const health = await transport.health();
    if (health.ok !== true) throw new MettaError("health did not answer ok");
    if (!Number.isInteger(health.protocol)) throw new MettaError("health named no protocol");
    if (!Array.isArray(health.capabilities)) throw new MettaError("health named no capabilities");
    if (typeof health.bound !== "boolean") throw new MettaError("health did not say whether it bounds");
  });

  await record("atoms answers an array of wire atoms", async () => {
    const held = await transport.post("/atoms", { space });
    if (!Array.isArray(held["atoms"])) throw new MettaError("atoms answered no array");
  });

  await record("a cursor ends with a null cursor, never an empty live one", async () => {
    let chunk = await transport.post("/ask", {
      space,
      pattern: ["v", "everything"],
      batch: 2,
    });
    for (let pulls = 0; pulls < 64; pulls += 1) {
      const cursor = chunk["cursor"];
      if (cursor === null) return;
      if (typeof cursor !== "string") throw new MettaError("a cursor is a string or null");
      const atoms = chunk["atoms"];
      if (!Array.isArray(atoms)) throw new MettaError("a chunk carried no atoms array");
      if (atoms.length === 0) {
        throw new MettaError("an empty chunk beside a live cursor, which the protocol forbids");
      }
      chunk = await transport.post("/next", { cursor, batch: 2 });
    }
    throw new MettaError("the stream did not end within sixty-four pulls");
  });

  await record("stop is idempotent, because a finally-block calls it twice", async () => {
    const opened = await transport.post("/ask", { space, pattern: ["v", "everything"], batch: 1 });
    const cursor = opened["cursor"];
    if (typeof cursor !== "string") return;
    const first = await transport.post("/stop", { cursor });
    if (first["stopped"] !== true) throw new MettaError("the first stop did not stop it");
    const second = await transport.post("/stop", { cursor });
    if (second["stopped"] !== false) throw new MettaError("the second stop should answer false");
  });

  await record("a bad request is refused rather than answered", async () => {
    try {
      await transport.post("/nothing-like-this", {});
    } catch {
      return;
    }
    throw new MettaError("an unknown operation was answered rather than refused");
  });

  return results;
}

/**
 * Every atom in a corpus survives a round trip through the engine.
 *
 * The codec's own property, said once: decode what was encoded and the atom
 * that comes back is the atom that went in. Interning makes that comparison
 * `===`, so nothing here reimplements structural equality.
 *
 * One exception, and it is the codec's contract rather than a weakening. An
 * ANONYMOUS variable has no name to preserve: two `$_` are two DIFFERENT
 * variables, and the wire has to distinguish them, so each comes back under a
 * fresh name of the engine's. A term carrying one is therefore compared up to
 * alpha equivalence, which is exactly the property that survives.
 */
export function checkCodec(
  roundTrip: (atom: Atom) => Atom,
  corpus: Iterable<Term>,
): CheckResult[] {
  const results: CheckResult[] = [];
  for (const term of corpus) {
    const atom = toAtom(term);
    const anonymous = atom.text.includes("$_");
    try {
      const back = roundTrip(atom);
      const held = anonymous ? alphaEqual(back, nameAnonymous(atom)) : back === atom;
      results.push(
        held
          ? { name: atom.text, ok: true }
          : { name: atom.text, ok: false, detail: `came back as ${back.text}` },
      );
    } catch (error) {
      results.push({ name: atom.text, ok: false, detail: String(error) });
    }
  }
  return results;
}

/**
 * A corpus that covers every shape the codec has a tag for.
 *
 * The fixed cases first, because those are the ones a regression lands on, and
 * generated ones after, so a run covers shapes nobody thought to write down.
 */
export function codecCorpus(seed = 1, generated = 50): Atom[] {
  const fixed: Atom[] = [
    sym("a"),
    sym("car-atom"),
    variable("x"),
    G(0),
    G(-0),
    G(1),
    G(-1),
    G(2 ** 53),
    G(1.5),
    G(""),
    G("text"),
    G(true),
    G(false),
    expr(),
    expr(sym("f")),
    expr(sym("f"), G(1), variable("x")),
    expr(sym("f"), expr(sym("g"), G(2))),
  ];
  const random = new Random(seed);
  const source = atoms();
  for (let at = 0; at < generated; at += 1) fixed.push(source.generate(random, 3));
  return fixed;
}

/**
 * A generator of plausible identifiers, for a test that needs names.
 *
 * Deliberately awkward: it draws the hyphenated, the punctuated and the
 * capitalised spellings a MeTTa vocabulary really contains, so a test that
 * passes here has met the names a program will.
 */
export function names(): Arbitrary<string> {
  return {
    generate: (random): string => random.pick(WORDS),
  };
}

/**
 * Two implementations, held to the same answers.
 *
 * The DIFFERENTIAL: the strongest check there is for a rewrite, because it
 * needs no expected value at all. Answers are compared as multisets up to
 * alpha equivalence, which is the bar the engine itself is held to: order is
 * unspecified, and a variable's spelling is not part of an answer.
 */
export async function checkTwin<T>(
  cases: Iterable<T>,
  left: (subject: T) => Promise<readonly Term[]> | readonly Term[],
  right: (subject: T) => Promise<readonly Term[]> | readonly Term[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const subject of cases) {
    const name = String(subject);
    try {
      const [a, b] = await Promise.all([left(subject), right(subject)]);
      const key = (answers: readonly Term[]): string =>
        answers.map((answer) => alphaKey(toAtom(answer))).sort().join(" | ");
      const one = key(a);
      const other = key(b);
      results.push(
        one === other
          ? { name, ok: true }
          : { name, ok: false, detail: `left answered ${one}, right answered ${other}` },
      );
    } catch (error) {
      results.push({ name, ok: false, detail: String(error) });
    }
  }
  return results;
}

/** One recorded exchange: what was asked, and what it answered. */
export interface Recorded {
  readonly asked: string;
  readonly answered: readonly string[];
}

/**
 * Record what a set of asks answered, so a later run can be held to it.
 *
 * The half of a golden test that runs against the real thing. `checkReplay` is
 * the other half, and it needs no engine at all.
 */
export async function recordReplay(
  asks: Iterable<readonly [string, () => Promise<readonly Term[]> | readonly Term[]]>,
): Promise<Recorded[]> {
  const held: Recorded[] = [];
  for (const [asked, run] of asks) {
    const answered = await run();
    held.push({ asked, answered: answered.map((answer) => toAtom(answer).text) });
  }
  return held;
}

/** Hold a recording to what it recorded. */
export async function checkReplay(
  recording: Iterable<Recorded>,
  run: (asked: string) => Promise<readonly Term[]> | readonly Term[],
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  for (const { asked, answered } of recording) {
    try {
      const now = (await run(asked)).map((answer) => toAtom(answer).text);
      const same =
        now.length === answered.length && [...now].sort().join("|") === [...answered].sort().join("|");
      results.push(
        same
          ? { name: asked, ok: true }
          : { name: asked, ok: false, detail: `recorded ${answered.join(", ")}, now ${now.join(", ")}` },
      );
    } catch (error) {
      results.push({ name: asked, ok: false, detail: String(error) });
    }
  }
  return results;
}

/** What one measured stretch of work cost. */
export interface Spent {
  readonly inferences: number;
  readonly crossings: number;
  readonly replays: number;
}

/**
 * What one stretch of work cost, in the transport's own counters.
 *
 * The deltas around the block, so a caller measures a change rather than a
 * total. Instruction counts are NOT here: they need `perf`, which is a
 * platform tool rather than a language one, and the seat's own
 * `benchmarks/bench.sh` is where they are measured against committed pins.
 */
export async function measureCounters<T>(
  counters: Spent,
  work: () => Promise<T> | T,
): Promise<{ readonly value: T; readonly spent: Spent }> {
  const before = { ...counters };
  const value = await work();
  return {
    value,
    spent: {
      inferences: counters.inferences - before.inferences,
      crossings: counters.crossings - before.crossings,
      replays: counters.replays - before.replays,
    },
  };
}

/**
 * The engine-minted-handles law: a backend answers INTO spaces, never
 * fabricates one.
 *
 * Every `&`-headed name in a provider's answers has to be a space the engine
 * registered. A fabricated one is a reference nobody can resolve, cheap to
 * refuse here and expensive to chase after a program has stored it.
 *
 * ```ts
 * await checkMintedHandles(table, ["&table"]);
 * ```
 */
export async function checkMintedHandles(
  provider: SpaceProvider,
  registered: Iterable<string> = [],
): Promise<CheckResult[]> {
  const known = new Set(registered);
  const fabricated: string[] = [];
  const answers = provider.atoms?.() ?? [];
  const walk = (atom: Atom): void => {
    if (atom.kind === "space" || (atom instanceof Sym && atom.name.startsWith("&"))) {
      const name = atom.text;
      if (!known.has(name)) fabricated.push(name);
      return;
    }
    if (atom instanceof Expression) for (const item of atom.items) walk(item);
  };
  if (Symbol.asyncIterator in answers) {
    for await (const atom of answers as AsyncIterable<Term>) walk(toAtom(atom));
  } else {
    for (const atom of answers as Iterable<Term>) walk(toAtom(atom));
  }
  if (fabricated.length === 0) {
    return [{ name: "minted-handles", ok: true }];
  }
  return [
    {
      name: "minted-handles",
      ok: false,
      detail:
        `this provider's answers mention space identities the engine never minted: ` +
        `${[...new Set(fabricated)].sort().join(", ")}. A backend answers into spaces ` +
        `and the engine mints their identities; pass them in \`registered\` if they are real`,
    },
  ];
}

/** How many DISTINCT atoms a corpus holds, counting alpha-variants as one. */
export function countAtoms(corpus: Iterable<Term>): number {
  const seen = new Set<string>();
  for (const term of corpus) seen.add(alphaKey(toAtom(term)));
  return seen.size;
}
