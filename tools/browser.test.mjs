/**
 * Purpose: exercise the emitted browser package in Chromium over HTTP, and the
 *   documentation site's runnable fences on top of it.
 * Guarantees:
 *   - boot, wire answers, host callbacks, matching and evaluation status run in
 *     a page, with worker boot checked separately
 *     [tested: npm run test:browser; commit=04fde431963bd063ef4ab5dc9b579ff2faba9fe8]
 *   - the site's worker and its `MettaRun` component are driven in the LAYOUT
 *     the site serves them in, under a base that is not `/`, because the worker
 *     resolves the kit against its own URL and the component resolves the
 *     worker against the site's base, and both are wrong in a way a root-served
 *     fixture cannot show
 *     [tested: npm run test:browser --prefix extensions/node, "answers the site's fences through
 *     one worker", "runs a fence in a mounted component and prints its answer";
 *     commit=WORKTREE]
 * Assumes: the site's `public/metta/worker.js` and the component beside it are
 *   two directories up, and the website's own `vite`, `@vitejs/plugin-vue` and
 *   `vue` are installed, which is what compiles the component here. The
 *   component tests SKIP by name when they are not, the same way this file's
 *   subject skips when `browser/` has not been built.
 * Owns resources: closes Chromium and the HTTP server. It leaves `_runtime/`
 *   where the build put it: that directory is what an installed package mounts
 *   and what `prepare` makes, so removing it after a run left the checkout in
 *   the state a consumer install fails from.
 */
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const partialSource = await readFile(join(root, "../../examples/ch05-equations-and-evaluation/05-01-an-equation-is-a-rewrite/04-partialdef.metta"), "utf8");
let browser;
let server;
let origin;
let consumer;
let atomConsumer;

// --- the documentation site's runnable fences -------------------------------
// Served under a base that is not `/`, because that is the only shape in which
// the site's own two URL rules can be wrong: the worker resolves `./browser/`
// and `./_runtime/` against its own URL, and the component resolves the worker
// against Vite's `BASE_URL`.
const SITE = resolve(root, "..", "..", "website");
const SITE_MODULES = join(SITE, "node_modules");
const BASE = "/site/";
const IDENTITY = await readFile(
  join(root, "../../examples/ch05-equations-and-evaluation/05-01-an-equation-is-a-rewrite/01-identity.metta"),
  "utf8");
/** Whether the website's own toolchain is here to compile its component with. */
const siteToolchain = ["vite", "@vitejs/plugin-vue", "vue"]
  .every(name => existsSync(join(SITE_MODULES, name)));
const noToolchain = siteToolchain
  ? undefined
  : "run 'npm ci --prefix website'; the site's vite, @vitejs/plugin-vue and vue compile its component";
/** The compiled fixture's files, by the name the built HTML asks for. */
const fixture = new Map();
/** One mounted page per component test, by the path it is served at. */
const pages = new Map();

/**
 * Compile `MettaRun.vue` with the SITE's own toolchain, into memory.
 *
 * A virtual entry rather than a fixture directory: what is being tested is the
 * component and the worker, and an `index.html` plus a `main.js` checked in
 * beside this file would be two more things to keep true. Vite is what compiles
 * a `.vue` in this repository, so it is what compiles it here.
 */
async function compileFixture() {
  const { build: viteBuild } = await import(pathToFileURL(join(SITE_MODULES, "vite/dist/node/index.js")).href);
  const vue = (await import(pathToFileURL(join(SITE_MODULES, "@vitejs/plugin-vue/dist/index.mjs")).href)).default;
  const ENTRY = "metta-run-fixture";
  const source = `
    import { createApp, h } from "vue";
    import MettaRun from ${JSON.stringify(join(SITE, ".vitepress/theme/MettaRun.vue"))};
    const fence = document.querySelector("#fence");
    createApp({ render: () => h(MettaRun, {
      example: fence.dataset.example,
      source: fence.dataset.source,
      inferences: fence.dataset.inferences,
    }) }).mount("#app");
  `;
  const out = await viteBuild({
    root: SITE,
    base: BASE,
    configFile: false,
    logLevel: "warn",
    plugins: [
      { name: "fence-fixture",
        resolveId: id => (id === ENTRY ? `\0${ENTRY}` : null),
        load: id => (id === `\0${ENTRY}` ? source : null) },
      vue(),
    ],
    resolve: { alias: { vue: join(SITE_MODULES, "vue/dist/vue.runtime.esm-bundler.js") } },
    build: { write: false, minify: false, rollupOptions: { input: { fixture: ENTRY } } },
  });
  for (const emitted of (Array.isArray(out) ? out[0].output : out.output)) {
    fixture.set(emitted.fileName, emitted.code ?? emitted.source);
  }
}

/** The page a component test mounts, carrying one fence's own attributes. */
function fixturePage(example, source, inferences) {
  const script = [...fixture.keys()].find(name => name.endsWith(".js"));
  return `<!doctype html><title>fence</title>` +
    `<div id="fence" data-example="${example}" data-source="${encodeURIComponent(source)}" ` +
    `data-inferences="${String(inferences)}"></div><div id="app"></div>` +
    `<script type="module" src="${BASE}assets/${script}"></script>`;
}

/** Post one message to the site's worker and wait for its answer. */
const ASK = `
  // A listener per ask, matched on the message's own id and removed when it
  // answers, so two runs asked for AT ONCE can be told apart and the order they
  // come back in can be read. \`onmessage =\` cannot do that: the second ask
  // would replace the first ask's handler and the first would never settle.
  const ask = (worker, message) => new Promise((settle, fail) => {
    const hear = event => {
      // The worker sends one progress message per run before the program
      // starts; the ANSWER is the one that is not it.
      if (event.data.id !== message.id || event.data.ready === true) return;
      worker.removeEventListener("message", hear);
      settle(event.data);
    };
    worker.addEventListener("message", hear);
    worker.onerror = event => fail(new Error(event.message || "the worker stopped"));
    worker.postMessage(message);
  });
`;
const workerSource = `
import { metta } from '/browser/index.js';
try {
  const m = await metta({ root: new URL('/_runtime/', location.href).href });
  const result = m.run('!(+ 20 22)')[0].texts;
  m.dispose();
  postMessage({ result });
} catch (error) { postMessage({ error: String(error) }); }
`;

before(async () => {
  const bundled = await build({
    stdin: {
      contents: `import { metta, variable } from 'metta-node';
        import { alphaEqual } from 'metta-node/matching';
        export async function probe(root) {
          const m = await metta({root});
          try { return {same: alphaEqual(variable('x'), variable('y')), answer: m.run('!(+ 1 2)')[0].texts}; }
          finally { m.dispose(); }
        }`,
      resolveDir: root,
    },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  consumer = bundled.outputFiles[0].text;
  const atomsOnly = await build({
    stdin: {
      contents: `import { expr, sym, G, float } from 'metta-node/atom';
        import { MettaError } from 'metta-node/errors';
        export function probeAtoms() {
          const term = expr(sym('user'), G(42), float(1), G('ada'));
          const refusal = new MettaError('refused');
          return { text: term.text, code: refusal.code, caught: refusal instanceof Error };
        }`,
      resolveDir: root,
    },
    bundle: true, platform: 'browser', format: 'esm', write: false,
  });
  atomConsumer = atomsOnly.outputFiles[0].text;
  server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/' || path === '/empty/') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Browser engine verification</title><body>Browser engine verification</body>');
      return;
    }
    if (path === '/consumer.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(consumer);
      return;
    }
    if (path === '/atom-consumer.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(atomConsumer);
      return;
    }
    if (path === '/worker.js') {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(workerSource);
      return;
    }
    // The site's own layout, under a base: the worker and the kit beside it,
    // and the compiled component's chunks. `/site/metta/<x>` is where
    // scripts/bundle-browser.mjs puts the seat's `browser/` and `_runtime/`,
    // so the same relative URLs the site serves resolve here.
    if (path === BASE) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>site</title><body>site');
      return;
    }
    if (path === `${BASE}metta/worker.js`) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(await readFile(join(SITE, 'public/metta/worker.js')));
      return;
    }
    if (path.startsWith(`${BASE}assets/`)) {
      const held = fixture.get(path.slice(`${BASE}assets/`.length));
      if (held === undefined) { response.writeHead(404).end('missing fixture chunk'); return; }
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(held);
      return;
    }
    if (path.startsWith(`${BASE}fence/`)) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(pages.get(path) ?? '<!doctype html><title>no fence</title>');
      return;
    }
    const file = resolve(root, '.' + (path.startsWith(`${BASE}metta/`)
      ? path.slice(`${BASE}metta`.length)
      : path));
    if (!file.startsWith(root + '/')) { response.writeHead(403).end(); return; }
    try {
      const bytes = await readFile(file);
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
      response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
      response.end(bytes);
    } catch { response.writeHead(404).end('missing test asset'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
  if (siteToolchain) await compileFixture();
});

after(async () => {
  try { await browser?.close(); }
  finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('boots the shared surface in a browser and preserves the stronger APIs', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    const result = await page.evaluate(async (partialSource) => {
      const api = await import('/browser/index.js');
      const satellite = await import('/browser/matching.js');
      const wireSatellite = await import('/browser/wire.js');
      const { metta, S, V, G, alphaEqual, alphaCanonical, alphaKey, isGround,
        matchTerms, renameVariables, substitute, unifyTerms, version } = api;
      const m = await metta();
      try {
        m.op(function doubleBrowser(n) { return Number(n) * 2; });
        const x = V.x;
        const y = V.y;
        const pattern = S.pair(x, x);
        const renamed = renameVariables(pattern, () => 'y');
        const bindings = unifyTerms(pattern, S.pair(7, 7));
        const statuses = [S.superpose(api.expr(G(1), G(2))), S.empty(), S.unknownBrowser(1)]
          .map(term => m.evalStatus(term).map(row => [row.status, row.text]));
        const partial = m.run('!(* 2)')[0].answers[0];
        let hostPathError;
        try { m.loadFile('example.metta'); } catch (error) { hostPathError = error.code; }
        return {
          answer: m.run('!(+ 2 3)')[0].texts,
          callback: m.run('!(double-browser 21)')[0].texts,
          partial: partial.text,
          roundTrip: m.engine.roundTrip(partial) === partial,
          trace: m.trace(partialSource).some(event => event.term.text.includes('(partial * (2))')),
          statuses,
          matching: [alphaEqual(pattern, S.pair(y, y)), alphaKey(pattern) === alphaKey(renamed),
            alphaCanonical(pattern) === alphaCanonical(renamed), isGround(S.pair(7, 7)),
            matchTerms(pattern, S.pair(7, 7)) !== undefined,
            bindings !== undefined && substitute(pattern, bindings) === S.pair(7, 7)],
          version: version(),
          satelliteIdentity: satellite.alphaEqual(V.x, V.y) &&
            wireSatellite.atomFromWire(wireSatellite.wireFromAtom(partial)) === partial,
          hostPathError,
          nodeGlobal: typeof process,
          stderr: m.drainStderr(),
        };
      } finally { m.dispose(); }
    }, partialSource);
    assert.deepEqual(result.answer, ['5']);
    assert.deepEqual(result.callback, ['42']);
    assert.equal(result.partial, '(partial * (2))');
    assert.equal(result.roundTrip, true);
    assert.equal(result.trace, true);
    assert.deepEqual(result.statuses, [[['value', '1'], ['value', '2']], [['empty', 'none']], [['not-reducible', '(unknown-browser 1)']]]);
    assert.deepEqual(result.matching, [true, true, true, true, true, true]);
    assert.equal(result.version, manifest.version);
    assert.equal(result.satelliteIdentity, true);
    assert.equal(result.hostPathError, 'ERR_METTA_UNSUPPORTED');
    assert.equal(result.nodeGlobal, 'undefined');
    assert.deepEqual(result.stderr, []);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('boots in a module worker without window or Node globals', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(() => new Promise((resolve, reject) => {
      const worker = new Worker('/worker.js', { type: 'module' });
      worker.onmessage = event => { worker.terminate(); resolve(event.data); };
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
    }));
    assert.deepEqual(result, { result: ['42'] });
  } finally { await page.close(); }
});


test('builds atoms in a browser with no engine behind them', async () => {
  // The consumer bundled above imports `metta-node/atom` and
  // `metta-node/errors` by NAME, so what is exercised is the exports map's
  // `browser` key rather than a path this file happens to know. A page that
  // only builds terms must not pay for the engine, and the two ways it could
  // are both checked: the bundle cannot mention swipl-wasm or a node builtin,
  // and the page must fetch no engine asset while running it.
  assert.doesNotMatch(atomConsumer, /swipl-wasm/);
  assert.doesNotMatch(atomConsumer, /\bnode:[a-z]/);
  const page = await browser.newPage();
  const errors = [];
  const fetched = [];
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { probeAtoms } = await import('/atom-consumer.js');
      return { ...probeAtoms(), booted: typeof globalThis.SWIPL };
    });
    // `code` rather than `name`: the class sets its name from `new.target.name`
    // deliberately, so a bundler that renames the class renames that too, and
    // the code is what src/errors.ts pins as the stable identity.
    assert.deepEqual(result, {
      text: '(user 42 1.0 "ada")',
      code: 'ERR_METTA_ENGINE',
      caught: true,
      booted: 'undefined',
    });
    assert.deepEqual(errors, []);
    const engineAssets = fetched.filter(path => /wasm|_runtime|runtime\.json|swipl/.test(path));
    assert.deepEqual(engineAssets, [], 'the page fetched an engine asset');
  } finally { await page.close(); }
});

test('names a missing browser runtime before instantiating wasm', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta({ root: new URL('/empty/', location.href).href }); }
      catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_SOURCE');
    assert.match(result.message, /runtime\.json/);
  } finally { await page.close(); }
});

for (const asset of ['swipl-web.wasm', 'swipl-web.data']) {
  test(`names a missing ${asset} before instantiating wasm`, async () => {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    try {
      await page.route(`**/wasm/${asset}`, route => route.fulfill({ status: 404, body: 'missing asset' }));
      await page.goto(origin);
      const result = await page.evaluate(async () => {
        const { metta } = await import('/browser/index.js');
        try { await metta(); }
        catch (error) { return { code: error.code, message: error.message }; }
      });
      assert.equal(result.code, 'ERR_METTA_SOURCE');
      assert.ok(result.message.includes(asset), result.message);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test('rejects a successful HTTP response carrying the wrong data asset', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.data', route => route.fulfill({
      status: 200, contentType: 'text/html', body: '<html>wrong asset</html>',
    }));
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); }
      catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
    assert.match(result.message, /swipl-web.data.*bytes.*expects/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('rejects malformed runtime paths before mounting any source', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    for (const files of [
      [{path: '../outside.pl', text: ''}],
      [{path: 'bridge.pl', text: ''}, {path: 'bridge.pl', text: ''}],
      [{path: 'engine/a.pl', text: ''}, {path: 'engine/a.pl/b.pl', text: ''}],
      [{path: 'engine/a.pl/b.pl', text: ''}, {path: 'engine/a.pl', text: ''}],
      [],
    ]) {
      await page.route('**/runtime.json', route => route.fulfill({ json: {version: 1, files} }));
      const result = await page.evaluate(async () => {
        const { metta } = await import('/browser/index.js');
        try { await metta(); }
        catch (error) { return { code: error.code, message: error.message }; }
      });
      assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
      assert.match(result.message, /manifest/);
      await page.unroute('**/runtime.json');
    }
  } finally { await page.close(); }
});

/** Every request a page made for the runtime manifest or a wasm asset. */
const engineRequests = (fetched) => ({
  manifest: fetched.filter(path => path.endsWith('/runtime.json')).length,
  wasm: fetched.filter(path => path.endsWith('.wasm')).length,
  data: fetched.filter(path => path.endsWith('.data')).length,
});

test('prepares one root once however many engines boot on it', async () => {
  // Twelve boots were twelve fetches and twelve validations of a 3.3 MB
  // manifest, which a workspace booting per document pays every time.
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const said = [];
      for (let boots = 0; boots < 12; boots += 1) {
        const m = await metta();
        try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
      }
      return said;
    });
    assert.deepEqual(answers, Array.from({ length: 12 }, () => '42'));
    assert.deepEqual(engineRequests(fetched), { manifest: 1, wasm: 1, data: 1 });
  } finally { await page.close(); }
});

test('shares one preparation between concurrent boots', async () => {
  // The memo holds the PROMISE, so boots that start together wait on one
  // preparation. Holding the result instead would let twelve concurrent boots
  // miss and fetch twelve times, which is the case a worker pool hits first.
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const engines = await Promise.all([metta(), metta(), metta(), metta()]);
      try { return engines.map(m => m.run('!(+ 20 22)')[0].texts[0]); }
      finally { for (const m of engines) m.dispose(); }
    });
    assert.deepEqual(answers, ['42', '42', '42', '42']);
    assert.deepEqual(engineRequests(fetched), { manifest: 1, wasm: 1, data: 1 });
  } finally { await page.close(); }
});

test('asks again after a runtime it refused', async () => {
  // A refusal is not an answer. Remembering one would make the boot after a
  // transient failure repeat the failure with no request behind it.
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    await page.route('**/runtime.json', route => route.fulfill({ json: { version: 1, files: [] } }));
    const refused = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); return null; } catch (error) { return error.code; }
    });
    assert.equal(refused, 'ERR_METTA_ENGINE');
    await page.unroute('**/runtime.json');
    const answer = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return m.run('!(+ 20 22)')[0].texts[0]; } finally { m.dispose(); }
    });
    assert.equal(answer, '42');
  } finally { await page.close(); }
});

test('forgets a prepared root when asked to', async () => {
  const page = await browser.newPage();
  const fetched = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  try {
    await page.goto(origin);
    const answers = await page.evaluate(async () => {
      const { metta, forgetRuntime } = await import('/browser/index.js');
      const said = [];
      for (const forget of [false, true]) {
        const m = await metta();
        try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
        if (forget) forgetRuntime();
      }
      const m = await metta();
      try { said.push(m.run('!(+ 20 22)')[0].texts[0]); } finally { m.dispose(); }
      return said;
    });
    assert.deepEqual(answers, ['42', '42', '42']);
    assert.deepEqual(engineRequests(fetched), { manifest: 2, wasm: 2, data: 2 });
  } finally { await page.close(); }
});

test('compiles the engine from its URL so the browser can cache the compiled code', async () => {
  // Chrome's WebAssembly code cache keys on the resource URL and is populated
  // by the streaming calls alone, so bytes handed to the loader in memory are
  // recompiled on every page load [source: https://v8.dev/blog/wasm-code-caching].
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const seen = await page.evaluate(async () => {
      const counted = { compileStreaming: 0, compile: 0, instantiate: 0 };
      for (const name of Object.keys(counted)) {
        const original = WebAssembly[name].bind(WebAssembly);
        WebAssembly[name] = (...args) => { counted[name] += 1; return original(...args); };
      }
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return { ...counted, answer: m.run('!(+ 20 22)')[0].texts[0] }; }
      finally { m.dispose(); }
    });
    assert.deepEqual(seen, { compileStreaming: 1, compile: 0, instantiate: 0, answer: '42' });
  } finally { await page.close(); }
});

test('compiles the fetched bytes when the response cannot be streamed', async () => {
  // A server that answers the `.wasm` with any other Content-Type makes the
  // browser refuse to stream it. That costs the code cache and must not cost
  // the boot, so the fallback is a real path rather than a comment.
  const page = await browser.newPage();
  const bytes = await readFile(join(root, '_runtime', 'wasm', 'swipl-web.wasm'));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.wasm', route => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: bytes,
    }));
    const seen = await page.evaluate(async () => {
      const counted = { compileStreaming: 0, compile: 0 };
      for (const name of Object.keys(counted)) {
        const original = WebAssembly[name].bind(WebAssembly);
        WebAssembly[name] = (...args) => { counted[name] += 1; return original(...args); };
      }
      const { metta } = await import('/browser/index.js');
      const m = await metta();
      try { return { ...counted, answer: m.run('!(+ 20 22)')[0].texts[0] }; }
      finally { m.dispose(); }
    });
    assert.deepEqual(seen, { compileStreaming: 1, compile: 1, answer: '42' });
  } finally { await page.close(); }
});

test('names a wasm asset it cannot compile rather than aborting inside the loader', async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin);
    await page.route('**/wasm/swipl-web.wasm', route => route.fulfill({
      status: 200, contentType: 'application/wasm', body: Buffer.from('not a module'),
    }));
    const result = await page.evaluate(async () => {
      const { metta } = await import('/browser/index.js');
      try { await metta(); } catch (error) { return { code: error.code, message: error.message }; }
    });
    assert.equal(result.code, 'ERR_METTA_ENGINE', JSON.stringify(result));
    assert.match(result.message, /swipl-web\.wasm is not a WebAssembly module/);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('runs the documented browser example', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}/examples/browser.html`);
    await page.waitForFunction(() => document.querySelector('#result').textContent === '42');
    await page.fill('#source', '!(* 2)');
    await page.click('#run');
    assert.equal(await page.textContent('#result'), '(partial * (2))');
  } finally { await page.close(); }
});


test('a consumer bundler selects browser exports with shared satellite atoms', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin);
    const result = await page.evaluate(async () => {
      const { probe } = await import('/consumer.js');
      return probe(new URL('/_runtime/', location.href).href);
    });
    assert.deepEqual(result, { same: true, answer: ['3'] });
  } finally { await page.close(); }
});

// --- the documentation site's runnable fences -------------------------------

test("answers the site's fences through one worker", async () => {
  // Six messages on ONE worker, which is what a page with six fences on it
  // sends. What is being checked is the whole protocol at once: the answer
  // groups, the two costs kept apart, the engine paid for once, each fence
  // getting a space of its own, and the order two runs asked for together come
  // back in.
  const page = await browser.newPage();
  const fetched = [];
  const errors = [];
  page.on('request', request => fetched.push(new URL(request.url()).pathname));
  page.on('pageerror', error => errors.push(String(error)));
  try {
    await page.goto(origin + BASE);
    const { said, arrived } = await page.evaluate(async ({ base, identity, ask }) => {
      const worker = new Worker(`${base}metta/worker.js`, { type: 'module' });
      const run = new Function('worker', 'message', `${ask} return ask(worker, message);`);
      // The order answers ARRIVE in, which is not the order `Promise.all`
      // collects them in: that preserves its input order however they settle,
      // so reading it would have made the ordering check say nothing.
      const arrived = [];
      const note = answer => { arrived.push(answer.id); return answer; };
      try {
        const said = [
          await run(worker, { id: 1, source: identity, inferences: 1000000 }),
          await run(worker, { id: 2, source: identity, inferences: 1000000 }),
          await run(worker, { id: 3, source: '(= (only-here) 1)\n!(+ 20 22)', inferences: 1000000 }),
          await run(worker, { id: 4, source: '!(only-here)', inferences: 1000000 }),
          // Two asked for AT ONCE, not one after the other. The engine is
          // synchronous inside the worker, so what this reads is whether the
          // answers come back in the order the page asked for them: the second
          // is the cheaper program and would answer first if they raced.
          ...await Promise.all([
            run(worker, { id: 5, source: '(= (twice $n) (* 2 $n))\n!(twice 21)', inferences: 1000000 }).then(note),
            run(worker, { id: 6, source: '!(+ 2 2)', inferences: 1000000 }).then(note),
          ]),
        ];
        return { said, arrived };
      } finally { worker.terminate(); }
    }, { base: BASE, identity: IDENTITY, ask: ASK });
    assert.deepEqual(said.map(answer => answer.groups), [
      [['true']], [['true']], [['42']], [['(only-here)']], [['42']], [['4']],
    ], JSON.stringify(said));
    assert.deepEqual(arrived, [5, 6],
      'the worker answered two runs asked for at once out of the order it was asked in');
    // The fourth answers `(only-here)` unreduced because the third defined it
    // in a space of its own. Sharing one space would answer `1`, and running
    // the identity example twice in it would double its equation.
    assert.deepEqual(said.map(answer => answer.stderr), [[], [], [], [], [], []]);
    assert.ok(said[0].bootMs > 0, `bootMs ${String(said[0].bootMs)}`);
    // The boot is not counted into the run: the fence that pays for the engine
    // reports the program's own cost beside it, not the sum.
    assert.ok(said[0].ms < said[0].bootMs, `${String(said[0].ms)} ms run, ${String(said[0].bootMs)} ms boot`);
    assert.equal(said[1].bootMs, said[0].bootMs, 'the engine booted twice');
    // Printed, not only asserted: these two numbers are what the site's own
    // documentation states about what a first press costs, and a claim nobody
    // can reprint is a claim that goes stale quietly. Read them beside the
    // load: this box is shared.
    const load = await readFile('/proc/loadavg', 'utf8').then(text => text.split(' ')[0], () => 'unknown');
    console.log(`  boot ${said[0].bootMs.toFixed(0)} ms, identity ${said[0].ms.toFixed(1)} ms, ` +
      `second fence ${said[2].ms.toFixed(1)} ms, loadavg ${load}`);
    const asked = what => fetched.filter(path => path.endsWith(what)).length;
    assert.deepEqual([asked('runtime.json'), asked('.wasm'), asked('.data')], [1, 1, 1]);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('refuses a fence the browser has no seat or no budget for', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + BASE);
    const said = await page.evaluate(async ({ base, ask }) => {
      const worker = new Worker(`${base}metta/worker.js`, { type: 'module' });
      const run = new Function('worker', 'message', `${ask} return ask(worker, message);`);
      try {
        return [
          await run(worker, { id: 1, source: '!(py-atom "1 + 1")', inferences: 1000000 }),
          await run(worker, { id: 2, source: '(= (spin $n) (spin (+ $n 1)))\n!(spin 0)', inferences: 50000 }),
          await run(worker, { id: 3, source: '!(hyperpose ((+ 1 2)))', inferences: 1000000 }),
          await run(worker, { id: 4, source: '!(+ 20 22)', inferences: 1000000 }),
        ];
      } finally { worker.terminate(); }
    }, { base: BASE, ask: ASK });
    // The Python seat's doors are DECLARED by the standard library and
    // implemented by a seat this build has not got, so a call to one answers
    // itself: the refusal is what stops that reading as an answer.
    assert.equal(said[0].error?.code, 'ERR_METTA_UNSUPPORTED', JSON.stringify(said[0]));
    assert.match(said[0].error.message, /^py-atom is declared \(-> Atom %Undefined%\)/);
    // The fence's own budget, enforced by the engine and reported in its words.
    assert.equal(said[1].error?.code, 'ERR_METTA_INFERENCES', JSON.stringify(said[1]));
    assert.match(said[1].error.message, /50000 inference bound/);
    // A platform capability the engine itself names, with what its absence
    // costs, which needs nothing from this side at all.
    assert.equal(said[2].error?.code, 'ERR_METTA_CAPABILITY', JSON.stringify(said[2]));
    assert.match(said[2].error.message, /library\(thread\) is absent/);
    // And the engine is still usable after all three, which is what the check
    // after a refusal is for.
    assert.deepEqual(said[3].groups, [['42']]);
  } finally { await page.close(); }
});

test('names the runtime asset a fence could not boot without', async () => {
  const page = await browser.newPage();
  try {
    await page.route(`**${BASE}metta/_runtime/runtime.json`, route => route.fulfill({ status: 404, body: 'gone' }));
    await page.goto(origin + BASE);
    const said = await page.evaluate(async ({ base, ask }) => {
      const worker = new Worker(`${base}metta/worker.js`, { type: 'module' });
      const run = new Function('worker', 'message', `${ask} return ask(worker, message);`);
      try { return await run(worker, { id: 1, source: '!(+ 20 22)', inferences: 1000000 }); }
      finally { worker.terminate(); }
    }, { base: BASE, ask: ASK });
    assert.equal(said.error?.code, 'ERR_METTA_SOURCE', JSON.stringify(said));
    assert.match(said.error.message, /runtime\.json/);
  } finally { await page.close(); }
});

test('runs a fence in a mounted component and prints its answer', { skip: noToolchain }, async () => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  pages.set(`${BASE}fence/identity`, fixturePage('examples/identity.metta', IDENTITY, 1000000));
  try {
    await page.goto(`${origin}${BASE}fence/identity`);
    await page.waitForSelector('.metta-run-go');
    assert.equal(
      await page.getAttribute('.metta-run', 'data-example'),
      'examples/identity.metta',
      'the component did not record the example it runs',
    );
    await page.click('.metta-run-go');
    await page.waitForSelector('.metta-run-answers', { timeout: 120000 });
    assert.equal(await page.textContent('.metta-run-answers'), '1. true');
    assert.match(await page.textContent('.metta-run-state'), /ms, after a \d+ ms boot/);
    // Reset drops the worker, and the button comes back to its first wording.
    await page.click('.metta-run-clear');
    assert.equal(await page.locator('.metta-run-answers').count(), 0);
    assert.equal((await page.textContent('.metta-run-go')).trim(), 'Run');
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('clears a fence reset while its run was still going', { skip: noToolchain }, async () => {
  // Reset settles the run in flight with a refusal, and showing that refusal
  // would put one under a fence the reader has just cleared. The program never
  // finishes, so the only thing that ends this run is the reset.
  const page = await browser.newPage();
  const spin = '(= (spin $n) (spin (+ $n 1)))\n!(spin 0)\n';
  pages.set(`${BASE}fence/spin`, fixturePage('examples/spin.metta', spin, 4000000000));
  try {
    await page.goto(`${origin}${BASE}fence/spin`);
    await page.waitForSelector('.metta-run-go');
    await page.click('.metta-run-go');
    await page.waitForFunction(
      () => document.querySelector('.metta-run-state')?.textContent.includes('running'),
      undefined, { timeout: 120000 });
    await page.click('.metta-run-clear');
    await page.waitForFunction(
      () => document.querySelector('.metta-run-go')?.textContent.trim() === 'Run',
      undefined, { timeout: 30000 });
    assert.equal(await page.locator('.metta-run-refusal').count(), 0,
      'a reset fence showed the refusal its own reset produced');
    assert.equal(await page.locator('.metta-run-answers').count(), 0);
  } finally { await page.close(); }
});

test('names a worker it cannot start rather than waiting on it', { skip: noToolchain }, async () => {
  const page = await browser.newPage();
  pages.set(`${BASE}fence/broken`, fixturePage('examples/identity.metta', IDENTITY, 1000000));
  try {
    await page.route(`**${BASE}metta/worker.js`, route => route.fulfill({ status: 404, body: 'gone' }));
    await page.goto(`${origin}${BASE}fence/broken`);
    await page.waitForSelector('.metta-run-go');
    await page.click('.metta-run-go');
    await page.waitForSelector('.metta-run-refusal', { timeout: 60000 });
    const said = await page.textContent('.metta-run-refusal');
    assert.match(said, /ERR_METTA_TRANSPORT/);
    assert.match(said, /metta\/worker\.js/);
  } finally { await page.close(); }
});
