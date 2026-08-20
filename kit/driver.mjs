/**
 * Purpose: expose the Node binding as one codec driver the conformance kit
 *   can run, over a line of JSON per request on standard input.
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

import { boot, fromTransport, toTransport } from "../index.mjs";

const petta = await boot();

/**
 * The kit's wire and this binding's transport are the same seven tags; they
 * differ only in what a payload is spelled as, which is what fromTransport
 * and toTransport already convert. The kit's side of that spelling is settled
 * in bindings/python/tests/test_node_binding.py, where the corpus is read.
 */
const operations = {
  read: ({ text }) => toTransport(petta.read(text)),
  roundtrip: ({ transport }) => toTransport(petta.roundTrip(fromTransport(transport))),
  transport: ({ transport }) => toTransport(fromTransport(transport)),
  render: ({ transport }) => petta.text(fromTransport(transport)),
  transcript: ({ program }) =>
    petta.run(program).map((group) => group.map((answer) => toTransport(answer.wire))),
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (line.trim() === "") continue;
  let response;
  try {
    const request = JSON.parse(line);
    // hasOwn rather than a truth test on the lookup: `constructor` and
    // `__proto__` are inherited and callable, so a bare index would run
    // something this table never named.
    if (!Object.hasOwn(operations, request.op)) {
      throw new Error(`no operation named ${JSON.stringify(request.op)}`);
    }
    response = { ok: operations[request.op](request) };
  } catch (error) {
    response = { error: error.message };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}
