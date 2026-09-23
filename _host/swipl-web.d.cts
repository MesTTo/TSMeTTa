/**
 * Purpose: type the factory in swipl-web.cjs, the emscripten loader of the
 *   patched WebAssembly SWI-Prolog this package carries, for the one import
 *   that names it (src/platform-browser.ts).
 */
declare function initSWIPL(options?: Record<string, unknown>): Promise<unknown>;
export = initSWIPL;
