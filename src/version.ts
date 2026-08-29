/**
 * Purpose: the version this package declares, read from its own manifest.
 * Assumes:
 *   - `package.json` sits beside `bridge.pl` at the package root, which is
 *     what `packageRoot` finds
 * Guarantees:
 *   - reading it starts no engine and mounts nothing, so `--version` answers
 *     on a machine where the engine cannot boot
 *     [tested: "answers its version and its usage without booting"]
 *   - the read happens once and is remembered, so a program that asks in a
 *     loop reads the file once
 * Open Obligations:
 *   To Do: None
 *   Hacks: None
 *   Future Enhancements: None
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "./engine.ts";

let held: string | undefined;

/** The version this package declares. */
export function version(): string {
  if (held !== undefined) return held;
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as { version?: string };
  held = manifest.version ?? "0.0.0";
  return held;
}
