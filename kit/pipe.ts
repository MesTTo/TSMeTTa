/**
 * Purpose: the JSON line protocol the conformance kit's two programs share
 *   with their Python caller, which is a transport document plus the corpus's
 *   own escape for what JSON cannot write.
 * Assumes:
 *   - the corpus writes a non-finite float as `{"$float": "inf"}`,
 *     `{"$float": "-inf"}` or `{"$float": "nan"}`, which is the vocabulary
 *     `metta.testing._codec_kit._FLOATS` resolves on the other side
 * Guarantees:
 *   - a number crosses as its VALUE and at its own width, because
 *     {@link transportToJson} places each `n` payload as its own literal
 *     [tested: extensions/python/tests/ch21_another_language_at_the_seam/test_node_binding.py,
 *     test_a_second_language_binding_passes_the_same_conformance_kit]
 *   - a non-finite float crosses as the escape rather than being refused: the
 *     binding's codec carries one, and only this JSON PIPE cannot, which is
 *     the same split the remote wire has where the codec carries one and the
 *     JSON body refuses it
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { transportFromJson, transportToJson } from "../src/index.ts";

/** The three spellings the corpus writes a non-finite float in. */
const FLOATS: Readonly<Record<string, number>> = {
  inf: Number.POSITIVE_INFINITY,
  "-inf": Number.NEGATIVE_INFINITY,
  nan: Number.NaN,
};

/**
 * A document with every `n` payload put through one rewriting.
 *
 * Recursive, which the shipped codec's own walks are not, and that is the
 * right trade here: the deepest thing this pipe carries is the corpus's
 * four-hundred-deep case, and `JSON.stringify` bounds the depth either way.
 */
function overNumbers(value: unknown, rewrite: (payload: unknown) => unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 2 && value[0] === "n") return ["n", rewrite(value[1])];
    return value.map((item) => overNumbers(item, rewrite));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, held]) => [
        key,
        overNumbers(held, rewrite),
      ]),
    );
  }
  return value;
}

/** A document with every `$float` escape resolved into this host's own float. */
export function materialise(value: unknown): unknown {
  return overNumbers(value, (payload) => {
    if (typeof payload !== "object" || payload === null || !("$float" in payload)) return payload;
    const named = (payload as { $float: unknown }).$float;
    const held = typeof named === "string" ? FLOATS[named] : undefined;
    if (held === undefined) throw new Error(`unknown float escape ${JSON.stringify(named)}`);
    return held;
  });
}

/** One line of this pipe, as the document it spells. */
export function readPipe(text: string): unknown {
  return materialise(transportFromJson(text));
}

/** One document as a line of this pipe. */
export function writePipe(value: unknown): string {
  return transportToJson(
    overNumbers(value, (payload) => {
      if (typeof payload !== "number" || Number.isFinite(payload)) return payload;
      return { $float: Number.isNaN(payload) ? "nan" : payload > 0 ? "inf" : "-inf" };
    }),
  );
}
