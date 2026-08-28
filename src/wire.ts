/**
 * Purpose: the codec between MeTTa atoms and the tagged wire terms the engine
 *   reads and writes, in both directions and at both strictnesses.
 * Assumes:
 *   - the tags are `CODEC.md`'s: s symbol, v variable, n number, g string,
 *     b boolean, e expression, p portable space handle, o live host value
 *   - a number's payload is canonical Prolog TEXT, because the WebAssembly
 *     value conversion renders the float 2.0 and the integer 2 as the same
 *     JavaScript number and MeTTa answers False to `(== 2 2.0)`
 *     [measured 2026-08-20, restated 2026-08-27]
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
 * Owns: the live-host-value table. An object that crossed into the engine is
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
  expr,
  exprOf,
  float,
  space,
  sym,
  variable,
} from "./atom.ts";
import { MettaError } from "./errors.ts";

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

/** A transport term as it crosses the WebAssembly boundary: payloads are text. */
export type Transport = readonly [string, unknown];

function wireError(message: string): MettaError {
  return new MettaError(message, { code: "ERR_METTA_WIRE" });
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
  #next = 1;

  /** The id for this value, minting one the first time. */
  idFor(value: unknown): number {
    if (value !== null && (typeof value === "object" || typeof value === "function")) {
      const held = this.#byValue.get(value as WeakKey);
      if (held !== undefined) return held;
      const id = this.#next;
      this.#next += 1;
      this.#byId.set(id, value);
      this.#byValue.set(value as WeakKey, id);
      return id;
    }
    const id = this.#next;
    this.#next += 1;
    this.#byId.set(id, value);
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
  }
}

// ---------------------------------------------------------------------------
// Transport, both directions.

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

function decodeTransport(term: unknown, context: DecodeContext): Wire {
  const [tag, payload] = pairOf(term, "a transport atom");
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
    case "o": {
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
      return ["o", context.hostValues.valueOf(id)];
    }
    case "e":
      return ["e", items(payload).map((item) => decodeTransport(item, context))];
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/**
 * A transport term as the strict wire atom a conformance kit compares.
 *
 * Strict: no space provenance is restored and `o` is refused, because both are
 * facts about THIS engine's session rather than about the written-down
 * grammar. {@link decodeEngine} is the same decoder with that session's
 * knowledge supplied.
 */
export function fromTransport(term: unknown): Wire {
  return decodeTransport(term, {});
}

/** An engine result, decoded with this session's space names and host values. */
export function decodeEngine(term: unknown, context: DecodeContext): Wire {
  return decodeTransport(term, context);
}

/** What an encode needs beyond the wire atom itself. */
export interface EncodeContext {
  /** The table an `o` payload is minted in. Absent means `o` is refused. */
  readonly hostValues?: HostValues;
}

/** A wire atom as the transport term the engine reads. */
export function toTransport(wire: unknown, context: EncodeContext = {}): Transport {
  const [tag, payload] = pairOf(wire, "a wire atom");
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
    case "e":
      return ["e", items(payload).map((item) => toTransport(item, context))];
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(tag)}`);
  }
}

/**
 * Restore s/p input provenance after Prolog's atom representation erased it.
 *
 * A round trip through the engine loses the difference between a symbol that
 * happens to start with `&` and a portable space reference, because both are
 * one Prolog atom. Where the input said which it was, the output says the same.
 */
export function fromRoundTrip(input: Transport, output: unknown): Wire {
  if (Array.isArray(output) && (output as readonly unknown[]).length === 2) {
    const [inputTag, inputPayload] = input;
    const [outputTag, outputPayload] = pairOf(output, "a transport atom");
    if ((inputTag === "s" || inputTag === "p") && (outputTag === "s" || outputTag === "p")) {
      const inputText = hostText(inputPayload);
      const outputText = hostText(outputPayload);
      if (inputText === outputText) {
        return inputTag === "p" ? ["p", space(outputText)] : ["s", outputText];
      }
    }
    if (inputTag === "e" && outputTag === "e") {
      const inputItems = items(input[1]);
      const outputItems = items(outputPayload);
      if (inputItems.length === outputItems.length) {
        return [
          "e",
          inputItems.map((item, index) =>
            fromRoundTrip(item as Transport, outputItems[index]),
          ),
        ];
      }
    }
  }
  return fromTransport(output);
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

/** The surface atom a wire atom names. */
export function atomFromWire(wire: Wire): Atom {
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
    case "e":
      return exprOf(wire[1].map(atomFromWire));
    default:
      throw wireError(`unknown wire tag ${JSON.stringify(wire[0])}`);
  }
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
  if (atom instanceof Sym) return ["s", atom.name];
  if (atom instanceof Var) return ["v", atom.name];
  if (atom instanceof SpaceHandle) return ["p", atom];
  if (atom instanceof Expression) return ["e", atom.items.map(wireFromAtom)];
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
