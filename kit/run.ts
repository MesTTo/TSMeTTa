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
import { join } from "node:path";

import {
  type Wire,
  boot,
  fromTransport,
  packageRoot,
  toTransport,
} from "../src/index.ts";

/**
 * The form both hosts compare in. Three things differ between them and each is
 * settled here rather than in either binding:
 *
 *   - an integer is a JavaScript bigint or a Python int and a float is a host
 *     number, so the kind travels beside the value and a float travels as its
 *     bits
 *   - a variable's wire name is what the writer numbered it, which changes
 *     between runs and between hosts, so only the tag is compared
 *   - a boolean's payload is a string on the janus wire and a boolean here
 */
function comparable(wire: Wire): unknown {
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
    case "p":
      return ["p", payload.name];
    default:
      return [tag, payload];
  }
}

function floatBits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  return [...new Uint8Array(view.buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface Corpus {
  readonly programs: readonly { readonly source: string }[];
  readonly atoms: readonly { readonly transport: unknown }[];
  readonly refused: readonly { readonly transport: unknown }[];
}

const corpus = JSON.parse(
  readFileSync(join(packageRoot, "kit", "corpus.json"), "utf-8"),
) as Corpus;
const engine = await boot();

const report: Record<string, unknown> = {
  refusals: engine.refusals.map(({ file, missing, line }) => ({ file, missing, line })),
  programs: [] as unknown[],
  atoms: [] as unknown[],
  refused: [] as unknown[],
  streaming: null,
};

const programs = report["programs"] as unknown[];
for (const { source } of corpus.programs) {
  try {
    const event = engine.start(["run", source]).sync();
    const groups = event !== null && event.kind === "groups" ? event.groups : [];
    programs.push({
      source,
      groups: groups.map((group) =>
        group.map((answer) => ({ wire: comparable(answer.wire), text: answer.text })),
      ),
    });
  } catch (error) {
    programs.push({ source, error: error instanceof Error ? error.message : String(error) });
  }
}

const atoms = report["atoms"] as unknown[];
for (const { transport } of corpus.atoms) {
  try {
    const wire = fromTransport(transport);
    atoms.push({
      transport,
      wire: comparable(wire),
      backToTransport: toTransport(wire),
      roundTrip: comparable(engine.roundTrip(wire)),
      text: engine.text(wire),
    });
  } catch (error) {
    atoms.push({ transport, error: error instanceof Error ? error.message : String(error) });
  }
}

const refused = report["refused"] as unknown[];
for (const { transport } of corpus.refused) {
  try {
    engine.roundTrip(fromTransport(transport));
    refused.push({ transport, refused: false });
  } catch (error) {
    refused.push({
      transport,
      refused: true,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

// The lazy answer surface, proven in the same run so a checker in another
// language sees the evidence rather than the claim. The generator is
// unbounded, so an eager binding could not reach the line after the loop, and
// the witness space holds one atom per answer the engine actually produced.
engine.start([
  "run",
  `
(= (tick $n) (let $ignored (add-atom &kit-witness (produced $n)) $n))
(= (unbounded $n) (superpose ((tick $n) (unbounded (+ $n 1)))))
`,
]).sync();

const pulled: string[] = [];
const stream = engine.start(["source", "(unbounded 1)", "&self"]);
for (;;) {
  const event = await stream.next();
  if (event === null || event.kind !== "answer") break;
  pulled.push(event.text);
  if (pulled.length === 2) {
    stream.close();
    break;
  }
}

const witness = engine.start(["run", "!(collapse (get-atoms &kit-witness))"]).sync();
report["streaming"] = {
  pulled,
  produced:
    witness !== null && witness.kind === "groups"
      ? (witness.groups[0] ?? []).map((answer) => answer.text)
      : [],
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
