/**
 * Purpose: this seat's two remote ends as programs the OTHER seat can drive,
 *   so "either end interoperates with the Python seat's" is a run rather than
 *   a claim in a header.
 * Assumes:
 *   - argv is `serve`, `attach <url> [space]` or `refuses`, and a `serve` run
 *     reads the atoms it is to hold as one transport document on standard
 *     input. The space defaults to `&served`, which is what `serve` holds
 * Guarantees:
 *   - `serve` prints `{"listening": {"port": n}}` on one line before it serves,
 *     which is the handshake the reference server already uses
 *     [source: extensions/python/examples/integration/typescript_space/space_server.ts]
 *   - `attach` prints the atoms it read as one transport document, so the
 *     driving side compares wire terms rather than printed text
 *   - both ends read and write through {@link transportFromJson} and
 *     {@link transportToJson}, which is what the protocol's own bodies use
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import {
  atomFromWire,
  fromTransport,
  metta,
  toTransport,
  transportFromJson,
  transportToJson,
  wireFromAtom,
} from "../src/index.ts";
import { RemoteSpace, httpTransport, serve } from "../src/remote.ts";

const [mode, argument, named] = process.argv.slice(2);

if (mode === "serve") {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const held = transportFromJson(Buffer.concat(chunks).toString("utf8")) as {
    readonly atoms: readonly unknown[];
  };
  const m = await metta();
  const space = m.space("&served");
  space.add(...held.atoms.map((term) => atomFromWire(fromTransport(term))));
  const gateway = await serve({ spaces: [space], port: 0 });
  const port = Number(new URL(gateway.url).port);
  process.stdout.write(`${JSON.stringify({ listening: { port } })}\n`);
  // Held open until the driving side closes the process.
  await new Promise(() => undefined);
} else if (mode === "attach") {
  if (argument === undefined) throw new Error("attach needs a url");
  const space = new RemoteSpace(httpTransport(argument), { space: named ?? "&served" });
  const read: unknown[] = [];
  for await (const atom of space.atoms()) read.push(toTransport(wireFromAtom(atom)));
  process.stdout.write(`${transportToJson({ atoms: read })}\n`);
} else if (mode === "refuses") {
  // What this seat does when asked to put a non-finite float on the wire,
  // which is the one class JSON has no literal for.
  const refusals: Record<string, string> = {};
  for (const [name, value] of [
    ["inf", Number.POSITIVE_INFINITY],
    ["-inf", Number.NEGATIVE_INFINITY],
    ["nan", Number.NaN],
  ] as readonly [string, number][]) {
    try {
      transportToJson({ atom: toTransport(["n", value]) });
      refusals[name] = "ACCEPTED";
    } catch (error) {
      refusals[name] = error instanceof Error ? error.message : String(error);
    }
  }
  process.stdout.write(`${JSON.stringify(refusals)}\n`);
} else {
  throw new Error(`no mode named ${JSON.stringify(mode)}`);
}
