/**
 * Purpose: run ONE side of a comparison in its own process and write what it
 *   did as JSON: a MeTTa original through the engine's own loader, less the
 *   forms this build refuses; an original residue.json refuses whole, walked
 *   for the claims that run; or a TypeScript program with every
 *   `node:assert/strict` call counted and its DIVERGENCE export read.
 * Assumes: it is started by run.ts with the corpus root as root.ts presents
 *   it as working directory, as
 *   `node side.js <original|whole|program> <path> <report> [refused]`, the
 *   refused `!` forms counted from 1 and comma-separated, with TSMETTA_BUILD
 *   naming the tsmetta build installed in the corpus, which this module and
 *   the program both import, and TSMETTA_ORIGINALS the digest of the MeTTa
 *   corpus at that root's examples/.
 * Guarantees:
 *   - the report is written for success and for failure alike, so a side that
 *     throws still says what it threw, and the exit status is nonzero exactly
 *     when the side failed; a program that ends the process itself, as a
 *     guarded import does when its package is missing, still leaves a report
 *     carrying the status it exited with
 *   - a program's claims are the assertions it EXECUTED, read after its module
 *     finished evaluating, so an assertion inside a loop counts once per pass
 *     and one that never ran does not count
 *   - a program's DIVERGENCE export is reported as corpus.ts's
 *     checkedDivergence reads it, and one it refuses fails the side
 *   - stored content is every atom of every space the run registered except
 *     the engine's own `&metta` and `&catalogs`, each atom alpha-renamed before
 *     it is printed, so two runs that stored the same atoms under different
 *     variable names report the same text, and each also as portable
 *     transport JSON, so its structure is readable without an engine
 *   - the defined heads are the `name/arity` of every `(= head body)` in
 *     `&self`, which is what a later `match` can see
 *   - an original's refused forms are each tried after its stored atoms are
 *     read, and a form reported as `runsNow` ran without error in an engine
 *     that loaded the kept program with that one form restored at its own
 *     place, so another refused form's partial work can neither make it look
 *     runnable nor hide that it is, a later kept form cannot undo what it
 *     needs, and a form that runs but leaves the engine refusing what follows
 *     is not reported as runnable; each verdict is kept under a key of the
 *     tsmetta build's integrity, the MeTTa corpus's digest, this runner's
 *     compiled source, the original, the kept forms around it and the form
 *   - an original refused whole reports `ok` exactly when it loads, and when
 *     it does not, `runsNow` and `failsNow` from lane.ts's `walkForms`,
 *     each form tried and kept the same way and under the same key
 * Owns resources: the engine the original is loaded into, disposed before exit;
 *   one fresh engine per form tried whose verdict is not kept, disposed after
 *   its try; a refused original's staged copy beside it, and one per form
 *   tried, each removed however its load ends; the verdict files in verdicts/
 *   beside this module, which persist by design; a program's own engine is its
 *   own, read and then disposed here.
 */
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Atom,
  type Form,
  type MeTTa,
  S,
  V,
  WireError,
  alphaCanonical,
  byCodePoint,
  metta,
  toTransport,
  transportToJson,
  wireFromAtom,
} from "tsmetta";
import { type Divergence, checkedDivergence } from "./corpus.ts";
import { headKey, keptProgram, walkForms } from "./lane.ts";

/** The spaces every engine registers for itself, which no program authors. */
const ENGINE_SPACES = new Set(["&metta", "&catalogs"]);

/**
 * Where a refused form's verdict is kept, keyed by everything that decides it.
 * Beside this compiled module, in the corpus's node_modules/.cache where the
 * lane is built; `npm ci` there removes them with the lane, which makes a cold
 * cache and never a wrong verdict, since the key names the build.
 */
const VERDICTS = fileURLToPath(new URL("./verdicts/", import.meta.url));

/** What tools/examples.mjs names in VARIABLE, which a refusal verdict cannot be kept without. */
function named(variable: string, what: string): string {
  const value = process.env[variable];
  if (value === undefined || value === "") {
    throw new Error(
      `${variable} names no ${what}, so a refusal verdict has none to belong to; run the lane through tools/examples.mjs, which names both`,
    );
  }
  return value;
}

/**
 * What a refusal verdict depends on besides the original itself: the tsmetta
 * build installed, named by the integrity of the archive npm packed it into;
 * the MeTTa corpus the run was given, named by the digest root.ts took of
 * every original and fixture in it as it stood, committed or not; and this
 * runner's own compiled source. A change to any of them asks every form
 * again.
 */
function verdictBasis(): string {
  return JSON.stringify([
    named("TSMETTA_BUILD", "tsmetta build"),
    named("TSMETTA_ORIGINALS", "MeTTa corpus digest"),
    readFileSync(new URL(import.meta.url), "utf8"),
  ]);
}

/** What one side did. */
export interface Report {
  readonly ok: boolean;
  readonly error?: string;
  /** Claims: an original's assert-family `!` forms, or a program's executed assertions. */
  readonly claims: number;
  /** Whether a program exported the engine it built as `m`. */
  readonly exported?: boolean;
  /** `name/arity` of every equation head in `&self`. */
  readonly heads?: readonly string[];
  /** Every authored space's atoms, alpha-renamed and printed, sorted. */
  readonly spaces?: Readonly<Record<string, readonly string[]>>;
  /**
   * Per space, each stored atom's structure as portable transport JSON, keyed
   * by its text in `spaces`, so a reader rebuilds it without an engine. An
   * atom the portable transport has no tag for, such as a live host value,
   * has no entry.
   */
  readonly wires?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Engine inferences the side spent, boot included. */
  readonly inferences?: number;
  /**
   * An original's refused `!` forms that run without error where they stand;
   * for an original refused whole, the claims that do.
   */
  readonly runsNow?: readonly number[];
  /** For an original refused whole, the `!` forms that fail where they stand. */
  readonly failsNow?: readonly number[];
  /** The difference a program's DIVERGENCE export declares from its original. */
  readonly divergence?: Divergence;
  /** The status a program ended its own process with, before its module finished. */
  readonly exited?: number;
}

/** An atom as portable transport JSON, or nothing where the transport has no tag for it. */
function portable(atom: Atom): string | undefined {
  try {
    return transportToJson(toTransport(wireFromAtom(atom)));
  } catch (error) {
    if (error instanceof WireError) return undefined;
    throw error;
  }
}

async function stored(
  m: MeTTa,
): Promise<Pick<Report, "heads" | "spaces" | "wires" | "inferences">> {
  // Read before this function asks anything, so the reading prices the side's
  // own work and not the queries that describe it.
  const inferences = m.counters.inferences;
  const heads = new Set<string>();
  for (const head of await m.match(S["="](V.head, V.body), V.head)) heads.add(headKey(head));
  const spaces: Record<string, string[]> = {};
  const wires: Record<string, Record<string, string>> = {};
  for (const identity of m.spaces()) {
    const name = String(identity);
    if (ENGINE_SPACES.has(name)) continue;
    const atoms = (await m.space(identity).atoms()).map((atom) => alphaCanonical(atom));
    spaces[name] = atoms.map(String).toSorted(byCodePoint);
    wires[name] = Object.fromEntries(
      atoms.flatMap((atom) => {
        const wire = portable(atom);
        return wire === undefined ? [] : [[String(atom), wire]];
      }),
    );
  }
  return { heads: [...heads].toSorted(byCodePoint), spaces, wires, inferences };
}

/**
 * A hidden sibling of an original, so every path a staged copy names resolves
 * as the original's own would.
 */
function stage(path: string, tag: string): string {
  return `${dirname(path)}/.lane-${String(process.pid)}${tag}-${basename(path)}`;
}

/**
 * Whether one `!` form of an original, restored at its own place between
 * `before` and `after`, the kept forms around it, loads without error in a
 * fresh engine.
 *
 * The form is tried at its own place and nowhere else, in a fresh engine. A
 * form that fails can do part of its work first, creating a directory or
 * deleting one, and in a shared engine that part would let a later form run
 * or make it fail; a kept form after it can undo what it needs, as a closing
 * `delete-file!` does for every read of the file before it, which running it
 * in place rules out; and a form can run and still leave the engine refusing
 * what follows, as this build does after `(pragma! max-time 30)`, which only
 * the kept forms after it reveal. A walk passes no `after`, since it is still
 * deciding what the kept forms are. A verdict is a function of the tsmetta
 * archive, the MeTTa corpus's digest, fixtures included, this runner, the
 * original, the kept forms around it and the form, so it is kept under that
 * key and asked again only when one of them changes. The staged copy is
 * removed however the load ends.
 */
async function runsInPlace(
  path: string,
  basis: string,
  at: number,
  before: string,
  form: string,
  after: string,
): Promise<boolean> {
  const key = createHash("sha256")
    .update(JSON.stringify([basis, path, before, form, after]))
    .digest("hex");
  const file = `${VERDICTS}/${key}`;
  if (existsSync(file)) return readFileSync(file, "utf8") === "runs";
  const alone = stage(path, `-form-${String(at)}`);
  writeFileSync(alone, [before, form, after].filter((part) => part !== "").join("\n"));
  const fresh = await metta();
  let ran: boolean;
  try {
    fresh.loadFile(alone);
    ran = true;
  } catch {
    ran = false;
  } finally {
    rmSync(alone, { force: true });
    fresh.dispose();
  }
  // Written beside and renamed, so a concurrent side never reads half a verdict.
  mkdirSync(VERDICTS, { recursive: true });
  const partial = `${file}.${String(process.pid)}`;
  writeFileSync(partial, ran ? "runs" : "fails");
  renameSync(partial, file);
  return ran;
}

/**
 * Load an original, less the `!` forms this build refuses, then ask whether
 * each refused form still fails where it stands.
 *
 * A refused original is staged beside the file it came from, and its refused
 * forms are tried after the stored atoms are read, so an attempt cannot
 * change what the comparison sees. The staged copy is removed however the
 * load ends.
 */
async function original(path: string, refused: ReadonlySet<number>): Promise<Report> {
  const m = await metta();
  const staged = stage(path, "");
  try {
    const { text, claims, dropped } = keptProgram(m.forms(readFileSync(path, "utf8")), refused);
    const loaded = refused.size === 0 ? path : staged;
    if (loaded === staged) writeFileSync(staged, text);
    try {
      m.loadFile(loaded);
    } catch (error) {
      return { ok: false, error: describe(error), claims };
    }
    const report = await stored(m);
    const basis = dropped.length === 0 ? "" : verdictBasis();
    const runsNow: number[] = [];
    for (const { at, text: form, before, after } of dropped) {
      if (await runsInPlace(path, basis, at, before, form, after)) runsNow.push(at);
    }
    return { ok: true, claims, ...report, runsNow };
  } finally {
    rmSync(staged, { force: true });
    m.dispose();
  }
}

/**
 * Load an original residue.json refuses whole, and when it fails, walk it form
 * by form for the claims that run where they stand.
 *
 * `ok` is whether the whole original loads. A walk that finished reports
 * `runsNow` and `failsNow` even when both are empty, so a reader can tell a
 * refusal that holds from a side that stopped before it knew.
 */
async function whole(path: string): Promise<Report> {
  const m = await metta();
  let forms: readonly Form[] | undefined;
  try {
    forms = m.forms(readFileSync(path, "utf8"));
    m.loadFile(path);
    return { ok: true, claims: keptProgram(forms, new Set()).claims };
  } catch (error) {
    if (forms === undefined) throw error;
    const basis = verdictBasis();
    const walk = await walkForms(forms, (at, before, form) =>
      runsInPlace(path, basis, at, before, form, ""),
    );
    return {
      ok: false,
      error: describe(error),
      claims: walk.claims.length,
      runsNow: walk.claims,
      failsNow: walk.fails,
    };
  } finally {
    m.dispose();
  }
}

const COUNTER = new URL("./assert.js", import.meta.url).href;
const STRICT = /^(node:)?assert\/strict$/;

async function program(path: string, out: string): Promise<Report> {
  registerHooks({
    resolve(specifier, context, next) {
      if (STRICT.test(specifier) && context.parentURL !== COUNTER) {
        return { url: COUNTER, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  const { claims } = (await import(COUNTER)) as { claims: () => number };
  // A program that ends the process itself, as a guarded import naming a
  // missing package does, never returns here; this is the report it leaves.
  process.once("exit", (code) => {
    if (existsSync(out)) return;
    const report: Report = { ok: code === 0, claims: claims(), exited: code };
    writeFileSync(out, JSON.stringify(report) + "\n");
  });
  let module: { m?: unknown; DIVERGENCE?: unknown };
  try {
    module = (await import(pathToFileURL(resolve(path)).href)) as {
      m?: unknown;
      DIVERGENCE?: unknown;
    };
  } catch (error) {
    return { ok: false, error: describe(error), claims: claims() };
  }
  let declared: { divergence?: Divergence } = {};
  try {
    if (module.DIVERGENCE !== undefined) {
      declared = { divergence: checkedDivergence(module.DIVERGENCE, path) };
    }
  } catch (error) {
    return { ok: false, error: describe(error), claims: claims() };
  }
  const m = module.m as MeTTa | undefined;
  if (m === undefined) return { ok: true, claims: claims(), exported: false, ...declared };
  try {
    return { ok: true, claims: claims(), exported: true, ...declared, ...(await stored(m)) };
  } finally {
    m.dispose();
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return `${error.constructor.name}${typeof code === "string" ? ` (${code})` : ""}: ${error.message}`;
  }
  return String(error);
}

const [kind, path, out, refusedList = ""] = process.argv.slice(2);
if (
  (kind !== "original" && kind !== "whole" && kind !== "program") ||
  path === undefined ||
  out === undefined
) {
  throw new Error(
    "usage: node side.js <original|whole|program> <path> <report.json> [refused forms, comma-separated]",
  );
}
const refused = new Set(refusedList.split(",").filter(Boolean).map(Number));
let report: Report;
try {
  report =
    kind === "original"
      ? await original(path, refused)
      : kind === "whole"
        ? await whole(path)
        : await program(path, out);
} catch (error) {
  report = { ok: false, error: describe(error), claims: 0 };
}
writeFileSync(out, JSON.stringify(report) + "\n");
process.exitCode = report.ok ? 0 : 1;
