/**
 * Purpose: type the two factory entry points shipped by swipl-wasm 8.0.6.
 */
declare module "swipl-wasm/dist/swipl-node.js" {
  export default function init(options: Record<string, unknown>): Promise<unknown>;
}
declare module "swipl-wasm/dist/swipl/swipl-web.js" {
  export default function init(options: Record<string, unknown>): Promise<unknown>;
}
