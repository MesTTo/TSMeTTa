/**
 * Purpose: declare the WebAssembly members this package's platforms compile
 *   and instantiate the host with, which a tsconfig whose `lib` is ES2023 with
 *   no DOM does not otherwise carry.
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
  function compile(bytes: ArrayBuffer | ArrayBufferView): Promise<Module>;
  function compileStreaming(source: ReturnType<typeof fetch>): Promise<Module>;
}
