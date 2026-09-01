/**
 * Purpose: embed the MeTTa Kernel engine in a Node process over swipl-wasm, run a
 *   job inside a suspendable SWI engine, and pump the events it produces,
 *   answering the ones only a JavaScript function can answer.
 * Assumes:
 *   - swipl-wasm 8.0.6 is installed beside this package; it is the SWI-Prolog
 *     organisation's own WebAssembly build of SWI 10.1.13
 *     [source: https://github.com/SWI-Prolog/npm-swipl-wasm]
 *   - the engine's boot transcript is SILENT; any ERROR: line in it is an
 *     unnamed refusal and throws rather than being absorbed
 *   - `bridge.pl` sits beside this file's package root and speaks the job
 *     protocol documented there
 * Guarantees:
 *   - a job computes one event per pull, and abandoning it closes the engine
 *   - a host operation is called from the middle of a reduction, may be async,
 *     and may answer lazily; its rejection becomes the engine's own error
 *   - nothing reaches the host's console unless boot() was asked for verbose:
 *     an engine error is raised here and a program's output is buffered
 *   - every number crosses exactly: a Prolog integer arrives as a bigint and
 *     a Prolog float as a number
 *   - synchronous collection preserves every event in engine order, and host
 *     operation dispatch selects the registered name AND arity
 *     [tested: "keeps every answer of a nondeterministic transaction",
 *     "dispatches the currently registered arity at a shared name";
 *     commit=f79cfa2133ee8691c8c21b8a6a59928ddbad7352]
 * Owns: one WebAssembly instance per boot(), one Prolog engine per open job,
 *   and the live-host-value table, all released by dispose().
 * Decides: a job is addressed by integer because the WebAssembly value
 *   conversion renders every Prolog blob as the same opaque `{"$t":"b"}`.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: publishing this to npm needs the engine tree beside
 *     it. boot() mounts engine/, lib/ and the backend control files from the
 *     checkout, and a published package carries none of them, which is why
 *     package.json is private for now. The Python side solved the same
 *     problem by copying them under metta/_runtime at build time (setup.py).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Atom, Expression, G, Grounded, lift } from "./atom.ts";
import { config } from "./config.ts";
import { type EffectClass, type OpKind as CatalogOpKind, effectRank } from "./vocabularies.ts";
import {
  CapabilityError,
  ClosedError,
  EngineError,
  MettaError,
  NameError,
  ResultError,
  SourceNotFoundError,
  TransportError,
  UnsupportedError,
  engineError,
} from "./errors.ts";
import {
  HostValues,
  type WireTokens,
  decodeEngine,
  encodeEngine,
  fromRoundTrip,
  fromTransport,
  hostText,
  toTransport,
} from "./wire.ts";

const require = createRequire(import.meta.url);

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The package root, FOUND rather than assumed.
 *
 * This file runs from `src/` when a consumer type-strips the sources and from
 * `build/src/` or `dist/` when it runs a build, and each of those is a
 * different number of directories deep. Counting them got the engine tree
 * wrong the first time a build ran, so the root is the nearest ancestor that
 * carries this package's own `bridge.pl` beside its `package.json`.
 */
function findPackageRoot(from: string): string {
  let at = from;
  for (;;) {
    if (existsSync(join(at, "bridge.pl")) && existsSync(join(at, "package.json"))) return at;
    const up = dirname(at);
    if (up === at) {
      throw new EngineError(
        `this package's own bridge.pl is not above ${from}; the binding cannot ` +
          `find the engine tree it mounts`,
      );
    }
    at = up;
  }
}

/**
 * This package's own root, wherever it was installed and however it is being
 * run. `bridge.pl` and `examples/` sit inside it.
 */
export const packageRoot: string = findPackageRoot(HERE);
const PACKAGE_ROOT = packageRoot;
/**
 * Where the engine tree is mounted FROM, which is not the same place in a
 * checkout and in an install.
 *
 * In the checkout this package sits at `extensions/node/`, so the engine is two
 * levels up. Installed, it sits at `node_modules/metta-node/`, where two levels
 * up is the CONSUMER'S OWN project: measured 2026-08-29 on a fresh
 * `npm install` outside any checkout, that resolved to
 * `C:\Users\ahmad\nodetest\engine` and the boot died on `scandir`. So a
 * published tarball carries its own copy at `_runtime/`, written by the
 * `prepack` script and preferred here whenever it is present, the way the
 * Python seat carries `metta/_runtime/`.
 */
function findEngineRoot(packageRoot: string): string {
  const bundled = join(packageRoot, "_runtime");
  return existsSync(join(bundled, "engine")) ? bundled : resolve(packageRoot, "..", "..");
}

/**
 * The engine tree this package boots from: its own bundled `_runtime/` when
 * the package was published, and the surrounding checkout when it was not.
 */
export const repoRoot: string = findEngineRoot(PACKAGE_ROOT);
const REPO_ROOT = repoRoot;
const VIRTUAL_ROOT = "/metta";

// The directories engine/metta.pl reaches for while it loads: its own and the
// standard library. This binding IS a seat, and its own bridge is written into
// the image below rather than mounted from the tree.
const ENGINE_DIRS = ["engine", "lib"] as const;

// Where the engine globs for a seat's control file. Mounted a file at a time
// by mountControlFiles below, not as a directory.
const CONTROL_ROOT = "extensions";

/** One capability the engine declares, and what its absence costs. */
export interface Capability {
  /** The engine's own name for it, such as `concurrency`. */
  readonly capability: string;
  /** The platform library it needs, written as the engine writes it. */
  readonly requires: string;
  /** What its absence costs a program. */
  readonly costs: string;
}

/**
 * The boot transcript must be SILENT.
 *
 * This used to be a table of expected refusals plus a regex over SWI's
 * stderr, because three `use_module` directives failed on a build without
 * threads, timers or processes and the host recovered the losses by parsing
 * the error text. The engine declares its platform capabilities now, so a
 * reduced build loads quietly and the census is read through the `platform`
 * command instead. That makes any ERROR: line an unnamed refusal, which is
 * strictly stronger than matching against a table: a differently worded SWI
 * error used to slip past both regexes without a sound.
 */
function refuseUnnamedErrors(lines: readonly string[]): void {
  const errors = lines.filter((line) => line.startsWith("ERROR:"));
  if (errors.length === 0) return;
  throw new EngineError(
    `the engine reported ${String(errors.length)} error(s) while booting, ` +
      `which this binding does not name: ${errors.join(" / ")}. The platform ` +
      `census carries every capability the build lacks, so an ERROR: here is ` +
      `something else and absorbing it is how a defect goes quiet.`,
  );
}

// ---------------------------------------------------------------------------
// The events bridge.pl produces.

/** One answer of a job: the atom it is and the engine's own rendering. */
export interface AnswerEvent {
  readonly kind: "answer";
  readonly atom: Atom;
  readonly text: string;
}

/** A whole program's answers, one group per `!` directive, in source order. */
export interface GroupsEvent {
  readonly kind: "groups";
  readonly groups: readonly (readonly AnswerEvent[])[];
}

/** A command's single value: a count, a verdict, a name list. */
export interface ValueEvent {
  readonly kind: "value";
  readonly atom: Atom;
}

/** One queued admission a watch matched. */
export interface AdmissionEvent {
  readonly kind: "admission";
  readonly edge: "add" | "remove";
  readonly atom: Atom;
  readonly text: string;
}

/** What a job produced, once the pump has answered everything only it could. */
export type JobEvent = AnswerEvent | GroupsEvent | ValueEvent | AdmissionEvent;

/** A scope a job runs inside, established within its own engine. */
export type Scope =
  | readonly ["stack", number]
  | readonly ["inferences", number]
  | readonly ["module", string]
  | readonly ["transaction"]
  | readonly ["speculate"];

/** A command posted to bridge.pl's table. Payloads are transport terms. */
export type Command = readonly unknown[];

/**
 * How a host operation answers.
 *
 * The catalog's `op-kind` vocabulary minus `async`, which this transport does
 * not need: a JavaScript operation that answers a promise is awaited by the
 * pump whatever kind it declared, so asynchrony is a property of the ANSWER
 * here rather than a kind an author picks.
 */
export type OpKind = Exclude<CatalogOpKind, "async">;

/** The five ranked effect classes an operation declares. */
export type { EffectClass };

/** A registered host operation, as the pump needs it. */
export interface HostOp {
  readonly name: string;
  readonly arity: number;
  readonly kind: OpKind;
  readonly effect: EffectClass;
  /**
   * The body.
   *
   * A `raw_*` kind receives the arguments as ATOMS, unevaluated structure and
   * all; every other kind receives a grounded atom's host value, so an
   * ordinary TypeScript function needs no unwrapping of its own. The return
   * may be a value, a promise, an iterable or an async iterable, and the pump
   * reads each of those as what it is.
   */
  readonly run: (args: readonly unknown[]) => unknown;
}

/** The counters a stats scope reads. Inferences are the engine's; the rest are here. */
export interface Counters {
  /** Engine-side inferences, summed over every job that ran to exhaustion. */
  inferences: number;
  /** Host-to-engine round trips: the N+1 counter of this transport. */
  crossings: number;
  /** Bodies re-run to reach a second branch, the multi-shot cost. */
  replays: number;
}

/**
 * The engine's own runtime counters, read in one crossing.
 *
 * Absolutes rather than deltas, because the scope that wants a delta is the
 * one that knows when it opened. Every field is the engine's own
 * `statistics/2` reading, so nothing here is derived or estimated.
 */
export interface EngineCounters {
  /** Total inferences this engine has retired. */
  readonly inferences: number;
  /** CPU seconds this engine has spent. */
  readonly cpuSeconds: number;
  /** How many garbage collections have run. */
  readonly collections: number;
  /** How many bytes those collections freed. */
  readonly freedBytes: number;
  /** How many milliseconds they spent. */
  readonly collectionMs: number;
  /** How many bytes the answer tables hold. */
  readonly tableBytes: number;
}

type PrologAnswer = Record<string, unknown> & { error?: boolean; message?: string };

interface PrologQuery {
  once(): PrologAnswer | undefined;
}

interface PrologInterface {
  query(goal: string, input?: Record<string, unknown>): PrologQuery;
}

interface EmscriptenFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
}

interface Swipl {
  readonly prolog: PrologInterface;
  readonly FS: EmscriptenFS;
}

function mountInto(
  fs: EmscriptenFS,
  hostDir: string,
  virtualDir: string,
  keep?: (name: string) => boolean,
): void {
  // Read FIRST, so a directory that is not there is this package's own named
  // refusal rather than Node's raw ENOENT `Error` reaching the caller.
  let entries: string[];
  try {
    entries = readdirSync(hostDir);
  } catch (error) {
    throw new SourceNotFoundError(`${hostDir} is not a directory this host can read`, {
      cause: error,
    });
  }
  fs.mkdirTree(virtualDir);
  for (const name of entries) {
    const hostPath = join(hostDir, name);
    const virtualPath = `${virtualDir}/${name}`;
    if (statSync(hostPath).isDirectory()) {
      mountInto(fs, hostPath, virtualPath, keep);
    } else if (keep === undefined || keep(name)) {
      fs.writeFile(virtualPath, readFileSync(hostPath));
    }
  }
}

/**
 * Every seat's control file, and nothing else under `extensions/`.
 *
 * The engine READS these at boot to record which seats are present. None of
 * their `entry(engine, _)` files can load in a wasm build, which has no
 * dynamic linking and no janus, and this binding's own seat declares only an
 * `entry(host, _)` that the engine never loads at all. So the control file is
 * the only thing under here the engine ever opens.
 *
 * mountInto would copy the whole tree, and a BUILT checkout carries the MORK
 * crate's Rust `target/` under it: 10,808 files and 3.2 GiB, which the image
 * cannot hold. That is not a slow boot, it is a dead one [measured
 * 2026-08-28 at e80fd4c3, same commit both ways: with `target/` present this
 * suite reported 70 tests, 62 pass and 8 test files aborted on `FATAL ERROR:
 * ... JavaScript heap out of memory`; with it moved aside, 203 tests and 203
 * pass]. Merging the seat folders makes it worse rather than better: this
 * package's own `node_modules` now sits under the same root.
 */
function mountControlFiles(fs: EmscriptenFS, root: string): void {
  const controls = join(root, CONTROL_ROOT);
  if (!existsSync(controls)) return;
  for (const seat of readdirSync(controls)) {
    const control = join(controls, seat, "extension.pl");
    if (!existsSync(control)) continue;
    fs.mkdirTree(`${VIRTUAL_ROOT}/${CONTROL_ROOT}/${seat}`);
    fs.writeFile(`${VIRTUAL_ROOT}/${CONTROL_ROOT}/${seat}/extension.pl`, readFileSync(control));
  }
}

/** One effectful crossing a saga recorded, before it becomes a receipt atom. */
export interface CapturedEffect {
  /** The operation's engine name. */
  readonly name: string;
  /** Its arguments, on the wire, exactly as the engine sent them. */
  readonly args: readonly unknown[];
  /** What the body answered. */
  readonly result: unknown;
}

// The open capture, or null. A module-level slot rather than a field, because
// the operation path reads it per call and this seat has one thread: there is
// no second capture to confuse it with, and a per-crossing map lookup is not
// what a program with no saga should pay.
let capturing: CapturedEffect[] | null = null;

/** The rank a receipt needs, read once rather than per crossing. */
const WRITES = effectRank("writesState");

/**
 * Route effectful operation crossings into `into` while `walk` runs.
 *
 * Restores the previous capture rather than clearing it, so a compensation
 * that itself runs operations does not journal them into the saga that is
 * compensating -- which would make an undo into an obligation to undo.
 */
export async function whileCapturing<T>(
  into: CapturedEffect[] | null,
  walk: () => Promise<T>,
): Promise<T> {
  const outer = capturing;
  // The slot spans an await, which is safe because this seat drives one engine
  // and one job at a time; two OPEN captures would interleave, so the second
  // is refused rather than journalled into the first. Closing one (the null
  // case, which is how a compensation runs) always nests.
  if (into !== null && outer !== null) {
    throw new MettaError(
      "two sagas cannot record at once: finish or roll back the open one first",
    );
  }
  capturing = into;
  try {
    return await walk();
  } finally {
    capturing = outer;
  }
}

/**
 * One job: an engine suspended between events, pumped by the host.
 *
 * The two kinds of event the bridge produces are told apart by shape here as
 * they are there. A `call` or a `pull` is a request only a JavaScript function
 * can answer, and this class answers it without the caller ever seeing one;
 * everything else is handed on.
 */
export class Job {
  #engine: Engine;
  #id: number | null;
  // A MAP rather than one slot. A single slot could hold one live stream, so a
  // second one opened before the first was exhausted replaced it and the first
  // could never be resumed: every conjunction over a TypeScript-backed space
  // answered its first row and stopped, silently.
  // [tested: "answers a conjunction over a provider needing two live enumerations at once"]
  #pending = new Map<number, AsyncIterator<unknown> | Iterator<unknown>>();
  #nextStream = 1;

  /** @internal */
  constructor(engine: Engine, id: number) {
    this.#engine = engine;
    this.#id = id;
  }

  /** The next event, or null once the job is finished. */
  async next(): Promise<JobEvent | null> {
    if (this.#id === null) return null;
    let raw = this.#engine.rawStep(this.#id);
    for (;;) {
      const settled = this.#settle(raw);
      if (settled.done) return settled.event;
      const reply = await settled.reply;
      if (this.#id === null) return null;
      raw = this.#engine.rawResume(this.#id, reply);
    }
  }

  /**
   * Run to exhaustion without awaiting, answering the last event.
   *
   * A SYNCHRONOUS host operation is answered here exactly as it is on the
   * awaiting door: the transport is in process, so nothing about a synchronous
   * op needs a promise. One that answers with a promise cannot be answered
   * here, and refuses by name rather than deadlocking, because the remedy is
   * the awaiting form and saying so is more use than a hang.
   */
  sync(): JobEvent | null {
    const events = this.syncAll();
    return events.length === 0 ? null : (events[events.length - 1] as JobEvent);
  }

  /** Every remaining event, collected without awaiting. */
  syncAll(): JobEvent[] {
    const events: JobEvent[] = [];
    if (this.#id === null) return events;
    let raw = this.#engine.rawStep(this.#id);
    for (;;) {
      const settled = this.#settle(raw);
      if (settled.done) {
        if (settled.event === null) return events;
        events.push(settled.event);
        if (this.#id === null) return events;
        raw = this.#engine.rawStep(this.#id);
        continue;
      }
      this.close();
      throw new UnsupportedError(
        "a host operation answered with a promise on a synchronous door; use " +
          "the awaiting form so this side can wait for it",
      );
    }
  }

  /** Every remaining event, collected. */
  async all(): Promise<JobEvent[]> {
    const events: JobEvent[] = [];
    for (;;) {
      const event = await this.next();
      if (event === null) return events;
      events.push(event);
    }
  }

  /** The one event this job produces, or a refusal naming what it got instead. */
  async only(): Promise<JobEvent> {
    const event = await this.next();
    if (event === null) {
      throw new ResultError("the engine answered nothing where one answer was required");
    }
    // Drain, so the job's inference spend is recorded and its engine released.
    await this.next();
    return event;
  }

  /** Release the engine. Idempotent. */
  close(): void {
    const id = this.#id;
    if (id === null) return;
    this.#id = null;
    // A stream the engine cut rather than drained is still here, and this is
    // where it goes. `return()` runs a generator's own `finally`, so a body
    // holding a resource releases it rather than being dropped on the floor.
    for (const iterator of this.#pending.values()) this.#close(iterator);
    this.#pending.clear();
    this.#engine.rawStop(id);
  }

  /**
   * One turn of the pump.
   *
   * Either the raw event is one the caller should see (or the end), or it is a
   * request only this side can answer. Answering it may be immediate, in which
   * case the next raw event comes back at once, or it may need a promise, which
   * is the one thing the synchronous door cannot do.
   */
  #settle(
    first: unknown,
  ):
    | { done: true; event: JobEvent | null }
    | { done: false; reply: Promise<readonly unknown[]> } {
    // A LOOP rather than tail recursion: a synchronous host operation is
    // answered and resumed here, and a generator answering ten thousand times
    // would otherwise be ten thousand JavaScript frames deep.
    let raw = first;
    for (;;) {
      if (raw === null) {
        this.close();
        return { done: true, event: null };
      }
      const event = raw as readonly unknown[];
      const tag = hostText(event[0]);
      if (tag === "spent") {
        this.#engine.counters.inferences += Number(hostText(event[1]));
        this.close();
        return { done: true, event: null };
      }
      if (tag === "error") {
        this.close();
        throw engineError(hostText(event[1]));
      }
      if (tag !== "call" && tag !== "pull") {
        return { done: true, event: this.#engine.decodeEvent(tag, event) };
      }
      const reply = tag === "call" ? this.#callReply(event) : this.#pullReply(event);
      // A pending reply is handed BACK rather than resumed here, so a
      // synchronous door that refuses it leaves nothing scheduled against an
      // engine it is about to release.
      if (isPromise(reply)) return { done: false, reply };
      raw = this.#engine.rawResume(this.#id!, reply);
    }
  }

  /** What to post back for one host-operation call. */
  #callReply(event: readonly unknown[]): readonly unknown[] | Promise<readonly unknown[]> {
    const name = hostText(event[1]);
    const wires = event[2] as readonly unknown[];
    // The engine sends the space it is reducing in, so an operation may ask
    // where it is without the space being one of its arguments.
    const where = event[3] === undefined ? undefined : hostText(event[3]);
    let op: HostOp;
    try {
      op = this.#engine.operation(name, wires.length);
    } catch (error) {
      return ["error", messageOf(error)];
    }
    const raw = op.kind === "raw_det" || op.kind === "raw_many";
    let answered: unknown;
    const outer = this.#engine.callingSpace;
    if (where !== undefined) this.#engine.callingSpace = where;
    try {
      const args = wires.map((tokens) => this.#engine.decodeAtom(tokens));
      answered = op.run(raw ? args : args.map((atom) => unwrap(atom)));
    } catch (error) {
      return ["error", messageOf(error)];
    } finally {
      // Restored rather than cleared, so an operation that reaches the engine
      // and is called back into leaves the outer call's space in place.
      this.#engine.callingSpace = outer;
    }
    // One null read on the operation path, which is what a saga costs a
    // program that has none. A capture is open only inside `Saga.run`, and it
    // takes only the operations whose DECLARED effect is a write or stronger:
    // a receipt for a read would be an obligation to undo nothing.
    if (capturing !== null && effectRank(op.effect) >= WRITES) {
      capturing.push({ name, args: wires, result: answered });
    }
    const many = op.kind === "many" || op.kind === "raw_many";
    if (isPromise(answered)) {
      return answered.then(
        (settled) => this.#shape(settled, many),
        (error: unknown) => ["error", messageOf(error)] as readonly unknown[],
      );
    }
    try {
      return this.#shape(answered, many);
    } catch (error) {
      return ["error", messageOf(error)];
    }
  }

  /**
   * A settled answer as the reply the bridge reads.
   *
   * A stream is given an ID, because more than one can be live at once: the
   * engine opens an inner enumeration while an outer one is suspended, and
   * both have to be resumable. The id rides every pull back.
   */
  #shape(settled: unknown, many: boolean): readonly unknown[] {
    if (!many) return ["ok", this.#engine.encodeValue(settled)];
    const iterator = asIterator(settled);
    if (iterator === null) return ["many", [this.#engine.encodeValue(settled)]];
    const id = this.#nextStream;
    this.#nextStream += 1;
    this.#pending.set(id, iterator);
    return ["stream", String(id)];
  }

  /** What to post back for one pull of a streaming host operation. */
  #pullReply(event: readonly unknown[]): readonly unknown[] | Promise<readonly unknown[]> {
    const id = Number(hostText(event[1]));
    const iterator = this.#pending.get(id);
    if (iterator === undefined) return ["done"];
    let step: IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
    try {
      step = iterator.next() as IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
    } catch (error) {
      this.#pending.delete(id);
      return ["error", messageOf(error)];
    }
    if (isPromise(step)) {
      return step.then(
        (settled) => this.#step(id, settled),
        (error: unknown) => {
          this.#pending.delete(id);
          return ["error", messageOf(error)] as readonly unknown[];
        },
      );
    }
    return this.#step(id, step);
  }

  #step(id: number, step: IteratorResult<unknown>): readonly unknown[] {
    if (step.done === true) {
      this.#pending.delete(id);
      return ["done"];
    }
    return ["ok", this.#engine.encodeValue(step.value)];
  }

  /** Release one stream the engine abandoned, running the body's own cleanup. */
  #close(iterator: AsyncIterator<unknown> | Iterator<unknown>): void {
    try {
      void iterator.return?.(undefined);
    } catch {
      // A body that throws on the way out has nothing left to tell anyone: the
      // job is closing, and there is no caller to raise it to.
    }
  }
}

function isPromise(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * The iterator behind a value, keeping a SYNCHRONOUS one synchronous.
 *
 * A generator op that never awaits can be pulled on the synchronous door, and
 * wrapping its steps in resolved promises would have taken that away for
 * nothing.
 */
function asIterator(value: unknown): AsyncIterator<unknown> | Iterator<unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return null;
  const holder = value as {
    [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    [Symbol.iterator]?: () => Iterator<unknown>;
  };
  const asAsync = holder[Symbol.asyncIterator];
  if (typeof asAsync === "function") return asAsync.call(holder);
  const asSync = holder[Symbol.iterator];
  if (typeof asSync === "function") return asSync.call(holder);
  return null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return String(error);
}

/** A grounded atom's host value; anything else stays the atom itself. */
function unwrap(atom: Atom): unknown {
  const held = atom as { value?: unknown; kind?: string };
  return held.kind === "grounded" ? held.value : atom;
}

/**
 * The engine in this process: the WebAssembly instance, the bridge, and the
 * jobs running inside it.
 */
export class Engine {
  #swipl: Swipl;
  #output: string[];
  #stderr: string[];
  #ops = new Map<string, HostOp>();
  #transportOps = new Map<string, HostOp>();
  #watches = 0;

  /** The values this host has handed the engine a reference to. */
  readonly hostValues: HostValues = new HostValues();
  /** Names the engine introduced under `p`, so a bare `s` can be restored. */
  readonly knownSpaces: Set<string> = new Set(["&self", "&metta"]);
  /** The counters a stats scope reads. */
  readonly counters: Counters = { inferences: 0, crossings: 0, replays: 0 };

  /**
   * The scopes every job is started inside.
   *
   * A scope has to be established WITHIN the engine that runs the job, so a
   * `using` block on this side pushes here and every job started while it is
   * live carries it. The array is shared with the surface that owns it.
   */
  scopes: Scope[] = [];

  /**
   * The engine's own platform census: every capability, present or absent.
   *
   * Read rather than recovered by regex over the boot transcript, so the
   * costs are the engine's own words and the two cannot drift.
   */
  capabilities(): readonly (Capability & { readonly present: boolean })[] {
    const event = this.start(["platform"]).sync();
    if (event === null || event.kind !== "value" || !(event.atom instanceof Expression)) return [];
    const rows: (Capability & { present: boolean })[] = [];
    for (const row of event.atom.items) {
      if (!(row instanceof Expression) || row.items.length !== 4) continue;
      const cells = row.items.map((cell) =>
        cell instanceof Grounded && typeof cell.value === "string" ? cell.value : "",
      );
      rows.push({
        capability: cells[0] ?? "",
        present: cells[1] === "present",
        requires: cells[2] ?? "",
        costs: cells[3] ?? "",
      });
    }
    return rows;
  }

  /** What this build does WITHOUT, each with what its absence costs. */
  get refusals(): readonly Capability[] {
    return this.capabilities()
      .filter((row) => !row.present)
      .map(({ capability, requires, costs }) => ({ capability, requires, costs }));
  }

  /** @internal Use {@link boot}. */
  constructor(swipl: Swipl, output: string[], stderr: string[]) {
    this.#swipl = swipl;
    this.#output = output;
    this.#stderr = stderr;
  }

  /**
   * Run a goal that must succeed exactly once, and return its bindings.
   *
   * Through bridge.pl's metta_node_do/2, so a Prolog exception never reaches
   * the WebAssembly boundary: swipl-wasm prints one on the host's console
   * before handing it back and has no switch for it, so the outcome crosses as
   * data and the raising happens here instead.
   */
  once(goal: string, input: Record<string, unknown> = {}): PrologAnswer {
    if (this.#closed) {
      throw new ClosedError(
        `this engine was disposed; boot another with metta() rather than using a released one`,
      );
    }
    this.counters.crossings += 1;
    const result = this.#swipl.prolog
      .query(`metta_node_do((${goal}), Outcome).`, input)
      .once();
    if (result?.error === true) {
      throw new TransportError(`${String(result.message)} (running ${goal})`);
    }
    if (result === undefined || result["success"] === false) {
      throw new TransportError(`the engine could not run ${goal}`);
    }
    const outcome = result["Outcome"] as readonly unknown[];
    const kind = hostText(outcome[0]);
    if (kind === "error") throw engineError(`${hostText(outcome[1]).trimEnd()}\nrunning ${goal}`);
    if (kind !== "ok") throw new EngineError(`the engine goal failed: ${goal}`);
    return result;
  }

  /**
   * The engine's own runtime counters, in one crossing.
   *
   * `counters` beside it is this TRANSPORT's own tally, which no engine can
   * report: crossings and replays are properties of the wire.
   */
  get engineCounters(): EngineCounters {
    // Read outside a job: SWI's inference counter is per ENGINE, so a reading
    // taken inside a job's own engine reports that engine's handful rather
    // than the process's work.
    const answer = this.once("metta_node_counters(Texts)");
    const texts = (answer["Texts"] ?? []) as readonly unknown[];
    const read = (at: number): number => Number(hostText(texts[at] ?? "0"));
    return {
      inferences: read(0),
      cpuSeconds: read(1),
      collections: read(2),
      freedBytes: read(3),
      collectionMs: read(4),
      tableBytes: read(5),
    };
  }

  /** Mount a host directory into the engine's virtual filesystem. */
  mount(hostDir: string, virtualDir: string, keep?: (name: string) => boolean): void {
    mountInto(this.#swipl.FS, hostDir, virtualDir, keep);
  }

  // --- the job protocol -----------------------------------------------------

  /** Start a job. The scopes are established inside its own engine. */
  start(command: Command, scopes: readonly Scope[] = []): Job {
    const answer = this.once("metta_node_start(Sc, Cmd, Id)", {
      Sc: [...this.scopes, ...scopes].map((scope) => [...scope]),
      Cmd: command,
    });
    return new Job(this, Number(answer["Id"]));
  }

  /** @internal One raw event, or null on exhaustion. */
  rawStep(id: number): unknown {
    const answer = this.once("metta_node_step(Id, Ev)", { Id: id });
    const events = answer["Ev"] as readonly unknown[];
    return events.length === 0 ? null : events[0];
  }

  /** @internal Post a reply and take the next raw event in one crossing. */
  rawResume(id: number, reply: readonly unknown[]): unknown {
    const answer = this.once("metta_node_resume(Id, R, Ev)", { Id: id, R: reply });
    const events = answer["Ev"] as readonly unknown[];
    return events.length === 0 ? null : events[0];
  }

  /** @internal Release a job's engine. */
  rawStop(id: number): void {
    // A job closing after its surface was disposed has nothing left to release
    // and no engine to ask, so this is where the cleanup path stops rather
    // than raising out of a `finally`.
    if (this.#closed) return;
    this.once("metta_node_stop(Id)", { Id: id });
  }

  /** @internal One engine answer as the atom it names, in one pass. */
  decodeAtom(tokens: unknown): Atom {
    return decodeEngine(tokens, { knownSpaces: this.knownSpaces, hostValues: this.hostValues });
  }

  /**
   * @internal Encode whatever a host operation answered.
   *
   * An atom crosses as itself. Anything else is lifted first, so an ordinary
   * TypeScript function may return a number, a string or its own object and
   * the tag follows the VALUE: `n`, `g`, `b`, or a live reference under `o`.
   */
  encodeValue(value: unknown): unknown[] {
    return this.encodeAtom(lift(value));
  }

  /** @internal One atom as the flat token list the bridge reads, in one pass. */
  encodeAtom(atom: Atom): unknown[] {
    return encodeEngine(atom, { hostValues: this.hostValues });
  }

  /** @internal Build the public event a raw one names. */
  decodeEvent(tag: string, event: readonly unknown[]): JobEvent {
    switch (tag) {
      case "answer":
        return { kind: "answer", atom: this.decodeAtom(event[1]), text: hostText(event[2]) };
      case "value":
        return { kind: "value", atom: this.decodeAtom(event[1]) };
      case "groups":
        return {
          kind: "groups",
          groups: (event[1] as readonly unknown[]).map((group) =>
            (group as readonly unknown[]).map((pair) => {
              const answer = pair as readonly unknown[];
              return {
                kind: "answer" as const,
                atom: this.decodeAtom(answer[0]),
                text: hostText(answer[1]),
              };
            }),
          ),
        };
      case "admission":
        return {
          kind: "admission",
          edge: hostText(event[1]) === "remove" ? "remove" : "add",
          atom: this.decodeAtom(event[2]),
          text: hostText(event[3]),
        };
      default:
        throw new TransportError(`the bridge produced an event this host does not read: ${tag}`);
    }
  }

  // --- host operations ------------------------------------------------------

  /**
   * Register a host operation, or replace one at the same name and arity.
   *
   * The table is keyed by name and arity, and the dispatch lookup is by name
   * alone, because the engine calls a name at whatever arity its own clause
   * carries and this side has one implementation per name.
   */
  register(op: HostOp): void {
    this.start(["registerop", op.name, op.arity, op.kind, op.effect]).sync();
    this.#ops.set(`${op.name}/${String(op.arity)}`, op);
  }

  /**
   * Register a host operation this side answers WITHOUT declaring a MeTTa
   * function for it.
   *
   * The door for the transport's own callbacks: a space backed by TypeScript
   * is called through the same trampoline a host operation uses, but it is a
   * SPACE rather than an operation, so declaring `$provider-call` as a MeTTa
   * function would put a name in the catalog that nothing may call.
   */
  provide(op: HostOp): void {
    this.#transportOps.set(op.name, op);
  }

  /**
   * The space a host operation is being called from, while one is running.
   *
   * Undefined outside any call. It is set from the CALL EVENT rather than read
   * back through a new job, because a new job has its own module and would
   * answer the default however the caller had switched it.
   */
  callingSpace: string | undefined = undefined;

  /** A watch id no other watch is using. */
  nextWatchId(): number {
    this.#watches += 1;
    return this.#watches;
  }

  /** Forget a host operation at one arity. */
  unregister(name: string, arity: number): void {
    this.start(["dropop", name, arity]).sync();
    this.#ops.delete(`${name}/${String(arity)}`);
  }

  /**
   * Every host operation registered here.
   *
   * The reflection door an integration needs: it registers, then asks what it
   * registered, so removal names exactly what installation added.
   */
  operations(): readonly HostOp[] {
    return [...this.#ops.values(), ...this.#transportOps.values()];
  }

  /** @internal The operation behind an exact dispatch, or a refusal naming it. */
  operation(name: string, arity: number): HostOp {
    const found = this.#ops.get(`${name}/${String(arity)}`) ?? this.#transportOps.get(name);
    if (found !== undefined) return found;
    throw new NameError(
      `the engine called ${name}/${String(arity)}, which this host has not registered`,
    );
  }

  // --- the codec doors, which need no engine --------------------------------

  /** One atom of MeTTa source, through the engine's own reader. */
  read(text: string): Atom {
    const answer = this.once("metta_node_read(Src, Wire)", { Src: text });
    return this.decodeAtom(answer["Wire"]);
  }

  /** An atom's round trip through the engine: decode it, then encode it back. */
  roundTrip(atom: Atom): Atom {
    const transport: WireTokens = this.encodeAtom(atom);
    // The decode carries a NAME TABLE and the encode reads it back, so a
    // variable's own spelling survives the trip. Without it the round trip
    // renamed `$x` to the Prolog engine's internal `$_154110`, which is the
    // same variable said in a way no source ever wrote.
    // `_Names` and `_T` are underscore-prefixed on purpose: the WebAssembly
    // library projects every NAMED variable of the goal into the answer, so a
    // plain `T` would carry the decoded Prolog term back across the boundary
    // as a nested structure and swipl-wasm's toJSON would recurse once per
    // level over it. Only `Out` is wanted, and it is flat
    // [tested: carries one into the engine and back unchanged; commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8].
    const answer = this.once(
      "metta_node_decode(W, [], _Names, _T), metta_node_encode_named(_T, _Names, Out)",
      { W: transport },
    );
    return fromRoundTrip(transport, answer["Out"]);
  }

  /**
   * The engine's own rendering of an atom.
   *
   * The display writer, the same authority the command line's answers use, so
   * host-only values and non-finite floats render instead of refusing.
   * Round-trip storage text stays with swrite/2's stricter contract on the
   * Prolog side.
   */
  text(atom: Atom): string {
    // `_T` for the same reason the round trip hides its own: the decoded term
    // is a nested Prolog structure and only the rendering is wanted.
    const answer = this.once("metta_node_decode(W, _T), sdisplay(_T, S)", {
      W: this.encodeAtom(atom),
    });
    return hostText(answer["S"]);
  }

  // --- output ---------------------------------------------------------------

  /**
   * Everything the engine printed since the last read, and forgets it.
   *
   * A program's own `println!` lands here rather than on the host's console,
   * because an embedded engine writing to that console is writing over
   * whatever the host was saying.
   */
  drainOutput(): string[] {
    return this.#output.splice(0, this.#output.length);
  }

  /** Everything the engine wrote to standard error since the last read. */
  drainStderr(): string[] {
    return this.#stderr.splice(0, this.#stderr.length);
  }

  /**
   * Release what this engine holds, and refuse every door afterwards.
   *
   * Before this closed, every door kept working after `dispose()` while the
   * host-value table behind them had been emptied, so a program that disposed
   * and carried on got answers computed against a table that no longer held
   * its objects. A released handle is a refusal here, which is what
   * {@link ClosedError} has always been for.
   */
  dispose(): void {
    this.#closed = true;
    this.hostValues.clear();
  }

  /** Whether this engine has been released. */
  get closed(): boolean {
    return this.#closed;
  }

  #closed = false;
}

/** The strict wire decoder, re-exported so a conformance kit reaches it. */
export { fromTransport, toTransport };

/**
 * Boot the engine in this process.
 *
 * `root` is the MeTTa Kernel checkout; the default is the one this package lives in.
 * The engine's own `silent` flag goes in argv rather than being retracted
 * afterwards, because argv is where engine/filereader.pl reads it and
 * engine/main.pl already lists it as an engine flag.
 */
export async function boot(
  options: { root?: string; verbose?: boolean } = {},
): Promise<Engine> {
  const root = options.root ?? REPO_ROOT;
  const verbose = options.verbose ?? false;
  // Checked before anything is instantiated, so a wrong root is one sentence
  // naming what was wanted rather than a mount failure part way through a boot.
  if (!existsSync(join(root, "engine", "metta.pl"))) {
    throw new SourceNotFoundError(
      `${root} is not a MeTTa Kernel checkout: ${join(root, "engine", "metta.pl")} is not ` +
        `there. boot({ root }) wants the tree the engine lives in, and this package's own ` +
        `is ${REPO_ROOT}.`,
    );
  }
  // The startup settings are fixed from here on, and `config` says so rather
  // than quietly accepting a change that will do nothing.
  config.markStarted();
  const initSWIPL = require("swipl-wasm/dist/swipl-node") as (
    config: Record<string, unknown>,
  ) => Promise<Swipl>;
  const output: string[] = [];
  const stderr: string[] = [];
  const swipl = await initSWIPL({
    arguments: ["-q"],
    print: (line: string) => {
      output.push(line);
      if (verbose) console.log(line);
    },
    printErr: (line: string) => {
      stderr.push(line);
      if (verbose) console.error(line);
    },
  });

  // Sources only: a .qlf is the NATIVE install's compiled artifact (engine/
  // qlf_boot.pl writes them beside the sources, gitignored), and this build's
  // older wasm SWI resolving one instead of the .pl derails the load and the
  // refusal census with it. This host boots from source.
  const source = (name: string): boolean => !name.endsWith(".qlf") && name !== ".qlf-stamp";
  for (const directory of ENGINE_DIRS) {
    mountInto(swipl.FS, join(root, directory), `${VIRTUAL_ROOT}/${directory}`, source);
  }
  mountControlFiles(swipl.FS, root);
  swipl.FS.writeFile(`${VIRTUAL_ROOT}/bridge.pl`, readFileSync(join(PACKAGE_ROOT, "bridge.pl")));

  const flags = verbose ? "['extensions']" : "['extensions', silent]";
  // Only when one was ASKED for. Unset means the build's own ceiling, and a
  // value this 32-bit build cannot represent is a refusal by name rather than
  // a line on stderr.
  const ceiling = config.stackLimit;
  if (ceiling !== undefined) {
    const set = swipl.prolog.query(`set_prolog_flag(stack_limit, ${String(ceiling)}).`).once();
    if (set?.error === true || stderr.length > 0) {
      throw new CapabilityError(
        `this build cannot take a stack limit of ${String(ceiling)} bytes: it is a ` +
          `32-bit WebAssembly SWI, so the ceiling has to fit in its address space`,
      );
    }
  }
  swipl.prolog.query(`set_prolog_flag(argv, ${flags}).`).once();
  const consulted = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/engine/metta.pl').`).once();
  if (consulted?.error === true) {
    throw new EngineError(`the engine did not load: ${String(consulted.message)}`);
  }

  refuseUnnamedErrors(stderr);
  stderr.length = 0;
  output.length = 0;

  const bridged = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/bridge.pl').`).once();
  if (bridged?.error === true) {
    throw new EngineError(`the Node bridge did not load: ${String(bridged.message)}`);
  }

  return new Engine(swipl, output, stderr);
}
