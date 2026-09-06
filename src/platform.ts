/**
 * Purpose: locate and mount this package's runtime on a Node host.
 * Assumes: bridge.pl identifies the package root; engine/metta.pl identifies
 *   the runtime root [source: extensions/node/src/platform.ts:findPackageRoot, prepareRuntime;
 *   commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8].
 * Guarantees: an enclosing checkout is read in preference to the `_runtime/`
 *   copy packed beside this package, so the engine a developer edits is the
 *   engine this seat runs even after `npm install` has written that copy
 *   [tested: extensions/node/check.sh node-dist, which asserts a packed
 *   package resolves its own `_runtime/`; commit=c478620e8c8a6690212528c64c30012ab69acfa3].
 * Owns resources: synchronous reads close their file descriptors before
 *   returning; the caller owns the destination WebAssembly filesystem.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EngineError, SourceNotFoundError } from "./errors.ts";

/** The filesystem operations required to install a runtime. */
export interface RuntimeFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
}

/** Validated runtime sources and the optional browser asset resolver. */
export interface PreparedRuntime {
  mount(fs: RuntimeFS): void;
  options?: Record<string, unknown>;
}

function findPackageRoot(from: string): string {
  let at = from;
  for (;;) {
    if (existsSync(join(at, "bridge.pl")) && existsSync(join(at, "package.json"))) return at;
    const up = dirname(at);
    if (up === at) {
      throw new EngineError(
        `this package's own bridge.pl is not above ${from}; the binding cannot ` +
          `find the engine tree it mounts`,
      );
    }
    at = up;
  }
}

/** The package containing bridge.pl and package.json. */
export const packageRoot: string = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
const bundled = join(packageRoot, "_runtime");
const enclosing = resolve(packageRoot, "..", "..");
/**
 * The checkout enclosing this package, or the runtime it was packed with.
 *
 * The CHECKOUT first. `_runtime/` is a copy of `engine/` and `lib/` taken when
 * the package was prepared, and it is the answer only where there is no
 * enclosing tree to read: an installed package resolves two levels up to the
 * consumer's own project, which is not a checkout, and falls through to its
 * copy. Reading it the other way round made the copy shadow the tree it was
 * taken from, so an engine edit was invisible to this seat's own suite from
 * the moment anything wrote `_runtime/` -- which is now every `npm install` of
 * this package, since preparing one is what a consumer installing the
 * DIRECTORY depends on.
 */
export const repoRoot: string = existsSync(join(enclosing, "engine", "metta.pl"))
  ? enclosing
  : bundled;

/**
 * Forget a prepared root, or every one of them.
 *
 * Nothing to forget on this host: a Node boot re-checks the checkout and reads
 * every source from disk as it mounts, so there is no prepared state between
 * two boots. The door exists because the browser has one and the two platform
 * modules are the same module to everything above them.
 */
export function forgetRuntime(_root?: string): void {
  // Deliberately empty; see above.
}

/** Resolve the host path accepted by loadFile and libraryPath. */
export function resolvePath(path: string): string {
  if (path.startsWith("/")) return path;
  return `${process.cwd()}/${path}`.replace(/\/\.\//g, "/");
}

/** Whether a host path names an existing directory. */
export function isDirectory(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

/** Read UTF-8 source text from the host filesystem. */
export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

/** Copy a host directory into the caller's WebAssembly filesystem. */
export function mountInto(
  fs: RuntimeFS,
  hostDir: string,
  virtualDir: string,
  keep?: (name: string) => boolean,
): void {
  let entries: string[];
  try {
    entries = readdirSync(hostDir);
  } catch (error) {
    throw new SourceNotFoundError(`${hostDir} is not a directory this host can read`, {
      cause: error,
    });
  }
  fs.mkdirTree(virtualDir);
  for (const name of entries) {
    const hostPath = join(hostDir, name);
    const virtualPath = `${virtualDir}/${name}`;
    if (statSync(hostPath).isDirectory()) {
      mountInto(fs, hostPath, virtualPath, keep);
    } else if (keep === undefined || keep(name)) {
      fs.writeFile(virtualPath, readFileSync(hostPath));
    }
  }
}

/** Read the package version without booting an engine. */
export function runtimeVersion(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

/** Check the checkout before allocating a WebAssembly instance. */
export async function prepareRuntime(root: string): Promise<PreparedRuntime> {
  if (!existsSync(join(root, "engine", "metta.pl"))) {
    throw new SourceNotFoundError(
      `${root} is not a MeTTa Kernel checkout: ${join(root, "engine", "metta.pl")} is not ` +
        `there. boot({ root }) wants the tree the engine lives in, and this package's own ` +
        `is ${repoRoot}.`,
    );
  }
  return {
    mount(fs): void {
      const source = (name: string): boolean => !name.endsWith(".qlf") && name !== ".qlf-stamp";
      for (const directory of ["engine", "lib"]) {
        mountInto(fs, join(root, directory), `/metta/${directory}`, source);
      }
      // Extension metadata is sufficient; native libraries cannot load in wasm.
      const controls = join(root, "extensions");
      if (existsSync(controls)) {
        for (const seat of readdirSync(controls)) {
          const control = join(controls, seat, "extension.pl");
          if (!existsSync(control)) continue;
          fs.mkdirTree(`/metta/extensions/${seat}`);
          fs.writeFile(`/metta/extensions/${seat}/extension.pl`, readFileSync(control));
        }
      }
      fs.writeFile("/metta/bridge.pl", readFileSync(join(packageRoot, "bridge.pl")));
    },
  };
}
