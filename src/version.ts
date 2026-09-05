/**
 * Purpose: the version this package declares, read from its own manifest.
 * Assumes:
 *   - `package.json` sits beside `bridge.pl` at the package root, which is
 *     what `packageRoot` finds
 * Guarantees:
 *   - browser bundles carry the same manifest version
 *     [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
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

import { runtimeVersion } from "./platform.ts";

let held: string | undefined;

/** The version this package declares. */
export function version(): string {
  if (held !== undefined) return held;
  held = runtimeVersion();
  return held;
}
