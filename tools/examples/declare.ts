/**
 * Purpose: write a twin's DIVERGENCE declaration into its TypeScript source,
 *   replacing the one it has or removing it when the runs no longer differ,
 *   formatted as the corpus formats every program.
 * Assumes: a DIVERGENCE declaration is the twin's last statement, from a line
 *   `export const DIVERGENCE = {` to the closing `};` at the foot of the file,
 *   which is where this writer puts it; the corpus is formatted by Prettier
 *   under tools/examples/prettierrc.json, which tools/examples.mjs copies
 *   beside the compiled lane.
 * Guarantees:
 *   - declaring the divergence a twin already declares gives back its source
 *     unchanged, and declaring none removes the declaration and the blank line
 *     before it [tested 2026-09-26T17:54:50+10:00: tools/examples/lane.test.ts, "declares a divergence
 *     in the twin's own source"]
 *   - a declaration that is not the twin's last statement is refused, never
 *     cut around
 */
import { readFileSync } from "node:fs";
import { format } from "prettier";

import type { Divergence } from "./corpus.ts";

/** The line a declaration opens with. */
const OPENING = /^export const DIVERGENCE = \{$/m;

/**
 * The corpus's own Prettier configuration, which this seat keeps for it in
 * tools/examples/prettierrc.json and tools/examples.mjs copies beside the
 * compiled lane.
 */
const CONFIG = JSON.parse(
  readFileSync(new URL("./prettierrc.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** A twin's source with `divergence` declared at its foot, or with none when it is undefined. */
export async function declared(
  twin: string,
  source: string,
  divergence: Divergence | undefined,
): Promise<string> {
  const at = source.search(OPENING);
  let body = source;
  if (at !== -1) {
    const tail = source.slice(at);
    const closings = [...tail.matchAll(/^\};$/gm)];
    const last = closings.at(-1);
    if (closings.length !== 1 || last === undefined || tail.slice(last.index + 2).trim() !== "") {
      throw new Error(`${twin} declares DIVERGENCE somewhere other than its last statement`);
    }
    body = source.slice(0, at);
  }
  body = body.trimEnd() + "\n";
  if (divergence === undefined) return body;
  const written = {
    originalOnly: divergence.originalOnly,
    twinOnly: divergence.twinOnly,
    ...(divergence.volatile === undefined ? {} : { volatile: divergence.volatile }),
    reason: divergence.reason,
  };
  return format(`${body}\nexport const DIVERGENCE = ${JSON.stringify(written, null, 2)};\n`, {
    ...CONFIG,
    parser: "typescript",
  });
}
