/**
 * Purpose: run the conformance corpus through the Node binding and print one
 *   JSON report, so a checker in another language can hold both hosts to the
 *   same cases without embedding either.
 * Assumes:
 *   - corpus.json's numbers are canonical Prolog text, which is what the
 *     comparison form below turns back into a value
 * Guarantees:
 *   - the report is JSON, so nothing here carries a JavaScript BigInt or a raw
 *     float across; an integer crosses as its digits and a float as its
 *     IEEE-754 bit pattern, exact for every double including -0.0 and NaN
 *   - a case that raises is reported as a refusal with its message, never
 *     dropped
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boot, fromTransport, toTransport } from "../index.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The form both hosts compare in. Three things differ between them and each
 * is settled here rather than in either binding:
 *
 *   - an integer is a JavaScript BigInt or Python int and a float is a host
 *     number, so the kind travels beside the value and a float travels as its
 *     bits
 *   - a variable's wire name is what the writer numbered it, which changes
 *     between runs and between hosts, so only the tag is compared
 *   - a boolean's payload is a string on the janus wire and a boolean here
 */
function comparable(wire) {
  const [tag, payload] = wire;
  switch (tag) {
    case "v":
      return ["v"];
    case "n":
      return typeof payload === "bigint"
        ? ["n", "i", payload.toString()]
        : ["n", "f", floatBits(payload)];
    case "b":
      return ["b", payload ? "true" : "false"];
    case "e":
      return ["e", payload.map(comparable)];
    default:
      return [tag, payload];
  }
}

function floatBits(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return [...new Uint8Array(view.buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf-8"));
const petta = await boot();

const report = {
  refusals: petta.refusals.map(({ file, missing, line }) => ({ file, missing, line })),
  programs: [],
  atoms: [],
  refused: [],
  streaming: null,
};

for (const { source } of corpus.programs) {
  try {
    report.programs.push({
      source,
      groups: petta.run(source).map((group) =>
        group.map((answer) => ({ wire: comparable(answer.wire), text: answer.text })),
      ),
    });
  } catch (error) {
    report.programs.push({ source, error: error.message });
  }
}

for (const { transport } of corpus.atoms) {
  try {
    const wire = fromTransport(transport);
    report.atoms.push({
      transport,
      wire: comparable(wire),
      backToTransport: toTransport(wire),
      roundTrip: comparable(petta.roundTrip(wire)),
      text: petta.text(wire),
    });
  } catch (error) {
    report.atoms.push({ transport, error: error.message });
  }
}

for (const { transport } of corpus.refused) {
  try {
    const wire = fromTransport(transport);
    petta.roundTrip(wire);
    report.refused.push({ transport, refused: false });
  } catch (error) {
    report.refused.push({ transport, refused: true, message: error.message });
  }
}

// The lazy answer surface, proven in the same run so a checker in another
// language sees the evidence rather than the claim. The generator is
// unbounded, so an eager binding could not reach the line after the loop, and
// the witness space holds one atom per answer the engine actually produced.
petta.run(`
(= (tick $n) (let $ignored (add-atom &kit-witness (produced $n)) $n))
(= (unbounded $n) (superpose ((tick $n) (unbounded (+ $n 1)))))
`);
const pulled = [];
for await (const answer of petta.stream("(unbounded 1)")) {
  pulled.push(answer.text);
  if (pulled.length === 2) break;
}
report.streaming = {
  pulled,
  produced: petta.run("!(collapse (get-atoms &kit-witness))")[0].map((a) => a.text),
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
