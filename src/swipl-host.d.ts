/**
 * Purpose: declare the WebAssembly members this package's platforms compile
 *   and instantiate the host with, and the memory they size, which a tsconfig
 *   whose `lib` is ES2023 with no DOM does not otherwise carry.
 */

declare namespace WebAssembly {
  interface Module {}
  interface Instance {
    readonly exports: Record<string, unknown>;
  }
  interface Imports {
    [module: string]: Record<string, unknown>;
  }
  var Instance: { new (module: Module, imports?: Imports): Instance };
  interface Memory {
    /** The memory's bytes; its length is the memory's current size. */
    readonly buffer: ArrayBuffer;
  }
  var Memory: { prototype: Memory; new (descriptor: { initial: number; maximum?: number }): Memory };
  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
  function compileStreaming(source: ReturnType<typeof fetch>): Promise<Module>;
}
