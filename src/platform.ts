/**
 * Purpose: locate and mount this package's runtime on a Node host, and start
 *   the WebAssembly SWI-Prolog it carries.
 * Assumes: bridge.pl identifies the package root; engine/metta.pl identifies
 *   the runtime root [source: extensions/node/src/platform.ts:findPackageRoot, prepareRuntime;
 *   commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8].
 *   _host/ beside them holds swipl-web.cjs, swipl-web.wasm and
 *   swipl-web.data from one link of the patched host MesTTo/MeTTa's
 *   tools/wasm-host/build.sh produces [source: tools/wasm-host/build.sh
 *   vendor in MesTTo/MeTTa].
 * Guarantees: an enclosing checkout is read in preference to the `_runtime/`
 *   copy packed beside this package, so the engine a developer edits is the
 *   engine this seat runs even after `npm install` has written that copy
 *   [tested: extensions/node/check.sh node-dist, which asserts a packed
 *   package resolves the runtime copy packed beside it;
 *   commit=c478620e8c8a6690212528c64c30012ab69acfa3].
 *   mountInto copies what a host directory holds while it is read, skipping
 *   an entry that is gone by the time it is read, so the runtime's engine and
 *   library sources can be copied from a tree another process writes into
 *   [tested: "loads a file whose directory holds a link to nothing";
 *   commit=a151c899a11b3b8ffb405b23b67d1f2000ded4dd].
 *   The engine sees this host's file system at the paths it has here: every
 *   top-level directory but the engine's own is mounted through NODEFS at its
 *   own path, and its working directory is this process's, so a relative or
 *   absolute path resolves as it does for the native engine
 *   [tested: "resolves a relative path against this process's working
 *   directory, as the native engine does", "reads a host file written after
 *   boot and writes one the host reads", "boots in a working directory of /
 *   with no mount of its own", "names a Windows path by its drive's mount";
 *   commit=1369817ebd86d76661ac9f36c0e39b5b3bf75007].
 *   The engine's tmp_dir is a directory of its own, minted exclusively inside
 *   the one a native SWI-Prolog in this environment would choose, so the
 *   temporary names two engines mint never collide although every WebAssembly
 *   engine's process id is 42 [tested: "gives every engine a temporary
 *   directory of its own, and removes it when the engine is disposed";
 *   commit=609b2715276edf92ba47f9853c0a05a29221d787].
 *   The host binary is read, sized and compiled once per process, and every
 *   boot links an instance of its own from that module, whose memory the boot
 *   is handed [tested: test/wasm-memory.test.ts, "boots under the ceiling the
 *   host's memory leaves"; commit=ded9bdafa220367d3148a45542dbf62d912ccfef].
 * Fails when: the host carries no NODEFS, which a host built before the
 *   recipe at c68d1c9a3 does not; boot then refuses by name rather than show
 *   the engine none of the host's files.
 * Owns resources: synchronous reads close their file descriptors before
 *   returning; the caller owns the destination WebAssembly filesystem; every
 *   NODEFS mount lives exactly as long as the instance it is made in; and
 *   each engine's temporary directory, minted at boot, is removed with
 *   everything in it by Engine.dispose, or when the process exits for an
 *   engine nobody disposed. The compiled module lives as long as the process.
 * Decides: one compiled WebAssembly.Module is shared by every engine this
 *   process boots, as the browser platform shares one per root, because a
 *   Module is immutable and linking one costs nothing beside compiling 3.9 MB
 *   again.
 */

import {
  type Dirent,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Swipl } from "./engine.ts";
import { EngineError, SourceNotFoundError } from "./errors.ts";
import { memoryMaximum, startHost } from "./wasm-memory.ts";

/** The filesystem operations required to install a runtime. */
export interface RuntimeFS {
  mkdirTree(path: string): void;
  writeFile(path: string, data: Uint8Array | string): void;
}

/** A runtime filesystem that can also mount a host directory, emscripten's `FS`. */
export interface HostFS extends RuntimeFS {
  mount(type: unknown, options: { readonly root: string }, mountpoint: string): unknown;
  readonly filesystems: Readonly<Record<string, unknown>>;
}

/** A directory one engine owns: where the engine sees it, and its removal. */
export interface OwnedDirectory {
  /** The directory's engine path. */
  readonly path: string;
  /** Remove the directory and everything in it; a second call does nothing. */
  release(): void;
}

/** A host whose files the engine is shown, and where the engine starts in them. */
export interface HostView {
  /** Mount the host's files, once the engine's host check has passed. */
  mount(fs: HostFS): void;
  /** The engine's working directory: this process's. */
  readonly working: string;
  /**
   * Mint the engine's `tmp_dir`: a directory of its own inside the one a
   * native SWI-Prolog here writes temporary files to.
   */
  temporary(): OwnedDirectory;
}

/** The engine's WebAssembly module, compiled once, and how far its memory may grow. */
export interface CompiledHost {
  /** Immutable, so every boot links an instance of its own from it. */
  readonly module: WebAssembly.Module;
  /** The bytes the module's memory may grow to, as its binary declares. */
  readonly maximum: number;
}

/** Validated runtime sources, the compiled engine and the optional browser asset resolver. */
export interface PreparedRuntime {
  mount(fs: RuntimeFS): void;
  readonly engine: CompiledHost;
  options?: Record<string, unknown>;
  /** The host's files, on a host that has them to show. */
  host?: HostView;
}

/** A started host: the loader's module object, its memory, and how far that may grow. */
export interface LoadedHost {
  readonly swipl: Swipl;
  readonly memory: WebAssembly.Memory;
  readonly maximum: number;
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
 * The patched WebAssembly SWI-Prolog this package carries.
 *
 * SWI-Prolog's own npm build, swipl-wasm, carries fourteen of the defects the
 * engine's host-workaround patches fix, so the engine's boot check refuses it.
 * This one is compiled from the engine's pinned swipl-devel with every patch
 * applied, by npm-swipl-wasm's own recipe, and packs the declaration that
 * check reads into its home, /swipl.
 */
const hostDirectory: string = join(packageRoot, "_host");

type SwiplFactory = (options: Record<string, unknown>) => Promise<unknown>;

/**
 * The loader's factory, required once and kept.
 *
 * Running the factory reassigns the loader module's own exports to the LZ4
 * codec emscripten embeds in it (`if(typeof module!="undefined")
 * {module.exports=MiniLZ4}`, inside LZ4.init), so a second require of the same
 * file answers the codec rather than the factory [measured 2026-09-23: the
 * second boot in one process raised `factory is not a function`].
 * npm-swipl-wasm's own dist/swipl-node.js requires it once, at load, for the
 * same reason.
 */
let factory: SwiplFactory | undefined;

function requireFactory(): SwiplFactory {
  try {
    return createRequire(import.meta.url)(join(hostDirectory, "swipl-web.cjs")) as SwiplFactory;
  } catch (error) {
    throw new EngineError(
      `this package's WebAssembly SWI-Prolog is not in ${hostDirectory}; the binding ` +
        `boots the engine on that host and has no other`,
      { cause: error },
    );
  }
}

/**
 * The host binary, sized and compiled once per process.
 *
 * The PROMISE, so two boots that start together share one compilation, and a
 * refusal is dropped so the next boot asks again, as the browser platform's
 * prepared table does.
 */
let compiled: Promise<CompiledHost> | undefined;

function compiledHost(): Promise<CompiledHost> {
  if (compiled !== undefined) return compiled;
  const work = (async (): Promise<CompiledHost> => {
    const path = join(hostDirectory, "swipl-web.wasm");
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      throw new EngineError(
        `this package's WebAssembly SWI-Prolog binary is not at ${path}; the binding ` +
          `boots the engine on that host and has no other`,
        { cause: error },
      );
    }
    return { maximum: memoryMaximum(bytes), module: await WebAssembly.compile(bytes) };
  })();
  compiled = work;
  work.catch(() => {
    if (compiled === work) compiled = undefined;
  });
  return work;
}

/** Start the host this package carries from a prepared runtime, with the caller's module options. */
export async function loadSWIPL(
  runtime: PreparedRuntime,
  options: Record<string, unknown>,
): Promise<LoadedHost> {
  const start = (factory ??= requireFactory());
  const { swipl, memory } = await startHost(start, runtime.engine.module, {
    locateFile: (name: string): string => join(hostDirectory, name),
    ...runtime.options,
    ...options,
  });
  return { swipl: swipl as Swipl, memory, maximum: runtime.engine.maximum };
}

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

/**
 * A host path as the engine sees it.
 *
 * On a POSIX host every top-level directory is mounted at its own path, so a
 * path is itself. On Windows each drive root is mounted at `/<letter>`, so
 * `C:\\Users\\ada\\x.metta` is `/c/Users/ada/x.metta`
 * [source: pyodide src/templates/python_cli_entry.mjs at e4d3ae95,
 * windowsPathToUnix]. A path with no drive letter is left as it is there.
 */
export function enginePath(path: string, platform: string = process.platform): string {
  if (platform !== "win32") return path;
  const drive = /^([A-Za-z]):[\\/]/.exec(path);
  if (drive === null) return path;
  return `/${(drive[1] as string).toLowerCase()}${path.slice(2).replace(/[\\/]+/g, "/")}`;
}

/** The engine's path for a host path, resolved against this process's working directory. */
export function resolvePath(path: string): string {
  return enginePath(resolve(path));
}

/** The engine's path for a library directory on this host, or a refusal naming it. */
export function libraryDirectory(path: string): string {
  const full = resolve(path);
  if (!(existsSync(full) && statSync(full).isDirectory())) {
    throw new SourceNotFoundError(`a library path is a directory that exists, and ${full} is not`);
  }
  return enginePath(full);
}

/**
 * The engine's own top-level directories, which a host directory of the same
 * name must not shadow: emscripten's device and process trees, the SWI-Prolog
 * home this host preloads, and the runtime prepareRuntime mounts. Pyodide
 * leaves out `lib` as well, because its own library lives there; nothing of
 * this engine's does [source: pyodide src/templates/python_cli_entry.mjs at
 * e4d3ae95, dirsToMount].
 */
const ENGINE_OWNED = new Set(["dev", "proc", "swipl", "metta"]);

/**
 * The host directories the engine is shown, each with the path it has there.
 *
 * Every top-level directory of a POSIX host, so any absolute path resolves,
 * and a working directory of / needs no mount of its own, since everything
 * under it is one of these. A Windows host lists only the working drive at /,
 * so there the drive roots of the working directory and the temporary
 * directory are mounted, as Pyodide mounts the drives its paths name.
 */
function hostMounts(): { readonly root: string; readonly mountpoint: string }[] {
  if (process.platform === "win32") {
    const drives = new Set<string>();
    for (const path of [process.cwd(), temporaryDirectory()]) {
      const drive = /^([A-Za-z]):[\\/]/.exec(path);
      if (drive !== null) drives.add((drive[1] as string).toUpperCase());
    }
    return [...drives]
      .toSorted()
      .filter((drive) => isDirectory(`${drive}:\\`))
      .map((drive) => ({ root: `${drive}:\\`, mountpoint: `/${drive.toLowerCase()}` }));
  }
  return readdirSync("/")
    .filter((name) => !ENGINE_OWNED.has(name) && isDirectory(`/${name}`))
    .map((name) => ({ root: `/${name}`, mountpoint: `/${name}` }));
}

/** Whether a host path names a directory this process can stat. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where a native SWI-Prolog in this environment writes temporary files: TMP
 * on a POSIX host and TEMP on Windows, else /tmp [source: swipl-devel
 * src/os/pl-prologflag.c, setTmpDirPrologFlag, at V10.1.14]. Windows' own
 * default stands in for SWI's compiled one there.
 */
function temporaryDirectory(): string {
  const chosen = process.platform === "win32" ? process.env["TEMP"] : process.env["TMP"];
  if (chosen !== undefined && chosen !== "") return chosen;
  return process.platform === "win32" ? tmpdir() : "/tmp";
}

/**
 * The directories minted for engines this process booted and has not
 * released, removed when the process exits, so an engine nobody disposed
 * leaves nothing behind, as a native SWI-Prolog removes its temporary files
 * when it halts.
 */
const minted = new Set<string>();
process.once("exit", () => {
  for (const directory of minted) rmSync(directory, { recursive: true, force: true });
});

/**
 * A directory of the engine's own inside the host's temporary directory.
 *
 * SWI-Prolog makes a temporary name unique by its process id,
 * `<tmp_dir>/swipl_<base>_<pid>_<n>` with `n` counted per process [source:
 * swipl-devel src/os/pl-os.c, TemporaryFile, at V10.1.14], and a WebAssembly
 * engine's process id is always 42. Two engines sharing the host's directory
 * therefore mint the same names: two in one process both answered
 * `swipl_probe_42_1` to `tmp_file(probe, F)`, and `temp-dir!` refused
 * whichever came second [measured 2026-09-24 at d6ba786]. mkdtemp creates its
 * directory exclusively under a random name, which restores what a native
 * process id guarantees for every name the engine mints inside it.
 */
function mintTemporaryDirectory(): OwnedDirectory {
  const directory = mkdtempSync(join(temporaryDirectory(), "tsmetta-"));
  minted.add(directory);
  return {
    path: enginePath(directory),
    release(): void {
      if (minted.delete(directory)) rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * Show the engine this host's files, each at the path it has here.
 *
 * Refuses on a host with no NODEFS, which would otherwise show the engine
 * none of them and let every relative path fail as a missing file.
 */
function mountHostFiles(fs: HostFS): void {
  const nodefs = fs.filesystems["NODEFS"];
  if (nodefs === undefined) {
    throw new EngineError(
      "this package's WebAssembly SWI-Prolog carries no NODEFS, so the engine cannot see " +
        "this host's files; rebuild it from tools/wasm-host at c68d1c9a3 or later",
    );
  }
  for (const { root, mountpoint } of hostMounts()) {
    fs.mkdirTree(mountpoint);
    fs.mount(nodefs, { root }, mountpoint);
  }
}

/**
 * Mount a host directory at an engine path, live: what the host holds there
 * is what the engine reads, a file created after the mount included.
 *
 * Every host path is already in view at its own path, so mounting one there
 * changes nothing and is left alone; this door names a host directory at
 * another engine path.
 */
export function mountHost(fs: HostFS, hostDir: string, virtualDir: string): void {
  const host = resolve(hostDir);
  if (!isDirectory(host)) {
    throw new SourceNotFoundError(`${host} is not a directory this host can read`);
  }
  if (enginePath(host) === virtualDir) return;
  fs.mkdirTree(virtualDir);
  fs.mount(fs.filesystems["NODEFS"], { root: host }, virtualDir);
}

/** Read UTF-8 source text from the host filesystem. */
export function readTextFile(path: string): string {
  return readFileSync(path, "utf8");
}

/**
 * Copy a host directory into the caller's WebAssembly filesystem.
 *
 * The copy is of what the directory holds while it is read. An entry that is
 * gone by the time it is read, a file another process removed after the
 * listing or a symbolic link whose target is missing, has nothing to copy and
 * is skipped, as a tree walker skips ENOENT mid-walk; only the directory asked
 * for has to exist. The listing carries each entry's type, so a file `keep`
 * refuses is never opened and only a symbolic link is stat'ed, to follow it.
 * It copies the runtime's engine and library sources into /metta, leaving out
 * the native QLF images a live mount would show the engine.
 */
function mountInto(
  fs: RuntimeFS,
  hostDir: string,
  virtualDir: string,
  keep?: (name: string) => boolean,
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(hostDir, { withFileTypes: true });
  } catch (error) {
    throw new SourceNotFoundError(`${hostDir} is not a directory this host can read`, {
      cause: error,
    });
  }
  copyEntries(fs, hostDir, virtualDir, entries, keep);
}

function copyEntries(
  fs: RuntimeFS,
  hostDir: string,
  virtualDir: string,
  entries: readonly Dirent[],
  keep: ((name: string) => boolean) | undefined,
): void {
  fs.mkdirTree(virtualDir);
  for (const entry of entries) {
    const hostPath = join(hostDir, entry.name);
    const virtualPath = `${virtualDir}/${entry.name}`;
    const directory = entry.isSymbolicLink()
      ? present(() => statSync(hostPath).isDirectory())
      : entry.isDirectory();
    if (directory === true) {
      const inner = present(() => readdirSync(hostPath, { withFileTypes: true }));
      if (inner !== undefined) copyEntries(fs, hostPath, virtualPath, inner, keep);
    } else if (directory === false && (keep === undefined || keep(entry.name))) {
      const data = present(() => readFileSync(hostPath));
      if (data !== undefined) fs.writeFile(virtualPath, data);
    }
  }
}

/** A host read's result, or undefined when what it reads is no longer there. */
function present<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read the package version without booting an engine. */
export function runtimeVersion(): string {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version?: string;
  };
  return manifest.version ?? "0.0.0";
}

/** Check the checkout, and compile the host, before allocating a WebAssembly instance. */
export async function prepareRuntime(root: string): Promise<PreparedRuntime> {
  if (!existsSync(join(root, "engine", "metta.pl"))) {
    throw new SourceNotFoundError(
      `${root} is not a MeTTa checkout: ${join(root, "engine", "metta.pl")} is not ` +
        `there. boot({ root }) wants the tree the engine lives in, and this package's own ` +
        `is ${repoRoot}.`,
    );
  }
  const engine = await compiledHost();
  return {
    engine,
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
    host: {
      mount: mountHostFiles,
      working: enginePath(process.cwd()),
      temporary: mintTemporaryDirectory,
    },
  };
}
