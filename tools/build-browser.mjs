/**
 * Purpose: bundle the shared public surface with the browser source loader.
 * Guarantees: Node imports in swipl-wasm's inactive branches never reach the
 *   consumer's resolver. [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 */
import { build } from "esbuild";
import { readFileSync, rmSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// `./seam` joins them because it reads a package.json to answer what packages
// advertise, which is metta-node/integrate's own reason: a browser page has no
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
    __SWIPL_DATA_SIZE__: String(statSync(new URL(
      "./swipl-web.data", import.meta.resolve("swipl-wasm/dist/swipl/swipl-web.js"),
    )).size),
  },
  plugins: [{
    name: "browser-runtime",
    setup(build) {
      build.onResolve({ filter: /^\.\/platform\.ts$/ }, () => ({
        path: fileURLToPath(new URL("../src/platform-browser.ts", import.meta.url)),
      }));
      build.onResolve({ filter: /^swipl-wasm\/dist\/swipl-node\.js$/ }, () => ({
        path: "node-factory", namespace: "inactive-node",
      }));
      // swipl-wasm 8.0.6's web loader retains these Node-only branches.
      // Its own webpack recipe also excludes Node builtins for the web target.
      // https://github.com/SWI-Prolog/npm-swipl-wasm/blob/abae5e515658fa80a6f4a189b86b192b9ae02c7e/webpack.config.js
      build.onResolve({ filter: /^(node:)?(fs|crypto)$/ }, (args) => {
        if (!args.importer.includes("node_modules/swipl-wasm/")) return;
        return { path: args.path, namespace: "inactive-node" };
      });
      build.onLoad({ filter: /.*/, namespace: "inactive-node" }, (args) => ({
        contents: args.path === "node-factory" ? "export default undefined;" : "export default {};",
        loader: "js",
      }));
    },
  }],
});
