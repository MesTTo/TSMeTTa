/**
 * Purpose: a space over HTTP, both ends. The client is an ordinary
 *   {@link SpaceProvider} so a remote space is queried exactly as a local one
 *   is; the server answers the protocol this repository already specifies, so
 *   either end interoperates with the Python seat's and with the reference
 *   TypeScript servers.
 * Assumes:
 *   - the wire is `website/live/remote-protocol.md` revision 3: eight POST
 *     operations plus `GET /health`, JSON bodies both ways, atoms as tagged
 *     arrays in the codec's CORE PROFILE. That page is the contract and this
 *     file implements it rather than inventing beside it
 *   - an `n` payload is a JSON NUMBER, as CODEC.md's `n` row and
 *     `tests/codec/corpus.json` say; the literal tells an integer from a float
 *     and an integer is exact at any width, which is why both ends read and
 *     write through {@link readJson} and {@link writeJson} rather than through
 *     `JSON.parse` and `JSON.stringify`
 *   - a body is capped at 16 MiB in both directions, which is why an answer
 *     set larger than that crosses through the cursor lifecycle and not
 *     through `/match`
 * Guarantees:
 *   - matching an attached space is LAZY: it opens a cursor, pulls a batch at
 *     a time and stops, so taking two answers of a million costs two answers'
 *     work on the serving engine too
 *     [tested: "takes two answers without the third being computed"]
 *   - a `null` cursor ends a stream and the server has already released it; a
 *     short chunk ends it; an EMPTY chunk beside a live cursor is a protocol
 *     violation and is refused rather than looped on
 *     [tested: "refuses an empty chunk beside a live cursor"]
 *   - `clear` does not cross, because it is destructive and tenant-wide; the
 *     protocol says to spell it as a removal instead
 *   - a bearer token is compared in CONSTANT TIME and checked before the body
 *     is read [tested: "refuses a wrong token before reading the body"]
 *   - every JSON body, sent or received, is read through {@link readJson}, so
 *     an object naming one key twice is REFUSED at both ends rather than
 *     collapsed to the last value the way `JSON.parse` collapses it
 *     [tested: "refuses a body that names one key twice",
 *     "refuses an answer that names one key twice"]
 *   - a number survives a crossing to the OTHER seat unchanged, for every
 *     class the `n` tag has: an integer, a float, a float whose value is
 *     whole, a negative fraction, and an integer past every JavaScript number
 *     [tested:
 *     extensions/python/tests/ch21_another_language_at_the_seam/test_node_binding.py,
 *     test_a_python_client_reads_every_number_class_from_a_node_gateway,
 *     test_a_node_client_reads_every_number_class_from_a_python_gateway]
 *   - a non-finite float is REFUSED on this wire in the engine's own sentence,
 *     because JSON has no literal for one [source: CODEC.md, "A non-finite
 *     float is carried by an encoding that has a spelling for one and refused
 *     by an encoding that does not"; tested:
 *     test_both_seats_refuse_a_non_finite_float_on_the_json_wire]
 *   - operation refusals use the protocol's single 4xx error shape, whatever
 *     local class produced them [tested: "uses one protocol error status for every refusal";
 *     commit=d6342cff24b7c087b464d9cdb13b71a3d9a115a2]
 * Owns: on the server side, one cursor per open stream, each released by
 *   `/stop`, by an idle deadline, or by the gateway closing.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Atom } from "./atom.ts";
import { MettaError, TransportError } from "./errors.ts";
import { showsAs } from "./present.ts";
import type { DeliveryPromise, ProviderCapability, SpaceProvider } from "./provider.ts";
import type { Space } from "./space.ts";
import {
  type Transport as Wire,
  atomFromWire,
  fromTransport,
  toTransport,
  transportFromJson,
  transportToJson,
  wireFromAtom,
} from "./wire.ts";

/** The protocol revision this end speaks. */
export const PROTOCOL = 3;

/** The largest body either end will send or accept, in bytes. */
export const BODY_LIMIT: number = 16 * 1024 * 1024;

/** What `GET /health` answers. */
export interface Health {
  readonly ok: boolean;
  readonly atoms: number;
  readonly protocol: number;
  readonly capabilities: readonly string[];
  readonly bound: boolean;
}

/** One chunk of a streamed answer set, and the cursor that continues it. */
export interface RemoteChunk {
  /** The answers in this chunk, on the wire. */
  readonly atoms: readonly Wire[];
  /** The cursor to pull the next chunk from, or null when the set ended. */
  readonly cursor: string | null;
}

/**
 * The body one request carries.
 *
 * Every field is optional here because the eight operations take different
 * subsets of them; which ones each requires is the protocol page's table, and
 * the gateway refuses a body that is missing one rather than guessing.
 */
export interface RemoteRequest {
  /** Which served space the operation is about. */
  readonly space?: string;
  /** The pattern to match, on the wire. */
  readonly pattern?: Wire;
  /** The atom to add or remove, on the wire. */
  readonly atom?: Wire;
  /** Several atoms to add at once. */
  readonly atoms?: readonly Wire[];
  /** How many answers to take per chunk. */
  readonly batch?: number;
  /** How many answers the caller will take in total, when it knows. */
  readonly bound?: number;
  /** The cursor to continue or release. */
  readonly cursor?: string;
}

/**
 * One JSON value off this wire, read the way the engine's codec reads it.
 *
 * `JSON.parse` cannot answer the question a repeated key asks. Its reviver
 * runs after each object is BUILT, so the duplicate has already collapsed to
 * the last value before anything can look, where Python's `object_pairs_hook`
 * is handed every pair as it is read. The engine's codec REFUSES a repeated
 * key on this wire and the Python gateway answers 400 for one, so a body both
 * ends must read the same way cannot go through a bare `JSON.parse`
 * [source: extensions/python/metta/_binding/shim.pl, metta_py_json_options/1 asking for
 * shape(dicts) and metta_py_json_rethrow/1 turning duplicate_key(Key) into
 * "JSON object repeats the key <k>"; extensions/python/metta/remote/__init__.py,
 * Handler._payload; tested:
 * extensions/python/tests/ch03_atoms_and_expressions/test_json.py,
 * test_json_codec_refuses_duplicate_keys]. The ruling is a refusal rather than
 * a last-wins policy because dropping the first value silently lets a peer
 * smuggle one value past a reader that saw the other.
 *
 * `JSON.parse` still does the parsing; a second pass over the same text finds
 * the keys, which is protobuf.js's shape for the same law
 * [source: protobufjs/protobuf.js ext/protojson.js, checkDuplicateKeys]. The
 * pass runs AFTER the parse, so it only ever walks text that is already valid
 * JSON and a malformed body keeps `JSON.parse`'s own syntax message.
 *
 * The MeTTa surface's `json-decode` is a DIFFERENT door with a different
 * ruling: it asks the same codec for shape(classic), which keeps both pairs
 * [source: lib/lib_json/lib_json.pl, lib_json_options/1]. This one is the
 * wire.
 */
export function readJson(text: string): unknown {
  const value: unknown = transportFromJson(text);
  refuseRepeatedKeys(text);
  return value;
}

/**
 * One document as the JSON text this wire carries.
 *
 * `JSON.stringify` writes the float 1.0 as `1` and refuses a `bigint`
 * outright, so it cannot write this protocol's atoms at all: an integral float
 * would arrive as an integer and a wide integer could not be sent
 * [source: CODEC.md, "Number and BigInt are exact, or refused"]. This is
 * `transportToJson`, which places each `n` payload as its own literal, under
 * the name the reading half already has.
 */
export function writeJson(value: unknown): string {
  return transportToJson(value);
}

/**
 * Refuse a JSON object that names one key twice, naming the key.
 *
 * A structural scan, which is all this needs: only `{ } [ ] : , "` decide
 * where a key is, and every other byte of a number, a keyword or a value
 * string is skipped one at a time. `keys` is both the target and the flag,
 * so "the next string is a key" and "the object it belongs to" cannot
 * disagree.
 */
function refuseRepeatedKeys(text: string): void {
  // The objects still open, innermost last. `undefined` marks an open ARRAY,
  // which has no keys of its own.
  const open: (Set<string> | undefined)[] = [];
  let keys: Set<string> | undefined;
  let at = 0;
  while (at < text.length) {
    const here = text[at];
    if (here === "{") {
      const fresh = new Set<string>();
      open.push(fresh);
      keys = fresh;
      at += 1;
    } else if (here === "[") {
      open.push(undefined);
      keys = undefined;
      at += 1;
    } else if (here === "}" || here === "]") {
      open.pop();
      keys = undefined;
      at += 1;
    } else if (here === ":") {
      keys = undefined;
      at += 1;
    } else if (here === ",") {
      keys = open[open.length - 1];
      at += 1;
    } else if (here !== '"') {
      at += 1;
    } else {
      const from = at;
      let escaped = false;
      at += 1;
      while (at < text.length) {
        const step = text[at];
        at += 1;
        if (step === '"') break;
        if (step !== "\\") continue;
        // A backslash consumes whatever follows it, `\uXXXX` included: the
        // four hex digits are ordinary characters and none of them can end
        // the string, so skipping the one escaped character still lands on
        // the real closing quote.
        escaped = true;
        at += 1;
      }
      if (keys === undefined) continue;
      // A JSON string with no backslash IS its own decoding, so the ordinary
      // key costs a slice; an escaped one goes back through the parser rather
      // than through a second escape table written here. The comparison is on
      // the DECODED name, which is what makes `{"a":1,"a":2}` a repeat
      // [tested: "reads a repeated JSON key the way the engine's codec reads one";
      // commit=25c518d08f68d2566229f61fe86cc69c6ee21f0d].
      const token = text.slice(from, at);
      const key = escaped ? (JSON.parse(token) as string) : token.slice(1, -1);
      if (keys.has(key)) throw new MettaError(`JSON object repeats the key ${key}`);
      keys.add(key);
      keys = undefined;
    }
  }
}

/**
 * How a request reaches the other end.
 *
 * Supplied rather than assumed, so the same protocol runs over a worker, a
 * message port or a test double without this module knowing about any of them.
 */
export interface Transport {
  post(path: string, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>>;
  health(): Promise<Health>;
}

/** A transport over HTTP, using the platform's own `fetch`. */
export function httpTransport(url: string, options: { readonly token?: string } = {}): Transport {
  const base = url.replace(/\/+$/, "");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  return {
    async post(path: string, body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
      const payload = writeJson(body);
      if (payload.length > BODY_LIMIT) {
        throw new TransportError(
          `this request is ${String(payload.length)} bytes and the protocol caps a body at ` +
            `${String(BODY_LIMIT)}; stream it instead`,
        );
      }
      const answered = await fetch(`${base}${path}`, { method: "POST", headers, body: payload });
      // `Response.json` is `JSON.parse`, so a peer's repeated key would be
      // last-wins here while the Python client refuses it
      // [source: extensions/python/metta/remote/__init__.py, the _json.loads on every
      // answer]. Both ends of this protocol read the same way.
      const held = readJson(await answered.text()) as Record<string, unknown>;
      if (!answered.ok || typeof held["error"] === "string") {
        throw new TransportError(
          `${path} refused with ${String(answered.status)}: ${String(held["error"] ?? answered.statusText)}`,
        );
      }
      return held;
    },
    async health(): Promise<Health> {
      const answered = await fetch(`${base}/health`, { headers });
      if (!answered.ok) {
        throw new TransportError(`/health refused with ${String(answered.status)}`);
      }
      return readJson(await answered.text()) as Health;
    },
  };
}

function atomsOf(held: Record<string, unknown>): Atom[] {
  const wires = held["atoms"];
  if (!Array.isArray(wires)) throw new TransportError("the answer carried no atoms array");
  return wires.map((wire) => atomFromWire(fromTransport(wire as Wire)));
}

function chunkOf(held: Record<string, unknown>): RemoteChunk {
  const cursor = held["cursor"];
  if (cursor !== null && typeof cursor !== "string") {
    throw new TransportError("a chunk's cursor is a string or null");
  }
  const wires = held["atoms"];
  if (!Array.isArray(wires)) throw new TransportError("a chunk carried no atoms array");
  return { atoms: wires as Wire[], cursor };
}

/** What `RemoteSpace` accepts. */
export interface RemoteOptions {
  /** Which of the server's spaces to read. `&self` by default. */
  readonly space?: string;
  /** How many answers one chunk may carry. One by default, the protocol's own. */
  readonly batch?: number;
  /** What the remote side promises about its change events, when it has said. */
  readonly delivers?: DeliveryPromise;
}

/**
 * A space on another machine, as an ordinary provider.
 *
 * ```ts
 * const hq = m.attach("&hq", connect("http://hq:8700"));
 * for await (const { id } of hq.match(S.users(V.id, V.name))) { ... }
 * ```
 *
 * Matching is LAZY: it opens a cursor and pulls a batch at a time, so leaving
 * the loop early stops the serving engine too. `atoms()` is the one-shot door,
 * because give-me-everything has no early exit to protect.
 */
export class RemoteSpace implements SpaceProvider {
  readonly #transport: Transport;
  readonly #space: string;
  readonly #batch: number;
  readonly #delivers: DeliveryPromise | undefined;

  constructor(transport: Transport, options: RemoteOptions = {}) {
    this.#transport = transport;
    this.#space = options.space ?? "&self";
    this.#batch = options.batch ?? 1;
    this.#delivers = options.delivers;
  }

  /** What the server says it is and what it admits. */
  async serverCapabilities(): Promise<Health> {
    return this.#transport.health();
  }

  async *atoms(): AsyncGenerator<Atom> {
    yield* atomsOf(await this.#transport.post("/atoms", { space: this.#space }));
  }

  /** Every candidate for a pattern, pulled a chunk at a time. */
  async *match(pattern: Atom): AsyncGenerator<Atom> {
    yield* this.stream(pattern, this.#batch);
  }

  /**
   * The lazy door, spelled out: ask, pull, stop.
   *
   * `stop` runs from a `finally`, which is what makes leaving a `for await`
   * early release the serving engine's cursor. Stopping a cursor the server
   * has already released answers `{"stopped": false}` and is not an error,
   * because that is exactly where a finally-block calls it from.
   */
  async *stream(pattern: Atom, batch: number = this.#batch): AsyncGenerator<Atom> {
    let chunk = chunkOf(
      await this.#transport.post("/ask", {
        space: this.#space,
        pattern: toTransport(wireFromAtom(pattern)),
        batch,
      }),
    );
    try {
      for (;;) {
        for (const wire of chunk.atoms) yield atomFromWire(fromTransport(wire));
        const cursor = chunk.cursor;
        if (cursor === null) return;
        chunk = chunkOf(await this.#transport.post("/next", { cursor, batch }));
        if (chunk.atoms.length === 0 && chunk.cursor !== null) {
          // An empty chunk beside a live cursor would spin this loop forever,
          // and the protocol forbids one. Refusing is what the shipped client
          // does rather than looping.
          throw new TransportError(
            "the server answered an empty chunk beside a live cursor, which the " +
              "protocol forbids",
          );
        }
      }
    } finally {
      if (chunk.cursor !== null) {
        await this.#transport.post("/stop", { cursor: chunk.cursor }).catch(() => undefined);
      }
    }
  }

  async add(atom: Atom): Promise<void> {
    await this.#transport.post("/add", {
      space: this.#space,
      atom: toTransport(wireFromAtom(atom)),
    });
  }

  /** Add several in ONE request, which is the transport batch the protocol has. */
  async addMany(atoms: readonly Atom[]): Promise<number> {
    const held = await this.#transport.post("/add_many", {
      space: this.#space,
      atoms: atoms.map((atom) => toTransport(wireFromAtom(atom))),
    });
    return Number(held["added"] ?? 0);
  }

  async remove(atom: Atom): Promise<boolean> {
    const held = await this.#transport.post("/remove", {
      space: this.#space,
      atom: toTransport(wireFromAtom(atom)),
    });
    return held["removed"] === true;
  }

  /** What the remote side promised about its change events, if anything. */
  delivers(): DeliveryPromise | undefined {
    return this.#delivers;
  }

  /**
   * Why `clear` is not here.
   *
   * The protocol leaves it off the wire deliberately: it is destructive and
   * tenant-wide, and a caller who means it spells it as a removal of what
   * they meant to remove.
   */
  refusal(capability: ProviderCapability): string | undefined {
    if (capability !== "clear") return undefined;
    return (
      "clear does not cross the remote protocol: it is destructive and " +
      "tenant-wide, so remove what you mean to remove instead"
    );
  }

  toString(): string {
    return `RemoteSpace(${this.#space})`;
  }
}

showsAs(RemoteSpace.prototype, (space: RemoteSpace) => space.toString());

/** Connect to a remote engine and answer the provider for one of its spaces. */
export function connect(url: string, options: RemoteOptions & { readonly token?: string } = {}): RemoteSpace {
  const transport =
    options.token === undefined ? httpTransport(url) : httpTransport(url, { token: options.token });
  const { token: _token, ...rest } = options;
  return new RemoteSpace(transport, rest);
}

// ---------------------------------------------------------------------------
// The serving half.

/** What `serve` accepts. */
export interface ServeOptions {
  /** The spaces to expose. Nothing else is reachable. */
  readonly spaces: readonly Space[];
  /** The port. Zero picks a free one, which `Gateway.port` then reports. */
  readonly port?: number;
  /** The interface to listen on. Loopback by default, which is the safe one. */
  readonly host?: string;
  /** A bearer token every request must carry. */
  readonly token?: string;
  /** How long a cursor nobody pulls from is held, in milliseconds. */
  readonly cursorIdle?: number;
  /** How many cursors may be open at once. */
  readonly cursorLimit?: number;
}

/**
 * One answer set the gateway is part way through, held between pulls.
 *
 * The server keeps the ITERATOR rather than the answers, which is what makes
 * the lifecycle lazy on both sides: a client that takes two of a thousand
 * costs the serving engine two.
 */
export interface RemoteCursor {
  /** Where the next chunk comes from. */
  readonly answers: AsyncIterator<Atom>;
  /** When it was last pulled from, for the idle sweep. */
  touched: number;
}

/** A running gateway, and the port it took. */
export class Gateway implements AsyncDisposable {
  readonly #server: Server;
  readonly #port: number;
  readonly #cursors: Map<string, RemoteCursor>;

  /** @internal Use {@link serve}. */
  constructor(server: Server, port: number, cursors: Map<string, RemoteCursor>) {
    this.#server = server;
    this.#port = port;
    this.#cursors = cursors;
  }

  /** The port it is listening on, which is the assigned one when zero was asked. */
  get port(): number {
    return this.#port;
  }

  /** The base URL a client connects to. */
  get url(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  /** How many cursors are open right now. */
  get cursors(): number {
    return this.#cursors.size;
  }

  /** Stop listening, and release every cursor still held. */
  async close(): Promise<void> {
    for (const held of this.#cursors.values()) await held.answers.return?.(undefined);
    this.#cursors.clear();
    await new Promise<void>((resume) => this.#server.close(() => resume()));
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  toString(): string {
    return `Gateway(:${String(this.#port)}, ${String(this.#cursors.size)} cursors)`;
  }
}

showsAs(Gateway.prototype, (gateway: Gateway) => gateway.toString());

/** Whether two secrets match, without leaking how far they matched. */
function sameSecret(given: string, wanted: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(wanted);
  // Compared at equal length so the comparison itself cannot be timed; the
  // length difference is folded in rather than short-circuiting on it.
  const padded = Buffer.alloc(Math.max(a.length, b.length));
  const other = Buffer.alloc(padded.length);
  a.copy(padded);
  b.copy(other);
  return timingSafeEqual(padded, other) && a.length === b.length;
}

let nextCursor = 0;

/**
 * Serve chosen spaces over the remote protocol.
 *
 * ```ts
 * await using gateway = await serve({ spaces: [kb], port: 0, token: secret });
 * const there = connect(gateway.url, { token: secret });
 * ```
 *
 * Only the spaces given are reachable. The default host is loopback, because
 * a knowledge base exposed to every interface by default is a decision nobody
 * made on purpose.
 */
export async function serve(options: ServeOptions): Promise<Gateway> {
  if (options.spaces.length === 0) throw new MettaError("serve needs at least one space");
  const byName = new Map(options.spaces.map((space) => [space.name, space]));
  const cursors = new Map<string, RemoteCursor>();
  const idle = options.cursorIdle ?? 300_000;
  const limit = options.cursorLimit ?? 64;

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [id, held] of cursors) {
      if (now - held.touched < idle) continue;
      cursors.delete(id);
      void held.answers.return?.(undefined);
    }
  }, Math.max(1_000, Math.floor(idle / 4)));
  sweep.unref();

  const server = createServer((request, response) => {
    void handle(request, response, byName, cursors, limit, options);
  });
  const port = await new Promise<number>((resume, refuse) => {
    server.once("error", refuse);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      resume(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  server.once("close", () => {
    clearInterval(sweep);
  });
  return new Gateway(server, port, cursors);
}

/** Every seam operation this gateway admits, in the health row's own words. */
const CAPABILITIES: readonly string[] = ["match", "enumerate", "add", "remove", "stream"];

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  spaces: ReadonlyMap<string, Space>,
  cursors: Map<string, RemoteCursor>,
  limit: number,
  options: ServeOptions,
): Promise<void> {
  const reply = (status: number, body: unknown): void => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(writeJson(body));
  };
  // The credential is checked BEFORE the body is read, which is what the
  // protocol asks and what keeps an unauthorised request from costing
  // anything.
  if (options.token !== undefined) {
    const given = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!sameSecret(given, options.token)) {
      reply(401, { error: "this gateway needs a bearer token" });
      return;
    }
  }
  const path = (request.url ?? "/").split("?")[0] ?? "/";
  if (request.method === "GET" && path === "/health") {
    let total = 0;
    for (const space of spaces.values()) total += space.size;
    reply(200, {
      ok: true,
      atoms: total,
      protocol: PROTOCOL,
      capabilities: CAPABILITIES,
      // This gateway does not truncate: its matcher over-approximates through
      // the engine, and only an exact matcher may honour a bound.
      bound: false,
    } satisfies Health);
    return;
  }
  if (request.method !== "POST") {
    reply(405, { error: `${String(request.method)} ${path} is not one of this protocol's` });
    return;
  }
  try {
    const body = await readBody(request);
    reply(200, await perform(path, body, spaces, cursors, limit));
  } catch (error) {
    reply(400, { error: String(error instanceof Error ? error.message : error) });
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = Number(request.headers["content-length"] ?? Number.NaN);
  if (!Number.isInteger(length)) {
    throw new MettaError("this protocol needs Content-Length, and no Transfer-Encoding");
  }
  if (length > BODY_LIMIT) throw new MettaError(`a body is capped at ${String(BODY_LIMIT)} bytes`);
  const chunks: Buffer[] = [];
  let seen = 0;
  for await (const chunk of request) {
    seen += (chunk as Buffer).length;
    if (seen > BODY_LIMIT) throw new MettaError(`a body is capped at ${String(BODY_LIMIT)} bytes`);
    chunks.push(chunk as Buffer);
  }
  const parsed: unknown = readJson(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MettaError("a body is one JSON object");
  }
  return parsed as Record<string, unknown>;
}

function boundOf(body: Record<string, unknown>): number | undefined {
  const held = body["bound"];
  if (held === undefined || held === null) return undefined;
  if (typeof held !== "number" || !Number.isInteger(held) || held < 0) {
    throw new MettaError("bound is a nonnegative whole number");
  }
  return held;
}

function batchOf(body: Record<string, unknown>): number {
  const held = body["batch"];
  if (held === undefined || held === null) return 1;
  if (typeof held !== "number" || !Number.isInteger(held) || held <= 0) {
    throw new MettaError("batch is a positive whole number");
  }
  return held;
}

async function perform(
  path: string,
  body: Record<string, unknown>,
  spaces: ReadonlyMap<string, Space>,
  cursors: Map<string, RemoteCursor>,
  limit: number,
): Promise<unknown> {
  const named = (): Space => {
    const name = typeof body["space"] === "string" ? body["space"] : "&self";
    const space = spaces.get(name);
    if (space === undefined) throw new MettaError(`this gateway does not serve ${name}`);
    return space;
  };
  const pattern = (): Atom => {
    const held = body["pattern"] ?? body["atom"];
    if (held === undefined) throw new MettaError(`${path} needs an atom`);
    return atomFromWire(fromTransport(held as Wire));
  };
  const crossing = (atoms: readonly Atom[]): Wire[] =>
    atoms.map((atom) => toTransport(wireFromAtom(atom)));

  switch (path) {
    case "/match": {
      const asked = pattern();
      const bound = boundOf(body);
      const answers = named().match(asked, asked);
      const held = await (bound === undefined ? answers : answers.take(bound)).toArray();
      return { atoms: crossing(held) };
    }
    case "/atoms":
      return { atoms: crossing(await named().atoms().toArray()) };
    case "/add":
      named().add(pattern());
      return { added: true };
    case "/add_many": {
      const wires = body["atoms"];
      if (!Array.isArray(wires)) throw new MettaError("add_many takes an atoms array");
      const atoms = wires.map((wire) => atomFromWire(fromTransport(wire as Wire)));
      named().add(...atoms);
      return { added: atoms.length };
    }
    case "/remove":
      return { removed: named().delete(pattern()) };
    case "/ask": {
      if (cursors.size >= limit) throw new MettaError(`this gateway holds ${String(limit)} cursors`);
      const asked = pattern();
      const answers = named().match(asked, asked)[Symbol.asyncIterator]();
      nextCursor += 1;
      const id = `c${String(nextCursor)}-${String(Date.now())}`;
      cursors.set(id, { answers, touched: Date.now() });
      return pull(id, cursors, batchOf(body));
    }
    case "/next": {
      const id = body["cursor"];
      if (typeof id !== "string") throw new MettaError("next takes a cursor");
      // A cursor the gateway no longer holds is an ERROR, not an empty answer:
      // answering nothing would claim the enumeration ended.
      if (!cursors.has(id)) throw new MettaError(`no such cursor: ${id}`);
      return pull(id, cursors, batchOf(body));
    }
    case "/stop": {
      const id = body["cursor"];
      if (typeof id !== "string") throw new MettaError("stop takes a cursor");
      const held = cursors.get(id);
      if (held === undefined) return { stopped: false };
      cursors.delete(id);
      await held.answers.return?.(undefined);
      return { stopped: true };
    }
    default:
      throw new MettaError(`no such operation: ${path}`);
  }
}

/**
 * One chunk from a cursor, releasing it when the answers run out.
 *
 * A short chunk ends the stream and the cursor is already gone, which is the
 * contract that lets a client stop asking without a second round trip.
 */
async function pull(id: string, cursors: Map<string, RemoteCursor>, batch: number): Promise<RemoteChunk> {
  const held = cursors.get(id) as RemoteCursor;
  held.touched = Date.now();
  const atoms: Atom[] = [];
  for (let taken = 0; taken < batch; taken += 1) {
    const step = await held.answers.next();
    if (step.done === true) {
      cursors.delete(id);
      return { atoms: atoms.map((atom) => toTransport(wireFromAtom(atom))), cursor: null };
    }
    atoms.push(step.value);
  }
  return { atoms: atoms.map((atom) => toTransport(wireFromAtom(atom))), cursor: id };
}
