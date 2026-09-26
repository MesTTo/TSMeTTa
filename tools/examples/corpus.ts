/**
 * Purpose: say what the mounted examples corpus holds: every MeTTa original
 *   under its examples/, the twin path each one derives, the hand-written
 *   programs, the seat's own chapter, the residue table, and the shape of the
 *   DIVERGENCE a twin may export.
 * Assumes: the working directory is the root of TSMeTTa-Examples as this seat
 *   mounts it at examples/, with the MeTTa corpus mounted at its own examples/,
 *   and every path here is relative to that root, which is the working
 *   directory of every program the lane runs.
 * Guarantees:
 *   - a twin's path is DERIVED from its original's, the same relative path
 *     with .ts, so there is one walker and the twin set cannot disagree with
 *     the corpus about what exists
 *   - a program whose file name is numbered is a twin, unless it is in the
 *     seat's own chapter, whose numbered programs have no originals; one whose
 *     name is not numbered is hand-written; `_fixtures/` directories hold
 *     inputs rather than programs, on both sides [tested 2026-09-26T17:54:50+10:00:
 *     tools/examples/lane.test.ts, "classifies a program by its path"]
 *   - a residue entry naming an example the corpus does not hold is refused
 *     when the table is read, so a stale row cannot sit unnoticed
 *   - a residue entry names its `!` forms as a non-empty list or none for the
 *     whole example, one form of one example has one entry, and an example
 *     covered whole has no other [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts,
 *     "refuses a residue table that says one thing twice or nothing at all"]
 *   - every original is twinned or covered whole, never both, and a twin
 *     mirrors an original [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "coverage"]
 *   - a DIVERGENCE a twin exports is read as exactly the fields a declaration
 *     has, each of its own type, and anything else is refused naming the twin
 *     [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "reads a twin's DIVERGENCE"]
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";

/** Where the MeTTa corpus is mounted, inside the examples corpus. */
export const ORIGINALS = "examples";

/**
 * The seat's own chapter: TypeScript programs about this seat at the seam,
 * which the MeTTa corpus holds no originals for. Its numbered programs run as
 * hand-written programs do.
 */
export const SEAT = "ch21-another-language-at-the-seam";

/** Every `.metta` original, relative to the corpus root, in reading order. */
export function originals(): string[] {
  return (readdirSync(ORIGINALS, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".metta") && !file.split("/").includes("_fixtures"))
    .map((file) => `${ORIGINALS}/${file}`)
    .toSorted();
}

/** The twin an original derives: the same relative path, as TypeScript. */
export function twinOf(original: string): string {
  return original.slice(ORIGINALS.length + 1).replace(/\.metta$/, ".ts");
}

/** The original a twin mirrors, which may not exist. */
export function originalOf(twin: string): string {
  return `${ORIGINALS}/${twin.replace(/\.ts$/, ".metta")}`;
}

/** The compiled program a source file runs as. */
export function compiled(source: string): string {
  return `dist/${source.replace(/\.ts$/, ".js")}`;
}

/** Every TypeScript program in the chapter folders, sorted, `_fixtures/` left out. */
export function programs(): string[] {
  return readdirSync(".")
    .filter((entry) => /^ch\d\d-/.test(entry))
    .flatMap((chapter) =>
      (readdirSync(chapter, { recursive: true }) as string[]).map((file) => `${chapter}/${file}`),
    )
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .filter((file) => !file.split("/").includes("_fixtures"))
    .toSorted();
}

/** Whether a program is a twin: numbered, and outside the seat's own chapter. */
export function isTwin(program: string): boolean {
  return /^\d+-/.test(program.split("/").at(-1) ?? "") && !program.startsWith(`${SEAT}/`);
}

/** A twin that says it cannot follow some or all of its original. */
export interface Residue {
  /**
   * `declined`: the twin cannot state these claims. `refused`: this build
   * cannot run the form, so the original is loaded without it and the twin
   * does not state it either. `friction`: the twin states them the long way
   * round.
   */
  readonly kind: "declined" | "refused" | "friction";
  /** The original, relative to the corpus root. */
  readonly example: string;
  /**
   * Which of the original's `!` forms, counting from 1, the entry is about.
   * Absent means the whole example, which then has no twin: declined, because
   * no twin could say it, or refused, because this build cannot run it.
   */
  readonly forms?: readonly number[];
  /** The TypeScript spelling that is missing. */
  readonly missing: string;
  /** The work that would make it exist. */
  readonly waits: string;
  /** What was tried and measured. */
  readonly detail: string;
}

/** A shape the original's own runs fill with different values: a clock reading, a draw. */
export interface VolatilePattern {
  /** The pattern as the lane prints it, `(modified $volatile0)`. */
  readonly pattern: string;
  /** Its portable transport JSON, which the lane rebuilds the pattern from. */
  readonly wire: string;
}

/** What a twin's DIVERGENCE export declares: its stored atoms differ from its original's on purpose. */
export interface Divergence {
  /** Atoms, as the engine prints them after alpha-renaming, that only the original stores, per space. */
  readonly originalOnly: Readonly<Record<string, readonly string[]>>;
  /** Atoms only the twin stores, per space. */
  readonly twinOnly: Readonly<Record<string, readonly string[]>>;
  /**
   * Per space, the volatile shapes a run once observed, owed only in shape from
   * then on, including in a run whose two original runs happened to store the
   * same reading, as two runs on a coarse clock often do.
   */
  readonly volatile?: Readonly<Record<string, readonly VolatilePattern[]>>;
  /** Why the difference is the right one. */
  readonly reason: string;
}

/** Whether a value is a record of string arrays, one per space. */
function spaces(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (atoms) => Array.isArray(atoms) && atoms.every((atom) => typeof atom === "string"),
    )
  );
}

/** Whether a value is a record of volatile shape arrays, one per space. */
function shapes(value: unknown): value is Record<string, VolatilePattern[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (declared) =>
        Array.isArray(declared) &&
        declared.every(
          (shape: unknown) =>
            typeof shape === "object" &&
            shape !== null &&
            Object.keys(shape).toSorted().join() === "pattern,wire" &&
            typeof (shape as Record<string, unknown>)["pattern"] === "string" &&
            typeof (shape as Record<string, unknown>)["wire"] === "string",
        ),
    )
  );
}

/**
 * A twin's DIVERGENCE export, checked: exactly `originalOnly`, `twinOnly`, an
 * optional `volatile` and a non-empty `reason`, each of its own type.
 */
export function checkedDivergence(value: unknown, twin: string): Divergence {
  const refuse = (why: string): never => {
    throw new Error(`${twin} exports a DIVERGENCE that ${why}`);
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("is not an object");
  }
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(
    (key) => !["originalOnly", "twinOnly", "volatile", "reason"].includes(key),
  );
  if (unknown.length > 0) refuse(`has fields no declaration has: ${unknown.join(", ")}`);
  const { originalOnly, twinOnly, volatile, reason } = fields;
  if (!spaces(originalOnly)) refuse("has no originalOnly of atom texts per space");
  if (!spaces(twinOnly)) refuse("has no twinOnly of atom texts per space");
  if (volatile !== undefined && !shapes(volatile)) {
    refuse("has a volatile that is not pattern and wire pairs per space");
  }
  if (typeof reason !== "string" || reason.trim() === "") refuse("states no reason");
  return fields as unknown as Divergence;
}

/** The residue table: what the twins cannot say yet, and what this build cannot run. */
export function residue(): Residue[] {
  const path = "residue.json";
  const schema = "tsmetta-twin-residue-1";
  if (!existsSync(path)) return [];
  const document = JSON.parse(readFileSync(path, "utf8")) as {
    schema: string;
    entries: Residue[];
  };
  if (document.schema !== schema) {
    throw new Error(`${path} declares schema ${document.schema}, and this lane reads ${schema}`);
  }
  const known = new Set(originals());
  for (const entry of document.entries) {
    if (!known.has(entry.example)) {
      throw new Error(
        `${path} names ${entry.example}, which the corpus at ${ORIGINALS}/ does not hold`,
      );
    }
  }
  return checkedResidue(document.entries);
}

/**
 * The residue table's own rules, apart from reading it. Each fact has one
 * entry: a form two entries name is either said twice or contradicted, and an
 * example covered whole has no twin for a per-form entry to be about.
 */
export function checkedResidue(entries: readonly Residue[]): Residue[] {
  const whole = new Map<string, Residue>();
  for (const entry of entries.filter(({ forms }) => forms === undefined)) {
    const earlier = whole.get(entry.example);
    if (earlier !== undefined)
      throw new Error(
        `residue.json has a ${earlier.kind} entry and a ${entry.kind} entry for the whole of ${entry.example}`,
      );
    whole.set(entry.example, entry);
  }
  const named = new Map<string, Residue>();
  for (const entry of entries) {
    const { example, forms } = entry;
    if (forms === undefined) continue;
    if (forms.length === 0 || !forms.every((at) => Number.isSafeInteger(at) && at >= 1))
      throw new Error(
        `residue.json names forms ${JSON.stringify(forms)} of ${example}; forms are ! forms counted from 1, and a list names at least one`,
      );
    const covering = whole.get(example);
    if (covering !== undefined)
      throw new Error(
        `residue.json covers ${example} whole in a ${covering.kind} entry and also has a ${entry.kind} entry for its forms ${forms.join(", ")}`,
      );
    for (const at of forms) {
      const key = `${example}#${String(at)}`;
      const earlier = named.get(key);
      if (earlier !== undefined)
        throw new Error(
          `residue.json names form ${String(at)} of ${example} in a ${earlier.kind} entry and again in a ${entry.kind} entry`,
        );
      named.set(key, entry);
    }
  }
  return [...entries];
}

/**
 * Every coverage finding for a corpus: an original with neither a twin nor a
 * residue entry covering it whole, one with both, and a twin that mirrors no
 * original.
 */
export function coverage(
  corpus: readonly string[],
  twins: readonly string[],
  wholly: ReadonlyMap<string, Residue>,
): string[] {
  const findings: string[] = [];
  const written = new Set(twins);
  for (const original of corpus) {
    const twin = twinOf(original);
    const whole = wholly.get(original);
    if (!written.has(twin) && whole === undefined) {
      findings.push(
        `${original}: no twin at ${twin} and no residue entry covering the whole example`,
      );
    }
    if (written.has(twin) && whole !== undefined) {
      findings.push(
        `${original}: residue.json's ${whole.kind} entry covers the whole example, and ${twin} exists`,
      );
    }
  }
  const derived = new Set(corpus.map(twinOf));
  for (const twin of twins) {
    if (!derived.has(twin)) findings.push(`${twin}: twins no original under ${ORIGINALS}/`);
  }
  return findings;
}
