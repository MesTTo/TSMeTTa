/**
 * Purpose: select the swipl-wasm factory for the executing host.
 * Guarantees: both imports are statically visible to the browser bundler.
 *   [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 */
import { CapabilityError } from "./errors.ts";
import type { Swipl } from "./engine.ts";

/** Instantiate the wasm factory belonging to the executing host. */
export async function loadSWIPL(options: Record<string, unknown>): Promise<Swipl> {
  const node = typeof process !== "undefined" && typeof process.versions?.node === "string";
  const module = node
    ? await import("swipl-wasm/dist/swipl-node.js")
    : await import("swipl-wasm/dist/swipl/swipl-web.js");
  if (typeof module.default !== "function") {
    throw new CapabilityError(
      "swipl-wasm did not expose its factory: the web build is CommonJS; use " +
      "tsmetta's browser bundle or a bundler with CommonJS conversion",
    );
  }
  return await module.default(options) as Swipl;
}
