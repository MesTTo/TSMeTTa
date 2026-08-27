/**
 * Purpose: embed the PeTTa engine in a Node process over swipl-wasm, run a
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

import { Atom, G } from "./atom.ts";
import { PettaError } from "./errors.ts";
import {
  HostValues,
  type Transport,
  type Wire,
  atomFromWire,
  decodeEngine,
  fromRoundTrip,
  fromTransport,
  hostText,
  toTransport,
  wireFromAtom,
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
      throw new PettaError(
        `this package's own bridge.pl is not above ${from}; the binding cannot ` +
          `find the engine tree it mounts`,
      );
    }
    at = up;
  }
}

/**
 * This package's own root, wherever it was installed and however it is being
 * run. `bridge.pl` and `example/` sit inside it.
 */
export const packageRoot: string = findPackageRoot(HERE);
const PACKAGE_ROOT = packageRoot;
/** The PeTTa checkout this package's engine tree is mounted from. */
export const repoRoot: string = resolve(PACKAGE_ROOT, "..", "..");
const REPO_ROOT = repoRoot;
const VIRTUAL_ROOT = "/petta";

// The directories engine/metta.pl reaches for while it loads: its own and the
// standard library. The seat controls under bindings/ stay unmounted: no
// substrate they gate on exists in wasm, and this binding IS the host, its
// bridge written into the image below.
const ENGINE_DIRS = ["engine", "lib"] as const;

// Where the engine globs for a backend's control file. Mounted a file at a
// time by mountControlFiles below, not as a directory.
const CONTROL_ROOT = "backends";

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
  throw new PettaError(
    `the engine reported ${String(errors.length)} error(s) while booting, ` +
      `which this binding does not name: ${errors.join(" / ")}. The platform ` +
      `census carries every capability the build lacks, so an ERROR: here is ` +
      `something else and absorbing it is how a defect goes quiet.`,
  );
}

// ---------------------------------------------------------------------------
// The events bridge.pl produces.

/** One answer of a job: its wire form and the engine's own rendering. */
export interface AnswerEvent {
  readonly kind: "answer";
  readonly wire: Wire;
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
  readonly wire: Wire;
}

/** One queued admission a watch matched. */
export interface AdmissionEvent {
  readonly kind: "admission";
  readonly edge: "add" | "remove";
  readonly wire: Wire;
  readonly text: string;
}

/** What a job produced, once the pump has answered everything only it could. */
export type JobEvent = AnswerEvent | GroupsEvent | ValueEvent | AdmissionEvent;

/** A scope a job runs inside, established within its own engine. */
export type Scope =
  | readonly ["stack", number]
  | readonly ["module", string]
  | readonly ["transaction"]
  | readonly ["speculate"];

/** A command posted to bridge.pl's table. Payloads are transport terms. */
export type Command = readonly unknown[];

/** How a host operation answers. */
export type OpKind = "det" | "many" | "raw_det" | "raw_many";

/** The five ranked effect classes an operation declares. */
export type EffectClass =
  | "pureStructural"
  | "readOnlyLookup"
  | "nondeterministicReadOnly"
  | "writesState"
  | "oracleIO";

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
  fs.mkdirTree(virtualDir);
  for (const name of readdirSync(hostDir)) {
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
 * Every backend's control file, and nothing else under `backends/`.
 *
 * The engine READS these at boot to record which backends are present. None
 * of their `entry(engine, _)` files can load in a wasm build, which has no
 * dynamic linking and no janus, so the control file is the only thing here
 * the engine ever opens.
 *
 * mountInto would copy the whole tree, and a BUILT checkout carries the MORK
 * crate's Rust `target/` under it: 10,808 files and 3.2 GiB, which the image
 * cannot hold. That is not a slow boot, it is a dead one [measured
 * 2026-08-28 at e80fd4c3, same commit both ways: with `target/` present this
 * suite reported 70 tests, 62 pass and 8 test files aborted on `FATAL ERROR:
 * ... JavaScript heap out of memory`; with it moved aside, 203 tests and 203
 * pass].
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
  #pending: AsyncIterator<unknown> | Iterator<unknown> | null = null;

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
    let seen: JobEvent | null = null;
    if (this.#id === null) return null;
    let raw = this.#engine.rawStep(this.#id);
    for (;;) {
      const settled = this.#settle(raw);
      if (settled.done) {
        if (settled.event === null) return seen;
        seen = settled.event;
        if (this.#id === null) return seen;
        raw = this.#engine.rawStep(this.#id);
        continue;
      }
      this.close();
      throw new PettaError(
        "a host operation answered with a promise on a synchronous door; use " +
          "the awaiting form so this side can wait for it",
        { code: "ERR_METTA_UNSUPPORTED" },
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
      throw new PettaError("the engine answered nothing where one answer was required");
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
    this.#pending = null;
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
        throw new PettaError(hostText(event[1]).trimEnd());
      }
      if (tag !== "call" && tag !== "pull") {
        return { done: true, event: this.#engine.decodeEvent(tag, event) };
      }
      const reply = tag === "call" ? this.#callReply(event) : this.#pullReply();
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
    let op: HostOp;
    try {
      op = this.#engine.operation(name);
    } catch (error) {
      return ["error", messageOf(error)];
    }
    const raw = op.kind === "raw_det" || op.kind === "raw_many";
    let answered: unknown;
    try {
      const args = wires.map((wire) => atomFromWire(this.#engine.decodeWire(wire)));
      answered = op.run(raw ? args : args.map((atom) => unwrap(atom)));
    } catch (error) {
      return ["error", messageOf(error)];
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

  /** A settled answer as the reply the bridge reads. */
  #shape(settled: unknown, many: boolean): readonly unknown[] {
    if (!many) return ["ok", this.#engine.encodeValue(settled)];
    const iterator = asIterator(settled);
    if (iterator === null) return ["many", [this.#engine.encodeValue(settled)]];
    this.#pending = iterator;
    return ["stream"];
  }

  /** What to post back for one pull of a streaming host operation. */
  #pullReply(): readonly unknown[] | Promise<readonly unknown[]> {
    const iterator = this.#pending;
    if (iterator === null) return ["done"];
    let step: IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
    try {
      step = iterator.next() as IteratorResult<unknown> | Promise<IteratorResult<unknown>>;
    } catch (error) {
      this.#pending = null;
      return ["error", messageOf(error)];
    }
    if (isPromise(step)) {
      return step.then(
        (settled) => this.#step(settled),
        (error: unknown) => {
          this.#pending = null;
          return ["error", messageOf(error)] as readonly unknown[];
        },
      );
    }
    return this.#step(step);
  }

  #step(step: IteratorResult<unknown>): readonly unknown[] {
    if (step.done === true) {
      this.#pending = null;
      return ["done"];
    }
    return ["ok", this.#engine.encodeValue(step.value)];
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
    if (event === null || event.kind !== "value" || event.wire[0] !== "e") return [];
    const rows: (Capability & { present: boolean })[] = [];
    for (const row of event.wire[1]) {
      if (row[0] !== "e" || row[1].length !== 4) continue;
      const cells = row[1].map((cell) => (cell[0] === "g" ? cell[1] : ""));
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
   * Through bridge.pl's petta_node_do/2, so a Prolog exception never reaches
   * the WebAssembly boundary: swipl-wasm prints one on the host's console
   * before handing it back and has no switch for it, so the outcome crosses as
   * data and the raising happens here instead.
   */
  once(goal: string, input: Record<string, unknown> = {}): PrologAnswer {
    this.counters.crossings += 1;
    const result = this.#swipl.prolog
      .query(`petta_node_do((${goal}), Outcome).`, input)
      .once();
    if (result?.error === true) {
      throw new PettaError(`${String(result.message)} (running ${goal})`);
    }
    if (result === undefined || result["success"] === false) {
      throw new PettaError(`the engine could not run ${goal}`);
    }
    const outcome = result["Outcome"] as readonly unknown[];
    const kind = hostText(outcome[0]);
    if (kind === "error") throw new PettaError(`${hostText(outcome[1]).trimEnd()}\nrunning ${goal}`);
    if (kind !== "ok") throw new PettaError(`the engine goal failed: ${goal}`);
    return result;
  }

  /** Mount a host directory into the engine's virtual filesystem. */
  mount(hostDir: string, virtualDir: string, keep?: (name: string) => boolean): void {
    mountInto(this.#swipl.FS, hostDir, virtualDir, keep);
  }

  // --- the job protocol -----------------------------------------------------

  /** Start a job. The scopes are established inside its own engine. */
  start(command: Command, scopes: readonly Scope[] = []): Job {
    const answer = this.once("petta_node_start(Sc, Cmd, Id)", {
      Sc: [...this.scopes, ...scopes].map((scope) => [...scope]),
      Cmd: command,
    });
    return new Job(this, Number(answer["Id"]));
  }

  /** @internal One raw event, or null on exhaustion. */
  rawStep(id: number): unknown {
    const answer = this.once("petta_node_step(Id, Ev)", { Id: id });
    const events = answer["Ev"] as readonly unknown[];
    return events.length === 0 ? null : events[0];
  }

  /** @internal Post a reply and take the next raw event in one crossing. */
  rawResume(id: number, reply: readonly unknown[]): unknown {
    const answer = this.once("petta_node_resume(Id, R, Ev)", { Id: id, R: reply });
    const events = answer["Ev"] as readonly unknown[];
    return events.length === 0 ? null : events[0];
  }

  /** @internal Release a job's engine. */
  rawStop(id: number): void {
    this.once("petta_node_stop(Id)", { Id: id });
  }

  /** @internal Decode a transport term with this session's knowledge. */
  decodeWire(term: unknown): Wire {
    return decodeEngine(term, { knownSpaces: this.knownSpaces, hostValues: this.hostValues });
  }

  /**
   * @internal Encode whatever a host operation answered.
   *
   * An atom crosses as itself. Anything else is lifted first, so an ordinary
   * TypeScript function may return a number, a string or its own object and
   * the tag follows the VALUE: `n`, `g`, `b`, or a live reference under `o`.
   */
  encodeValue(value: unknown): Transport {
    return this.encodeWire(wireFromAtom(value instanceof Atom ? value : G(value)));
  }

  /** @internal Encode a wire atom as a transport term. */
  encodeWire(wire: Wire): Transport {
    return toTransport(wire, { hostValues: this.hostValues });
  }

  /** @internal Build the public event a raw one names. */
  decodeEvent(tag: string, event: readonly unknown[]): JobEvent {
    switch (tag) {
      case "answer":
        return { kind: "answer", wire: this.decodeWire(event[1]), text: hostText(event[2]) };
      case "value":
        return { kind: "value", wire: this.decodeWire(event[1]) };
      case "groups":
        return {
          kind: "groups",
          groups: (event[1] as readonly unknown[]).map((group) =>
            (group as readonly unknown[]).map((pair) => {
              const answer = pair as readonly unknown[];
              return {
                kind: "answer" as const,
                wire: this.decodeWire(answer[0]),
                text: hostText(answer[1]),
              };
            }),
          ),
        };
      case "admission":
        return {
          kind: "admission",
          edge: hostText(event[1]) === "remove" ? "remove" : "add",
          wire: this.decodeWire(event[2]),
          text: hostText(event[3]),
        };
      default:
        throw new PettaError(`the bridge produced an event this host does not read: ${tag}`);
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

  /** @internal The operation behind a dispatch, or a refusal naming it. */
  operation(name: string): HostOp {
    for (const op of this.#ops.values()) if (op.name === name) return op;
    throw new PettaError(`the engine called ${name}, which this host has not registered`, {
      code: "ERR_METTA_NAME",
    });
  }

  // --- the codec doors, which need no engine --------------------------------

  /** One atom of MeTTa source, through the engine's own reader. */
  read(text: string): Wire {
    const answer = this.once("petta_node_read(Src, Wire)", { Src: text });
    return this.decodeWire(answer["Wire"]);
  }

  /** An atom's round trip through the engine: decode it, then encode it back. */
  roundTrip(wire: Wire): Wire {
    const transport = this.encodeWire(wire);
    const answer = this.once("petta_node_decode(W, T), petta_node_encode(T, Out)", {
      W: transport,
    });
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
  text(wire: Wire): string {
    const answer = this.once("petta_node_decode(W, T), sdisplay(T, S)", {
      W: this.encodeWire(wire),
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

  /** Release the host values this engine was holding. */
  dispose(): void {
    this.hostValues.clear();
  }
}

/** The strict wire decoder, re-exported so a conformance kit reaches it. */
export { fromTransport, toTransport };

/**
 * Boot the engine in this process.
 *
 * `root` is the PeTTa checkout; the default is the one this package lives in.
 * The engine's own `silent` flag goes in argv rather than being retracted
 * afterwards, because argv is where engine/filereader.pl reads it and
 * engine/main.pl already lists it as an engine flag.
 */
export async function boot(
  options: { root?: string; verbose?: boolean } = {},
): Promise<Engine> {
  const root = options.root ?? REPO_ROOT;
  const verbose = options.verbose ?? false;
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

  const flags = verbose ? "['backends']" : "['backends', silent]";
  swipl.prolog.query(`set_prolog_flag(argv, ${flags}).`).once();
  const consulted = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/engine/metta.pl').`).once();
  if (consulted?.error === true) {
    throw new PettaError(`the engine did not load: ${String(consulted.message)}`);
  }

  refuseUnnamedErrors(stderr);
  stderr.length = 0;
  output.length = 0;

  const bridged = swipl.prolog.query(`consult('${VIRTUAL_ROOT}/bridge.pl').`).once();
  if (bridged?.error === true) {
    throw new PettaError(`the Node bridge did not load: ${String(bridged.message)}`);
  }

  return new Engine(swipl, output, stderr);
}
