/**
 * Purpose: bundle the shared public surface with the browser source loader.
 * Guarantees: Node imports in the host loader's inactive branches never reach
 *   the consumer's resolver. [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 *   The bundle inlines the host's data size and its memory maximum, the latter
 *   read by src/wasm-memory.ts's own parser, bundled for this script, so the
 *   browser and Node platforms size one binary one way [tested: npm run
 *   test:browser, "boots under the ceiling the host's memory leaves";
 *   commit=ded9bdafa220367d3148a45542dbf62d912ccfef]
 */
import { build } from "esbuild";
import { readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// A streamed compilation never holds the binary's bytes, so the browser learns
// how far the host's memory may grow here, from the parser the Node platform
// reads the same binary with. This script runs without type stripping, so the
// parser is bundled for it rather than imported as TypeScript.
const sizer = await build({
  absWorkingDir: root,
  entryPoints: ["src/wasm-memory.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "neutral",
});
const { memoryMaximum } = await import(
  `data:text/javascript;base64,${Buffer.from(sizer.outputFiles[0].contents).toString("base64")}`
);
const memoryMaximumBytes = memoryMaximum(readFileSync(new URL("../_host/swipl-web.wasm", import.meta.url)));

// `./seam` joins them because it reads a package.json to answer what packages
// advertise, which is tsmetta/integrate's own reason: a browser page has no
// filesystem to read one from and no installed packages to discover.
const nodeOnly = new Set(["./remote", "./integrate", "./manifest", "./seam", "./testing"]);
const entryPoints = Object.fromEntries(Object.entries(manifest.exports)
  .filter(([name, target]) => typeof target === "object" && name !== "./browser" && !nodeOnly.has(name))
  .map(([name]) => [name === "." ? "index" : name.slice(2), `src/${name === "." ? "index" : name.slice(2)}.ts`]));
rmSync(new URL("../browser/", import.meta.url), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints,
  outdir: "browser",
  splitting: true,
  // Sibling chunks keep import.meta.url's ../_runtime/ default valid.
  chunkNames: "shared-[hash]",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  define: {
    __METTA_PACKAGE_VERSION__: JSON.stringify(manifest.version),
    __SWIPL_DATA_SIZE__: String(statSync(new URL("../_host/swipl-web.data", import.meta.url)).size),
    __SWIPL_MEMORY_MAXIMUM__: String(memoryMaximumBytes),
  },
  plugins: [{
    name: "browser-runtime",
    setup(build) {
      build.onResolve({ filter: /^\.\/platform\.ts$/ }, () => ({
        path: fileURLToPath(new URL("../src/platform-browser.ts", import.meta.url)),
      }));
      // The emscripten loader in _host/ requires modules only in its Node
      // branches, which a browser never takes: its web path reads globals, the
      // WebSocket constructor where Node's branch requires the ws package. So
      // everything the loader names by bare specifier resolves to an empty
      // module here. The rule is the importer rather than a list of names,
      // because a host build that links more of emscripten requires more:
      // build-4's OSSP UUID link brought the socket layer and two require("ws")
      // [source: _host/swipl-web.cjs at 4ab1b06, SOCKFS's createPeer and
      // listen]. npm-swipl-wasm's own webpack recipe excludes Node builtins for
      // the web target for the same reason.
      // https://github.com/SWI-Prolog/npm-swipl-wasm/blob/abae5e515658fa80a6f4a189b86b192b9ae02c7e/webpack.config.js
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!/[\\/]_host[\\/]swipl-web\.cjs$/.test(args.importer)) return;
        return { path: args.path, namespace: "inactive-node" };
      });
      build.onLoad({ filter: /.*/, namespace: "inactive-node" }, () => ({
        contents: "export default {};",
        loader: "js",
      }));
    },
  }],
});
