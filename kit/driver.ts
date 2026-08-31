/**
 * Purpose: expose the Node binding as one codec driver the conformance kit can
 *   run, over a line of JSON per request on standard input.
 * Assumes:
 *   - the binding writes nothing to standard output of its own, which is what
 *     leaves this stream free to be a protocol; boot() captures both engine
 *     streams for exactly that reason
 * Guarantees:
 *   - one response line per request line, `{"ok": value}` or
 *     `{"error": text}`, and a request that raises is reported rather than
 *     ending the process, because a refusal is an answer the kit reads
 *   - the engine boots once, so a corpus of a hundred cases costs one boot
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { createInterface } from "node:readline";

import { atomFromWire, boot, fromTransport, toTransport, wireFromAtom } from "../src/index.ts";

const engine = await boot();

/**
 * The kit's wire and this binding's transport are the same tags; they differ
 * only in what a payload is spelled as, which is what `fromTransport` and
 * `toTransport` already convert.
 */
const operations: Readonly<Record<string, (request: Record<string, never>) => unknown>> = {
  read: ({ text }) => toTransport(wireFromAtom(engine.read(text as string))),
  roundtrip: ({ transport }) =>
    toTransport(wireFromAtom(engine.roundTrip(atomFromWire(fromTransport(transport))))),
  transport: ({ transport }) => toTransport(fromTransport(transport)),
  render: ({ transport }) => engine.text(atomFromWire(fromTransport(transport))),
  transcript: ({ program }) => {
    const event = engine.start(["run", program as string]).sync();
    if (event === null || event.kind !== "groups") return [];
    return event.groups.map((group) => group.map((answer) => toTransport(wireFromAtom(answer.atom))));
  },
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (line.trim() === "") continue;
  let response: Record<string, unknown>;
  try {
    const request = JSON.parse(line) as { op?: string };
    // hasOwn rather than a truth test on the lookup: `constructor` and
    // `__proto__` are inherited and callable, so a bare index would run
    // something this table never named.
    const op = request.op ?? "";
    if (!Object.hasOwn(operations, op)) {
      throw new Error(`no operation named ${JSON.stringify(request.op)}`);
    }
    response = { ok: operations[op]?.(request as never) };
  } catch (error) {
    response = { error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
