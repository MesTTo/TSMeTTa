/**
 * Purpose: the codec between MeTTa atoms and the tagged wire terms the engine
 *   reads and writes, in both directions, at both strictnesses, and in both of
 *   the two serialisations of the one tag grammar.
 * Assumes:
 *   - the tags are `CODEC.md`'s: s symbol, v variable, n number, g string,
 *     b boolean, e expression, p portable space handle, o live host value
 *   - a number's payload is canonical Prolog TEXT, because the WebAssembly
 *     value conversion renders the float 2.0 and the integer 2 as the same
 *     JavaScript number and MeTTa answers `false` to `(== 2 2.0)`
 *     [measured 2026-08-30 against
 *     PeTTa@ae66fa8e41dcd5539d614706bd4e5cfb34f9608d]
 * Guarantees:
 *   - every Prolog integer arrives as a `bigint` and every Prolog float as a
 *     `number`, which is the only pair of JavaScript types that tells 2 from
 *     2.0 apart [tested: "keeps the integer and the float apart across the wire"]
 *   - a value JavaScript has no type for (a rational) is refused by name
 *     [tested: "refuses a value JavaScript has no type for, by name"]
 *   - `fromTransport` is STRICT: it refuses the `o` tag [tested: "refuses the o tag,
 *     which only this host's own session can name"], because an `o`
 *     payload written down by somebody else is not a reference this host can
 *     honour, while the private engine transport carries `["o", id]` for an id
 *     this host handed out
 *   - a `p` name decodes to an interned {@link SpaceHandle}, so one name is one
 *     handle [tested: "decodes a portable space reference into an interned
 *     handle"]
 *   - NOTHING here recurses per nesting level: every walk carries its depth on
 *     an explicit worklist, so a term's depth costs heap and never the
 *     JavaScript call stack
 *     [tested: carries a term a hundred thousand deep through every codec leg;
 *     commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8]
 *   - the engine path builds NO intermediate tree: {@link decodeEngine} reads
 *     the flat token list straight into atoms and {@link encodeEngine} writes
 *     atoms straight into tokens
 *     [tested: spells an expression as its tag, its child count and its children;
 *     commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8]
 *   - a numeric root cannot impersonate the worklist's expression-close marker
 *     [tested: "refuses a numeric root before it can impersonate an
 *     expression-close marker"; commit=d3b3d62e19cd5dc941a6af8df24bc48992327236]
 *   - repeated crossings of one primitive host value reuse its live handle
 *     [tested: "reuses one host id for each primitive value";
 *     commit=e4367498bed06c34f25aff75335e7b25f28b3b73]
 *   - round-trip space provenance is restored only while the sent and received
 *     token streams have the same structural path; a scalar leaf change keeps
 *     later siblings aligned [tested: "does not align provenance across a shape change",
 *     "keeps later provenance aligned when only a leaf type changes";
 *     commit=2da346c3fa02a9baedb6168e6b3f6e0756bd6c91]
 * Owns: the live-host-value table. A value that crossed into the engine is
 *   retained until the engine is disposed, because nothing on this side can
 *   observe that the engine has dropped the id.
 * Decides: cursors and host values are addressed by integer, because the
 *   WebAssembly value conversion renders every Prolog blob as the same opaque
 *   `{"$t":"b"}` and a host that kept the blob could not hand it back.
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  Atom,
  Expression,
  FloatAtom,
  G,
  Grounded,
  SpaceHandle,
  Sym,
  Var,
  exprOf,
  float,
  space,
  sym,
  variable,
} from "./atom.ts";
import { MettaError, WireError } from "./errors.ts";

/** The tags this binding speaks. `h` is the engine's own blob and is refused here. */
export type Tag = "s" | "v" | "n" | "g" | "b" | "e" | "p" | "o";

/** A wire atom as this host holds it: the tag, and a payload in host types. */
export type Wire =
  | readonly ["s", string]
  | readonly ["v", string]
  | readonly ["n", number | bigint]
  | readonly ["g", string]
  | readonly ["b", boolean]
  | readonly ["p", SpaceHandle]
  | readonly ["o", unknown]
  | readonly ["e", readonly Wire[]];

/**
 * The PORTABLE serialisation: one tagged pair per atom, nested, payloads text.
 *
 * This is the written-down grammar, the one `tests/codec/corpus.json` records,
 * the one the Python host writes, and the one `metta-node/remote` puts on the
 * network. {@link WireTokens} is the same grammar serialised flat, and that is what
 * crosses into this engine.
 */
export type Transport = readonly [string, unknown];

/**
 * The ENGINE serialisation: one flat preorder token list, arity-prefixed.
 *
 * A leaf is its tag followed by its payload, which is the portable spelling of
 * a leaf unchanged; an expression is `e`, its child COUNT, and then its
 * children's tokens in order. `(f 1)` crosses as `["e", 2, "s", "f", "n", "1"]`.
 *
 * The shape is prefix notation with explicit arity, which is what SWI's own
 * `PL_record_external` (behind `library(fastrw)`) writes for a compound term
 * [source: https://www.swi-prolog.org/pldoc/man?section=fast-term-io]. It is
 * used here for one reason: swipl-wasm's `Prolog.toJSON` recurses once per
 * NESTED element and its `toProlog` recurses once per nested array, so a
 * nested term of depth N costs N JavaScript frames in each direction, while a
 * flat list of atomic tokens goes through `toJSON`'s `PL_LIST_PAIR` while-loop
 * and `toProlog`'s `toList` loop at constant depth. That is not a tidiness
 * point: when the stack runs out INSIDE the WebAssembly call the engine is
 * left unusable rather than raising [measured 2026-08-31, see C47].
 */
export type WireTokens = readonly unknown[];

function wireError(message: string): MettaError {
  return new WireError(message);
}

/**
 * Text as it arrives from the WebAssembly conversion.
 *
 * A Prolog atom crosses as a JavaScript string and a Prolog STRING crosses as
 * a wrapper object carrying `$t: "s"`, which has neither `toString` nor
 * `valueOf`, so `String()` on one throws "Cannot convert object to primitive
 * value" rather than giving the text [measured 2026-08-20]. Both spellings
 * mean the same thing on this side and this is where they become one.
 */
export function hostText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const tagged = value as { $t?: unknown; v?: unknown };
    if (tagged.$t === "s" && typeof tagged.v === "string") return tagged.v;
  }
  throw wireError(`expected text from the engine, got ${JSON.stringify(value)}`);
}

// The spellings SWI's ~q writes and its reader takes back, measured
// 2026-08-20: an integer is bare digits, a float carries a point or an
// exponent, positive infinity is 1.0Inf, and a NaN is a float glued to NaN,
// whose mantissa is the payload's own and varies.
const INTEGER_TEXT = /^-?\d+$/;
const FLOAT_TEXT = /^-?(?:\d+\.\d+(?:[eE][-+]?\d+)?|\d+[eE][-+]?\d+)$/;
const INFINITY_TEXT = /^(?<sign>-?)1\.0Inf$/;
const NAN_TEXT = /^-?\d+\.\d+NaN$/;
const NAN_SPELLING = "1.5NaN";

/** A canonical Prolog number spelling as the host value it names. */
export function numberFromText(text: string): number | bigint {
  if (INTEGER_TEXT.test(text)) return BigInt(text);
  if (FLOAT_TEXT.test(text)) return Number(text);
  const infinite = INFINITY_TEXT.exec(text);
  if (infinite !== null) return infinite.groups?.["sign"] === "-" ? -Infinity : Infinity;
  if (NAN_TEXT.test(text)) return NaN;
  throw wireError(
    `the number ${text} has no JavaScript type; a rational crosses as its ` +
      `Prolog spelling and this host has nothing to hold it in`,
  );
}

/** A host number as the canonical Prolog text the reader takes back. */
export function numberToText(value: number | bigint): string {
  if (typeof value === "bigint") return value.toString();
  if (Number.isNaN(value)) return NAN_SPELLING;
  if (value === Infinity) return "1.0Inf";
  if (value === -Infinity) return "-1.0Inf";
  // A MeTTa float must go back as one, so a spelling the Prolog reader would
  // take as an integer gets its point back, and an exponent gets a mantissa.
  // String(-0) is "0", which loses the sign a double carries, so negative zero
  // is spelled here rather than left to it.
  const text = Object.is(value, -0) ? "-0" : String(value);
  if (text.includes(".")) return text;
  const exponent = text.indexOf("e");
  if (exponent >= 0) return `${text.slice(0, exponent)}.0${text.slice(exponent)}`;
  return `${text}.0`;
}

// ---------------------------------------------------------------------------
// Live host values.

/**
 * The values this host has handed the engine a reference to.
 *
 * The engine holds an integer; the object stays here, so handing the reference
 * back reaches the very same object and identity, mutation and property reads
 * all see one thing. It is a STRONG table: an atom the engine stored may name
 * the id long after every JavaScript reference to it is gone, and nothing on
 * this side can observe that the engine dropped it. The table dies with the
 * engine that owns it.
 */
export class HostValues {
  #byId = new Map<number, unknown>();
  #byValue = new WeakMap<WeakKey, number>();
  #byPrimitive = new Map<unknown, number>();
  #next = 1;

  /** The id for this value, minting one the first time. */
  idFor(value: unknown): number {
    const weak =
      value !== null &&
      (typeof value === "object" ||
        typeof value === "function" ||
        (typeof value === "symbol" && Symbol.keyFor(value) === undefined));
    const held = weak
      ? this.#byValue.get(value as WeakKey)
      : this.#byPrimitive.get(value);
    if (held !== undefined) return held;
    const id = this.#next;
    this.#next += 1;
    this.#byId.set(id, value);
    if (weak) this.#byValue.set(value as WeakKey, id);
    else this.#byPrimitive.set(value, id);
    return id;
  }

  /** The value behind an id, or a refusal naming the id. */
  valueOf(id: number): unknown {
    if (!this.#byId.has(id)) {
      throw wireError(
        `host reference ${id} was released; a stale id is an error rather than a fresh value`,
      );
    }
    return this.#byId.get(id);
  }

  /** How many values are held. Diagnostics. */
  get size(): number {
    return this.#byId.size;
  }

  /** Drop every reference. Called when the engine that held them goes. */
  clear(): void {
    this.#byId.clear();
    this.#byValue = new WeakMap<WeakKey, number>();
    this.#byPrimitive.clear();
  }
}

// ---------------------------------------------------------------------------
// The walks.
//
// Every walk below shares one shape, said once here: a work stack holding
// nodes still to visit, where a NUMBER on that stack means "the last N results
// are the children of an expression, close it". A node is always an array or
// an object, so a number can never be mistaken for one, and the depth of the
// term is the length of an array rather than the depth of the call stack. It
// is the explicit-stack rewrite RapidJSON offers as `kParseIterativeFlag` and
// V8 took for `JSON.stringify`'s fast path, for the same reason: a recursive
// codec's ceiling is the host's stack
// [source: https://rapidjson.org/md_doc_features.html;
// https://v8.dev/blog/json-stringify].

/**
 * The last `arity` results, as the children of the expression that closes.
 *
 * Popped into a pre-sized array rather than spliced off the tail: `splice`
 * allocates its result AND moves what it left behind, and it was 60 percent of
 * what a worklist costs over a recursive walk on a shallow term
 * [measured 2026-08-31: the wire-roundtrip row fell from 3,905,175,528 to
 * 3,562,550,943 retired instructions on this one change;
 * command=sh extensions/node/bench.sh wire-roundtrip; commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8].
 */
function gather<T>(built: T[], arity: number): T[] {
  const children = new Array<T>(arity);
  for (let at = arity - 1; at >= 0; at -= 1) children[at] = built.pop() as T;
  return children;
}

/**
 * A child of an `e` payload, refused if it is a NUMBER.
 *
 * The work stacks below mark where an expression closes with the child count
 * itself, which allocates nothing beyond the one stack. That is sound only
 * while no NODE can be a number, and the two readers here take untrusted
 * input, so a numeric child is refused at the one place it could be pushed
 * rather than silently read as a close mark. It is a refusal the grammar owes
 * anyway: a transport atom is a pair.
 */
function childOf(child: unknown): unknown {
  if (typeof child === "number") {
    throw wireError(`not a transport atom: ${JSON.stringify(child)}`);
  }
  return child;
}

function items(payload: unknown): readonly unknown[] {
  if (!Array.isArray(payload)) {
    throw wireError(`the e tag carries a list, not ${JSON.stringify(payload)}`);
  }
  return payload as readonly unknown[];
}

/**
 * A two-element term as a tuple, or a refusal naming what was expected.
 *
 * `Array.isArray` narrows to `any[]`, whose length TypeScript cannot know, so
 * the pair is rebuilt by index rather than asserted into a tuple shape the
 * check has not actually established.
 */
function pairOf(term: unknown, what: string): readonly [unknown, unknown] {
  if (!Array.isArray(term) || term.length !== 2) {
    throw wireError(`not ${what}: ${JSON.stringify(term)}`);
  }
  const list = term as readonly unknown[];
  return [list[0], list[1]];
}

/** What a decode is allowed to see beyond the strict grammar. */
export interface DecodeContext {
  /** Names the engine introduced under `p`, so a bare `s` can be restored. */
  readonly knownSpaces?: ReadonlySet<string>;
  /** The table an `o` id is looked up in. Absent means `o` is refused. */
  readonly hostValues?: HostValues;
}

/** What an encode needs beyond the wire atom itself. */
export interface EncodeContext {
  /** The table an `o` payload is minted in. Absent means `o` is refused. */
  readonly hostValues?: HostValues;
}

/**
 * The live host value an `o` payload names, or the refusal that payload earns.
 *
 * Said once for both leaf readers, because the rule belongs to the TAG and not
 * to either representation: only the session that handed the id out can honour
 * it, and an id it never handed out is an error rather than a fresh value.
 */
function hostReference(payload: unknown, context: DecodeContext): unknown {
  if (context.hostValues === undefined) {
    throw wireError(
      `the o tag carries a live host value by reference, which only this ` +
        `host's own engine transport can name`,
    );
  }
  const id = Number(hostText(payload));
  if (!Number.isInteger(id)) {
    throw wireError(`the o tag carries a host reference id, not ${JSON.stringify(payload)}`);
  }
  return context.hostValues.valueOf(id);
}

/**
 * One non-expression tag and its payload, as the wire atom it names.
 *
 * The PORTABLE reader's leaf, which builds no atom: interning one costs a
 * table lookup and a key per leaf, and `fromTransport` answers a `Wire` that
 * a remote peer or the conformance kit compares as data. Expressing it as
 * {@link atomOfToken} and back through {@link wireOfLeaf} cost this path 50
 * percent, so the two readers stay two
 * [measured 2026-08-31 with retired instructions over 20,000 terms of 4,681
 * nodes; commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8]. They must agree, and
 * "agrees with the atom reader on every tag" is what says so.
 */
function decodeLeaf(tag: unknown, payload: unknown, context: DecodeContext): Wire {
  switch (tag) {
    case "s": {
      const text = hostText(payload);
      // The engine's generic encoder emits a named space other than &self and
      // &metta as s, because a Prolog atom carries no record of the p tag it
      // entered under. A name the engine introduced under p keeps that
      // provenance here, while the strict decoder honours an explicit s tag.
      if (context.knownSpaces?.has(text) === true) return ["p", space(text)];
      return ["s", text];
    }
    case "v":
      return ["v", hostText(payload)];
    case "g":
      return ["g", hostText(payload)];
    case "n":
      return ["n", numberFromText(hostText(payload))];
    case "b": {
      // Exactly the two words. Reading anything else as false answers a
      // question nobody asked, and a truthiness rule here would let ["b", 1]
      // through as a boolean the engine never wrote.
      const written = hostText(payload);
      if (written !== "true" && written !== "false") {
        throw wireError(`the b tag carries true or false, not ${JSON.stringify(payload)}`);
      }
      return ["b", written === "true"];
    }
    case "p":
      return ["p", space(hostText(payload))];
    case "o":
      return ["o", hostReference(payload, context)];
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/**
 * One non-expression tag and its payload, as the ATOM it names.
 *
 * The ENGINE reader's leaf. It builds the atom directly because a term is
 * mostly leaves and the wire pair {@link decodeLeaf} answers is an allocation
 * nothing on this path reads: going through it cost 3.3 percent
 * [measured 2026-08-31 with retired instructions over 20,000 terms of 4,681
 * nodes at width 8 depth 4; commit=c530ccb8fb7d0a5b2aa53df6e9f981ada9f81be8].
 *
 * It must agree with {@link decodeLeaf} on every tag, and the one that says so
 * is "agrees with the wire reader on every tag" in test/wire.test.ts.
 */
function atomOfToken(tag: unknown, payload: unknown, context: DecodeContext): Atom {
  switch (tag) {
    case "s": {
      const text = hostText(payload);
      // The engine's generic encoder emits a named space other than &self and
      // &metta as s, because a Prolog atom carries no record of the p tag it
      // entered under. A name the engine introduced under p keeps that
      // provenance here, while the strict decoder honours an explicit s tag.
      if (context.knownSpaces?.has(text) === true) return space(text);
      return sym(text);
    }
    case "v":
      return variable(hostText(payload));
    case "g":
      return G(hostText(payload));
    case "n":
      return numberAtom(numberFromText(hostText(payload)));
    case "b": {
      // Exactly the two words. Reading anything else as false answers a
      // question nobody asked, and a truthiness rule here would let ["b", 1]
      // through as a boolean the engine never wrote.
      const written = hostText(payload);
      if (written !== "true" && written !== "false") {
        throw wireError(`the b tag carries true or false, not ${JSON.stringify(payload)}`);
      }
      return G(written === "true");
    }
    case "p":
      return space(hostText(payload));
    case "o":
      return G(hostReference(payload, context));
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/** One non-expression wire atom as the transport pair the engine reads. */
function encodeLeaf(tag: unknown, payload: unknown, context: EncodeContext): Transport {
  switch (tag) {
    case "s":
    case "v":
    case "g":
      if (typeof payload !== "string") {
        throw wireError(`the ${tag} tag carries text, not ${JSON.stringify(payload)}`);
      }
      return [tag, payload];
    case "n":
      if (typeof payload !== "number" && typeof payload !== "bigint") {
        throw wireError(`the n tag carries a number, not ${JSON.stringify(payload)}`);
      }
      return ["n", numberToText(payload)];
    case "b":
      if (typeof payload !== "boolean") {
        throw wireError(`the b tag carries a boolean, not ${JSON.stringify(payload)}`);
      }
      return ["b", payload ? "true" : "false"];
    case "p":
      if (!(payload instanceof SpaceHandle)) {
        throw wireError(`the p tag carries a SpaceHandle, not ${JSON.stringify(payload)}`);
      }
      return ["p", payload.name];
    case "o": {
      if (context.hostValues === undefined) {
        throw wireError(
          `the o tag carries a live host value by reference, which only this ` +
            `host's own engine transport can name`,
        );
      }
      return ["o", String(context.hostValues.idFor(payload))];
    }
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/**
 * A transport term as the strict wire atom a conformance kit compares.
 *
 * Strict: no space provenance is restored and `o` is refused, because both are
 * facts about THIS engine's session rather than about the written-down
 * grammar. {@link decodeEngine} is this seat's own flat transport with that
 * session's knowledge supplied.
 */
export function fromTransport(term: unknown): Wire {
  const built: Wire[] = [];
  const work: unknown[] = [childOf(term)];
  while (work.length > 0) {
    const step = work.pop();
    if (typeof step === "number") {
      built.push(["e", gather(built, step)]);
      continue;
    }
    const [tag, payload] = pairOf(step, "a transport atom");
    if (tag === "e") {
      const children = items(payload);
      work.push(children.length);
      for (let at = children.length - 1; at >= 0; at -= 1) work.push(childOf(children[at]));
      continue;
    }
    built.push(decodeLeaf(tag, payload, {}));
  }
  return built[0] as Wire;
}

/** A wire atom as the portable transport term, nested one pair per atom. */
export function toTransport(wire: unknown, context: EncodeContext = {}): Transport {
  const built: Transport[] = [];
  const work: unknown[] = [childOf(wire)];
  while (work.length > 0) {
    const step = work.pop();
    if (typeof step === "number") {
      built.push(["e", gather(built, step)]);
      continue;
    }
    const [tag, payload] = pairOf(step, "a wire atom");
    if (tag === "e") {
      const children = items(payload);
      work.push(children.length);
      for (let at = children.length - 1; at >= 0; at -= 1) work.push(childOf(children[at]));
      continue;
    }
    built.push(encodeLeaf(tag, payload, context));
  }
  return built[0] as Transport;
}

// ---------------------------------------------------------------------------
// The engine transport: atoms in one pass, with no tree in between.

/** A child count as the token stream spells it, or a refusal naming what it got. */
function countAt(tokens: WireTokens, at: number): number {
  const written = tokens[at];
  const count = typeof written === "number" ? written : Number(hostText(written));
  if (!Number.isInteger(count) || count < 0) {
    throw wireError(`the e tag carries a child count, not ${JSON.stringify(written)}`);
  }
  return count;
}

/**
 * An engine answer, as the atom it names.
 *
 * ONE pass: the flat token list is read straight into interned atoms, so an
 * answer of n nodes costs n leaf decodes and one array per expression rather
 * than a whole intermediate tree walked a second time. `provenance` is the
 * token list this host SENT, for a round trip: a Prolog atom carries no record
 * of whether it entered under `s` or under `p`, the two lists have the same
 * preorder, and the tag this host wrote at a position says which it was.
 */
export function decodeEngine(tokens: unknown, context: DecodeContext, provenance?: WireTokens): Atom {
  if (!Array.isArray(tokens)) throw wireError(`not a transport term: ${JSON.stringify(tokens)}`);
  const stream = tokens as WireTokens;
  // A LEAF needs no worklist at all, and most of what crosses is one: a host
  // operation's arguments and its answers are single atoms, so the stacks
  // below would be three allocations for a term with no children.
  if (stream.length === 2 && stream[0] !== "e") {
    const only = atomOfToken(stream[0], stream[1], context);
    return provenance?.length === 2 &&
      provenance[0] === "p" &&
      stream[0] === "s" &&
      only instanceof Sym
      ? space(only.name)
      : only;
  }
  let aligned = provenance !== undefined && provenance.length === stream.length;
  const root: Atom[] = [];
  // Two parallel stacks rather than one stack of frame objects: the children
  // gathered so far, and how many each level is still waiting for. The bottom
  // frame is the answer's own slot, so the walk ends when it closes.
  const gathered: Atom[][] = [root];
  const waiting: number[] = [1];
  let at = 0;
  while (gathered.length > 0) {
    if (at >= stream.length) {
      throw wireError(`the transport ended inside a term: ${JSON.stringify(stream.slice(-4))}`);
    }
    const tagAt = at;
    const tag = stream[at];
    at += 1;
    let value: Atom;
    if (tag === "e") {
      const arity = countAt(stream, at);
      if (aligned) {
        try {
          aligned = provenance?.[tagAt] === "e" && countAt(provenance, tagAt + 1) === arity;
        } catch {
          // Provenance is advisory. A malformed or differently shaped input
          // disables restoration; it cannot make an otherwise valid answer fail.
          aligned = false;
        }
      }
      at += 1;
      if (arity > 0) {
        gathered.push([]);
        waiting.push(arity);
        continue;
      }
      value = exprOf([]);
    } else {
      // Every leaf occupies two tokens whatever its scalar tag. A changed leaf
      // type therefore keeps later sibling paths aligned; only expression vs
      // leaf changes the tree shape and invalidates the remaining positions.
      if (aligned && provenance?.[tagAt] === "e") {
        aligned = false;
      }
      value = atomOfToken(tag, stream[at], context);
      at += 1;
      if (aligned && value instanceof Sym && provenance?.[tagAt] === "p") value = space(value.name);
    }
    for (;;) {
      const top = gathered.length - 1;
      (gathered[top] as Atom[]).push(value);
      waiting[top] = (waiting[top] as number) - 1;
      if ((waiting[top] as number) > 0) break;
      const closed = gathered.pop() as Atom[];
      waiting.pop();
      if (gathered.length === 0) break;
      value = exprOf(closed);
    }
  }
  if (at !== stream.length) {
    throw wireError(`the transport carried ${String(stream.length - at)} tokens past the term`);
  }
  return root[0] as Atom;
}

/**
 * An atom as the flat token list this seat's own bridge reads.
 *
 * ONE pass, for the same reason {@link decodeEngine} is one: the tokens are
 * appended to a single array as the term is walked, so nothing between the
 * atom and the transport is ever built.
 */
export function encodeEngine(atom: Atom, context: EncodeContext = {}): unknown[] {
  // The same leaf shortcut {@link decodeEngine} takes, for the same reason.
  if (!(atom instanceof Expression)) {
    const leaf = wireOfLeaf(atom);
    const [tag, payload] = encodeLeaf(leaf[0], leaf[1], context);
    return [tag, payload];
  }
  const out: unknown[] = [];
  const work: Atom[] = [atom];
  while (work.length > 0) {
    const step = work.pop() as Atom;
    if (step instanceof Expression) {
      out.push("e", step.items.length);
      for (let at = step.items.length - 1; at >= 0; at -= 1) work.push(step.items[at] as Atom);
      continue;
    }
    const leaf = wireOfLeaf(step);
    const [tag, payload] = encodeLeaf(leaf[0], leaf[1], context);
    out.push(tag, payload);
  }
  return out;
}

/**
 * Restore s/p input provenance after Prolog's atom representation erased it.
 *
 * A round trip through the engine loses the difference between a symbol that
 * happens to start with `&` and a portable space reference, because both are
 * one Prolog atom. Where the input said which it was, the output says the same.
 */
export function fromRoundTrip(input: WireTokens, output: unknown): Atom {
  return decodeEngine(output, {}, input);
}

// ---------------------------------------------------------------------------
// Wire atoms and surface atoms.

/**
 * The atom a number crossed as.
 *
 * The WIRE keeps the engine's own split, a `bigint` for every integer and a
 * `number` for every float, because that is the only JavaScript pair that
 * tells 2 from 2.0 apart. The ATOM keeps the same distinction in a better
 * place: `Grounded` is the integer and `FloatAtom` is the float, so the VALUE
 * can be the natural host number and a program reading an answer is not
 * handed a `bigint` for the number 4.
 *
 * An integer past the exactly-representable range stays a `bigint`, because
 * there is nothing else that could hold it.
 */
function numberAtom(value: number | bigint): Atom {
  if (typeof value === "number") return float(value);
  const exact = BigInt(Number.MAX_SAFE_INTEGER);
  return value >= -exact && value <= exact ? G(Number(value)) : G(value);
}

/** The surface atom a leaf wire atom names. */
function atomOfLeaf(wire: Wire): Atom {
  switch (wire[0]) {
    case "s":
      return sym(wire[1]);
    case "v":
      return variable(wire[1]);
    case "n":
      return numberAtom(wire[1]);
    case "g":
      return G(wire[1]);
    case "b":
      return G(wire[1]);
    case "p":
      return wire[1];
    case "o":
      return G(wire[1]);
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(wire[0])}`);
  }
}

/** The surface atom a wire atom names. */
export function atomFromWire(wire: Wire): Atom {
  const built: Atom[] = [];
  // A NUMBER on the work stack closes an expression of that many children.
  // Safe without a second stack here because every node is a wire atom, which
  // is an array: only this function's own marks are numbers.
  const work: (Wire | number)[] = [wire];
  while (work.length > 0) {
    const step = work.pop() as Wire | number;
    if (typeof step === "number") {
      built.push(exprOf(gather(built, step)));
      continue;
    }
    if (step[0] === "e") {
      const children = step[1];
      work.push(children.length);
      for (let at = children.length - 1; at >= 0; at -= 1) work.push(children[at] as Wire);
      continue;
    }
    built.push(atomOfLeaf(step));
  }
  return built[0] as Atom;
}

/** The wire atom a leaf surface atom names. */
function wireOfLeaf(atom: Atom): Wire {
  if (atom instanceof Sym) return ["s", atom.name];
  if (atom instanceof Var) return ["v", atom.name];
  if (atom instanceof SpaceHandle) return ["p", atom];
  if (atom instanceof FloatAtom) return ["n", atom.value];
  if (atom instanceof Grounded) {
    const value: unknown = atom.value;
    switch (typeof value) {
      case "number":
        // JavaScript has ONE number type and MeTTa has two, so the crossing
        // has to choose, and it chooses by the VALUE: an integral double is
        // the integer a reader who wrote `42` meant, and only a number with a
        // fraction or an exponent past the exact range is a float. `float(42)`
        // is the door for the integral float, and a `bigint` is always an
        // integer however large. The reverse crossing is settled and tested:
        // every Prolog integer arrives as a `bigint` and every float as a
        // `number`, which is the only JavaScript pair that tells 2 from 2.0
        // apart, and the engine does tell them apart.
        // Negative zero is excluded from the integer path deliberately: it
        // has meaning only as a float, `BigInt(-0)` is `0n`, and crossing it
        // as an integer would silently turn -0.0 into 0.
        return ["n", Number.isSafeInteger(value) && !Object.is(value, -0) ? BigInt(value) : value];
      case "bigint":
        return ["n", value];
      case "string":
        return ["g", value];
      case "boolean":
        return ["b", value];
      default:
        return ["o", value];
    }
  }
  throw wireError(`no wire tag for ${String(atom)}`);
}

/**
 * The wire atom a surface atom names.
 *
 * The tag a grounded value takes follows the VALUE: a number is `n`, text is
 * `g`, a boolean is `b`, and anything else is a live host reference under `o`.
 * That is MeTTa's own reading, where a number is a grounded atom rather than a
 * host object, and it is what keeps a JavaScript number and a MeTTa Number one
 * thing.
 */
export function wireFromAtom(atom: Atom): Wire {
  const built: Wire[] = [];
  // A number closes; every node is an Atom, which is an object.
  const work: (Atom | number)[] = [atom];
  while (work.length > 0) {
    const step = work.pop() as Atom | number;
    if (typeof step === "number") {
      built.push(["e", gather(built, step)]);
      continue;
    }
    if (step instanceof Expression) {
      work.push(step.items.length);
      for (let at = step.items.length - 1; at >= 0; at -= 1) work.push(step.items[at] as Atom);
      continue;
    }
    built.push(wireOfLeaf(step));
  }
  return built[0] as Wire;
}
