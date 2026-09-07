/**
 * Purpose: fetch, validate and compile a browser runtime once per root, and
 *   hand every engine booting on that root a mount and a compiled module.
 * Assumes: tools/bundle-runtime.mjs emits runtime.json and wasm assets beside
 *   it [source: extensions/node/tools/bundle-runtime.mjs:collect; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8].
 * Guarantees:
 *   - source paths are validated before any file is mounted
 *     [source: extensions/node/src/platform-browser.ts:prepareRuntime; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 *   - one root is fetched, validated and compiled ONCE however many engines
 *     boot on it, and concurrent boots share the one preparation rather than
 *     racing to repeat it. Twelve boots were twelve fetches and twelve
 *     validations of a 3.3 MB manifest [tested: "prepares one root once
 *     however many engines boot on it", "shares one preparation between
 *     concurrent boots"; commit=c478620e8c8a6690212528c64c30012ab69acfa3]
 *   - a refusal is never remembered, so the boot after a failed one asks again
 *     [tested: "asks again after a runtime it refused"; commit=c478620e8c8a6690212528c64c30012ab69acfa3]
 *   - the engine module is compiled from its URL through
 *     WebAssembly.compileStreaming wherever the root is served over HTTP,
 *     which is the only compilation Chrome's code cache keys: it keys on the
 *     resource URL and has no key for bytes handed over in memory
 *     [source: https://v8.dev/blog/wasm-code-caching, "WebAssembly caching is
 *     only implemented for the streaming API calls"]. A second page load
 *     compiles 1 wasm function after streaming and 1062 from bytes, and boots
 *     in 785 ms against 1042
 *     [measured 2026-09-07: 1 wasm.Deserialize and 1 wasm.CompileLazy against
 *     0 and 1062 in Chromium's v8.wasm trace category;
 *     fixture=extensions/node/_runtime served over HTTP to one persistent
 *     Chromium profile, six page loads per arm, the module made hot with 4000
 *     directives so V8 reaches its caching threshold; commit=c478620e8c8a6690212528c64c30012ab69acfa3].
 *     A root that cannot be streamed, and a response the browser refuses to
 *     stream, fall back to compiling the fetched bytes [tested: "compiles the
 *     engine from its URL so the browser can cache the compiled code",
 *     "compiles the fetched bytes when the response cannot be streamed";
 *     commit=c478620e8c8a6690212528c64c30012ab69acfa3]
 * Owns resources: the prepared table holds one root's sources, data image and
 *   compiled module until forgetRuntime drops them; the engine owns the
 *   WebAssembly filesystem receiving the copy.
 * Decides: a compiled WebAssembly.Module is shared between engines and each
 *   boot gets its own Instance, because a Module is immutable and linking one
 *   costs nothing beside compiling 2.1 MB again.
 */

import { EngineError, SourceNotFoundError, UnsupportedError } from "./errors.ts";
import type { PreparedRuntime, RuntimeFS } from "./platform.ts";

declare const __METTA_PACKAGE_VERSION__: string;
declare const __SWIPL_DATA_SIZE__: number;

/** The browser distribution's package URL. */
export const packageRoot: string = new URL("../", import.meta.url).href;
/** The source and wasm assets emitted by the browser build. */
export const repoRoot: string = new URL("../_runtime/", import.meta.url).href;

/** Host filesystem paths have no browser counterpart. */
export function resolvePath(_path: string): string {
  throw new UnsupportedError(
    "loadFile and libraryPath read host filesystem paths and are unavailable in a browser; " +
      "use run or load for source text",
  );
}

/** Browser code cannot inspect a host directory. */
export function isDirectory(_path: string): boolean {
  throw new UnsupportedError("a browser cannot inspect a host filesystem directory");
}

/** A browser caller supplies source text to lint rather than a host path. */
export function readTextFile(_path: string): string {
  throw new UnsupportedError(
    "lintFile reads a host filesystem path and is unavailable in a browser; use lint for source text",
  );
}

/** Browser runtime sources are installed by prepareRuntime. */
export function mountInto(
  _fs: RuntimeFS,
  _hostDir: string,
  _virtualDir: string,
  _keep?: (name: string) => boolean,
): void {
  throw new UnsupportedError(
    "mount reads a host filesystem directory and is unavailable in a browser",
  );
}

/** The package version embedded by the browser build. */
export function runtimeVersion(): string {
  return __METTA_PACKAGE_VERSION__;
}

/** The directory URL a root names, with the trailing slash a base needs. */
function runtimeBase(root: string): URL {
  let base: URL;
  try {
    base = new URL(root, repoRoot);
  } catch (error) {
    throw new SourceNotFoundError(`browser runtime root is not a URL: ${root}`, { cause: error });
  }
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return base;
}

/**
 * Every root prepared in this realm, keyed by its resolved URL.
 *
 * The PROMISE rather than the result, so two boots that start together share
 * one preparation instead of racing to fetch the same 3.3 MB twice. This is
 * the request-coalescing shape a cache in front of a network read always
 * takes; a rejected entry is dropped so a refusal is never an answer.
 */
const prepared = new Map<string, Promise<PreparedRuntime>>();

/**
 * Forget a prepared root, or every one of them.
 *
 * The eviction door for a test that changes what a root serves, and for a page
 * that has replaced its runtime without a reload. A boot after this fetches,
 * validates and compiles again.
 */
export function forgetRuntime(root?: string): void {
  if (root === undefined) {
    prepared.clear();
    return;
  }
  try {
    prepared.delete(runtimeBase(root).href);
  } catch {
    // A root this module could not resolve was never prepared under any key.
  }
}

/**
 * Compile the engine module, preferring the compilation the browser can cache.
 *
 * `compileStreaming` is the only path Chrome's WebAssembly code cache keys,
 * because the key is the resource URL: bytes handed over in memory have no key
 * and are recompiled on every page load
 * [source: https://v8.dev/blog/wasm-code-caching]. The fallback is not
 * theoretical -- a `file:` root cannot be fetched as a stream, a bundler may
 * inline the asset, and a server that answers the `.wasm` with any
 * `Content-Type` but `application/wasm` makes the browser refuse to stream it.
 */
async function compileEngine(url: URL): Promise<WebAssembly.Module> {
  if (url.protocol === "http:" || url.protocol === "https:") {
    try {
      return await WebAssembly.compileStreaming(fetch(url));
    } catch {
      // Either the asset is not there, which the fetch below reports by name,
      // or the response cannot be streamed, which costs the cache and not the
      // boot.
    }
  }
  let bytes: ArrayBuffer;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
    bytes = await response.arrayBuffer();
  } catch (error) {
    throw new SourceNotFoundError(`browser runtime asset could not be read at ${url.href}`, {
      cause: error,
    });
  }
  try {
    return await WebAssembly.compile(bytes);
  } catch (error) {
    throw new EngineError(
      `browser runtime asset ${url.href} is not a WebAssembly module this engine can compile`,
      { cause: error },
    );
  }
}

/** Fetch and validate all sources before allocating the wasm engine. */
export async function prepareRuntime(root: string): Promise<PreparedRuntime> {
  const base = runtimeBase(root);
  const key = base.href;
  const held = prepared.get(key);
  if (held !== undefined) return await held;
  const work = prepareBase(base);
  prepared.set(key, work);
  work.catch(() => {
    if (prepared.get(key) === work) prepared.delete(key);
  });
  return await work;
}

async function prepareBase(base: URL): Promise<PreparedRuntime> {
  const url = new URL("runtime.json", base);
  let raw: unknown;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
    }
    raw = await response.json();
  } catch (error) {
    throw new SourceNotFoundError(
      `browser runtime manifest could not be read at ${url.href}; serve the _runtime ` +
        "directory generated by the browser build",
      { cause: error },
    );
  }
  if (typeof raw !== "object" || raw === null ||
      !("version" in raw) || raw.version !== 1 ||
      !("files" in raw) || !Array.isArray(raw.files)) {
    throw new EngineError(`browser runtime manifest at ${url.href} has an invalid format`);
  }
  const files: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const entry of raw.files as unknown[]) {
    if (typeof entry !== "object" || entry === null ||
        !("path" in entry) || typeof entry.path !== "string" ||
        !("text" in entry) || typeof entry.text !== "string") {
      throw new EngineError(`browser runtime manifest at ${url.href} has an invalid source entry`);
    }
    const path = entry.path;
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..") ||
        /[\\\u0000-\u001f\u007f]/.test(path) || seen.has(path) ||
        !/^(?:bridge\.pl|(?:engine|lib)\/.+\.(?:pl|metta)|extensions\/[^/]+\/extension\.pl)$/.test(path)) {
      throw new EngineError(`browser runtime manifest has an invalid or duplicate source path: ${path}`);
    }
    seen.add(path);
    files.push({ path, text: entry.text });
  }
  for (const { path } of files) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (seen.has(parent)) {
        throw new EngineError(`browser runtime manifest source is also used as a directory: ${parent}`);
      }
    }
  }
  for (const required of ["engine/metta.pl", "engine/prelude.pl", "lib/lib_builtin_types/lib_builtin_types.metta", "bridge.pl"]) {
    if (!seen.has(required)) {
      throw new EngineError(`browser runtime manifest is missing ${required}`);
    }
  }
  // Compile and fetch here: the generated loader's async preRun data download
  // otherwise leaves its factory pending when the request fails, and a module
  // compiled here is one this function can refuse by name. Emscripten exposes
  // both injection hooks through swipl-wasm's factory configuration.
  // https://cdn.jsdelivr.net/npm/swipl-wasm@8.0.6/dist/swipl/swipl-web.js
  const dataUrl = new URL("wasm/swipl-web.data", base);
  const [module, data] = await Promise.all([
    compileEngine(new URL("wasm/swipl-web.wasm", base)),
    (async (): Promise<ArrayBuffer> => {
      try {
        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`);
        return await response.arrayBuffer();
      } catch (error) {
        throw new SourceNotFoundError(`browser runtime asset could not be read at ${dataUrl.href}`,
          { cause: error });
      }
    })(),
  ]);
  // Validate before invoking the loader: even its preload hook runs inside an
  // unawaited async function. The build records the colocated data file size.
  if (data.byteLength !== __SWIPL_DATA_SIZE__) {
    throw new EngineError(
      `browser runtime asset swipl-web.data has ${String(data.byteLength)} bytes; ` +
        `the wasm loader expects ${String(__SWIPL_DATA_SIZE__)}`,
    );
  }
  return {
    mount(fs): void {
      for (const file of files) {
        const path = `/metta/${file.path}`;
        fs.mkdirTree(path.slice(0, path.lastIndexOf("/")));
        fs.writeFile(path, file.text);
      }
    },
    options: {
      locateFile: (name: string): string => new URL(`wasm/${name}`, base).href,
      // The loader's own hook, and the reason the module above is compiled
      // rather than handed over as bytes: given this, it never fetches the
      // binary and never compiles it, so each engine after the first pays for
      // linking alone. SYNCHRONOUS, because the loader calls the hook inside a
      // `new Promise` executor whose only resolution is this callback: a throw
      // from here rejects the boot, where a rejected promise inside would
      // leave the factory pending forever
      // [source: node_modules/swipl-wasm/dist/swipl/swipl-web.js, createWasm].
      instantiateWasm: (
        imports: WebAssembly.Imports,
        ready: (instance: WebAssembly.Instance) => void,
      ): Record<string, never> => {
        ready(new WebAssembly.Instance(module, imports));
        return {};
      },
      getPreloadedPackage: (): ArrayBuffer => data,
    },
  };
}
