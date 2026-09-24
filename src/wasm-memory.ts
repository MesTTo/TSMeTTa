/**
 * Purpose: size the engine's WebAssembly memory and derive the stack ceiling
 *   the engine boots under: how far a module's memory may grow, read from its
 *   binary; the memory an instance exports; and the host started through
 *   Emscripten's instantiateWasm hook so that memory is in hand.
 * Assumes:
 *   - the host's loader takes a Module.instantiateWasm hook, calls it inside
 *     a `new Promise` executor and takes the instance through its callback
 *     [source: _host/swipl-web.cjs, createWasm; commit=f1beca184a5eb466b9357e130d1f6ef6451bf95e]
 *   - that loader grows a 32-bit memory to at most min(declared maximum,
 *     4 GiB - 64 KiB) [source: emscripten src/lib/libcore.js, $getHeapMax,
 *     "Stay one Wasm page short of 4GB"; _host/swipl-web.cjs reads
 *     getHeapMax=()=>4294901760; commit=f1beca184a5eb466b9357e130d1f6ef6451bf95e]
 *   - SWI keeps the global and local stacks in one realloc'd chunk and the
 *     trail and argument stacks in another, grows each to the next power of
 *     two, and refuses a growth that would take their sum past stack_limit
 *     [source: swipl-devel V10.1.14 src/pl-gc.c, nextStackSizeAbove and
 *     grow_stacks]
 * Guarantees:
 *   - memoryMaximum answers the declared maximum of the module's memory 0,
 *     imported or defined, in bytes, and all a 32-bit memory addresses when
 *     it declares none [tested: test/wasm-memory.test.ts, "reads the declared
 *     maximum of memory 0 whatever precedes it", "reads an imported memory
 *     first", "answers 4 GiB for a memory with no maximum"; commit=ded9bdafa220367d3148a45542dbf62d912ccfef]
 *   - bytes that are not a module, or a module whose memory 0 is 64-bit, are
 *     refused by name [tested: test/wasm-memory.test.ts, "refuses what it
 *     cannot size"; commit=ded9bdafa220367d3148a45542dbf62d912ccfef]
 *   - stackCeiling answers the largest L for which the memory holds what the
 *     engine used at boot plus 2L [tested: test/wasm-memory.test.ts, "leaves
 *     room for the stacks and what their growth left behind";
 *     commit=ded9bdafa220367d3148a45542dbf62d912ccfef]
 * Fails when: the engine's own data outgrows what it held at boot; the stacks
 *   then share the heap with it and malloc can refuse before the ceiling,
 *   which the host reports as resource_error(no_memory).
 * Open Obligations: None.
 */

import { EngineError } from "./errors.ts";

/** A WebAssembly page, the unit memory limits count in. */
const PAGE = 65_536;

/** The pages a 32-bit memory addresses, 4 GiB of them. */
const WASM32_PAGES = 65_536;

/**
 * The most a 32-bit memory grows to under an Emscripten loader: one page short
 * of 4 GiB, because a size of 4 GiB wraps to 0 in the 32-bit arithmetic the
 * heap-size code does [source: emscripten src/lib/libcore.js, $getHeapMax].
 * Fixed by the address width, not a guess, so it is a constant.
 */
const WASM32_GROWABLE = WASM32_PAGES * PAGE - PAGE;

/**
 * The bytes a module's memory 0 may grow to, as its binary declares.
 *
 * Reads section headers, the import section and the memory section, and skips
 * every other section by its size. An imported memory precedes the defined
 * ones in the index space, so a module that imports one is sized by it. The
 * layout is the WebAssembly binary format's: the magic and version, then
 * sections of an id byte and a size; limits are a flags byte, bit 0 set when a
 * maximum follows the minimum and bit 2 set for 64-bit indices, with both
 * bounds unsigned LEB128 [source: WebAssembly Core Specification 2.0,
 * sections 5.5.2, 5.5.5 and 5.5.8, and 5.3.4 for limits;
 * https://webassembly.github.io/spec/core/binary/modules.html].
 * Time: one step per section and per import entry. Space: constant.
 */
export function memoryMaximum(binary: Uint8Array): number {
  const refuse = (why: string): never => {
    throw new EngineError(`the engine's WebAssembly binary cannot be sized: ${why}`);
  };
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (binary.length < 8 || magic.some((byte, index) => binary[index] !== byte)) {
    refuse("it is not a version 1 WebAssembly module");
  }
  let at = 8;
  const byte = (): number => binary[at++] ?? refuse("it ends in the middle of a section");
  // An unsigned LEB128 of at most 32 bits: five bytes at most.
  const u32 = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const next = byte();
      value += (next & 0x7f) * 2 ** shift;
      if ((next & 0x80) === 0) return value;
    }
    return refuse("a number runs past five bytes");
  };
  // Limits, answering the maximum in pages or undefined when none is declared.
  const limits = (): number | undefined => {
    const flags = u32();
    u32();
    return (flags & 1) !== 0 ? u32() : undefined;
  };
  const memory = (): number => {
    const flags = binary[at];
    if (flags !== undefined && (flags & 4) !== 0) refuse("its memory has 64-bit indices");
    return (limits() ?? WASM32_PAGES) * PAGE;
  };
  while (at < binary.length) {
    const id = byte();
    const size = u32();
    const end = at + size;
    if (id === 2) {
      for (let count = u32(); count > 0; count -= 1) {
        // A name is its length and then its bytes. The length is read into a
        // name of its own because `at += u32()` reads `at` BEFORE u32()
        // advances it past the length, which lands on the length's bytes.
        const moduleName = u32();
        at += moduleName;
        const fieldName = u32();
        at += fieldName;
        const kind = byte();
        if (kind === 0x02) return memory();
        if (kind === 0x00) u32(); // a function's type index
        else if (kind === 0x01) {
          byte(); // the table's reference type
          limits();
        } else if (kind === 0x03) at += 2; // a global's value type and mutability
        else if (kind === 0x04) {
          byte(); // a tag's attribute
          u32();
        } else refuse(`import kind ${String(kind)} is not one the format defines`);
      }
    } else if (id === 5 && u32() > 0) {
      return memory();
    }
    at = end;
  }
  return refuse("it declares no memory");
}

/**
 * The stack ceiling a memory holds: the largest L with used + 2L within what
 * the memory can grow to.
 *
 * The stacks grow in two chunks by doubling, and the heap never gives memory
 * back to the module, so a chunk that reached S has left blocks of S/2, S/4
 * and so on behind, less than S in all, which a larger chunk cannot reuse; the
 * last growth also holds the old chunk and the new one at once. Stacks at the
 * ceiling L therefore need less than 2L beyond what the engine held at boot,
 * and SWI's own stack-overflow error, which this seat raises as a
 * StackLimitError naming the ceiling, comes before the heap runs out.
 *
 * `maximum` is what the binary declares and `used` the memory's size once the
 * engine and the bridge have loaded; both in bytes.
 * Time and space: constant.
 */
export function stackCeiling(maximum: number, used: number): number {
  const growable = Math.min(maximum, WASM32_GROWABLE);
  if (used >= growable) {
    throw new EngineError(
      `the engine's WebAssembly memory can grow to ${String(growable)} bytes and boot ` +
        `already holds ${String(used)}, which leaves nothing for its stacks`,
    );
  }
  return Math.floor((growable - used) / 2);
}

/** The memory a host instance exports, found by what it is: its name is minified. */
export function exportedMemory(instance: WebAssembly.Instance): WebAssembly.Memory {
  for (const value of Object.values(instance.exports)) {
    if (value instanceof WebAssembly.Memory) return value;
  }
  throw new EngineError("the engine's WebAssembly instance exports no memory, so it cannot be sized");
}

/** A host started from a compiled module, with the memory its instance exports. */
export interface StartedHost<T> {
  readonly swipl: T;
  readonly memory: WebAssembly.Memory;
}

/**
 * Start a host through the loader's instantiateWasm hook over a compiled
 * module, keeping the memory the instance exports.
 *
 * The hook is SYNCHRONOUS because the loader calls it inside a `new Promise`
 * executor whose only resolution is its callback: a throw from here rejects
 * the boot, where a rejected promise inside would leave the factory pending
 * forever [source: _host/swipl-web.cjs, createWasm]. Given the hook, the
 * loader neither fetches nor compiles the binary, so every engine after the
 * first pays for linking alone.
 */
export async function startHost<T>(
  factory: (options: Record<string, unknown>) => Promise<T>,
  module: WebAssembly.Module,
  options: Record<string, unknown>,
): Promise<StartedHost<T>> {
  let memory: WebAssembly.Memory | undefined;
  const swipl = await factory({
    ...options,
    instantiateWasm: (
      imports: WebAssembly.Imports,
      ready: (instance: WebAssembly.Instance) => void,
    ): Record<string, never> => {
      const instance = new WebAssembly.Instance(module, imports);
      memory = exportedMemory(instance);
      ready(instance);
      return {};
    },
  });
  if (memory === undefined) {
    throw new EngineError("the engine's loader started without instantiating through this host's hook");
  }
  return { swipl, memory };
}
