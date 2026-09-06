/**
 * Purpose: type the two factory entry points shipped by swipl-wasm 8.0.6, and
 *   the WebAssembly members this package compiles and instantiates with.
 */

// swipl-wasm's own `@types/emscripten` declares `namespace WebAssembly` with
// one empty `Module` interface in it, "for compatibility with older versions
// of Typescript". That declaration WINS for a tsconfig whose `lib` is ES2023
// with no DOM and no WebWorker, so the global is a namespace carrying nothing
// this file's platform needs. These merge the rest of it in, and no more than
// this package uses.
declare namespace WebAssembly {
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

declare module "swipl-wasm/dist/swipl-node.js" {
  export default function init(options: Record<string, unknown>): Promise<unknown>;
}
declare module "swipl-wasm/dist/swipl/swipl-web.js" {
  export default function init(options: Record<string, unknown>): Promise<unknown>;
}
